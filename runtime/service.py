#!/usr/bin/env python3
"""Opt-in single-host supervisor, two execution lanes and independent maintenance."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import uuid
from runtime.ledger import Ledger, alive, identity
from runtime.queue import Queue

ROOT=Path(__file__).resolve().parent.parent
LANES=('agent','command','maintenance')
STOP=False

def stopping(*_):
    global STOP
    STOP=True

def write(file, value):
    temp=file.with_name(file.name+'.'+uuid.uuid4().hex)
    with open(temp,'x') as stream:
        os.chmod(temp,0o600);json.dump(value,stream);stream.flush();os.fsync(stream.fileno())
    os.replace(temp,file)
    fd=os.open(file.parent,os.O_RDONLY)
    try:os.fsync(fd)
    finally:os.close(fd)

def read(file):
    fd=os.open(file,os.O_RDONLY|os.O_NOFOLLOW)
    with os.fdopen(fd) as stream:
        st=os.fstat(stream.fileno())
        if st.st_uid!=os.getuid() or st.st_mode&0o777!=0o600 or st.st_size>8*1024*1024:raise RuntimeError('unsafe private file')
        return json.load(stream)

def legacy():
    found=[]
    for p in Path('/proc').glob('[0-9]*'):
        try:
            args=(p/'cmdline').read_bytes().split(b'\0')
            if any(a.endswith(b'/supabase-worker.js') or a.endswith(b'/supabase-launcher.py') for a in args):found.append(int(p.name))
        except OSError:pass
    return found

def resources(task):
    if task.get('execution_mode')=='command':
        action=(task.get('command_payload') or {}).get('action')
        if action in ('apk103.download','apk103.validate'):return ['artifact:apk103']
        if action:return ['device:adb','artifact:apk103']
    # Agents can run arbitrary permitted tools: conservatively reserve ALL vehicle access.
    return ['workspace:'+str(ROOT.resolve()),'device:adb','artifact:apk103']

def queue():
    cfg=json.loads((ROOT/'remote-config.json').read_text())
    key=os.environ.get('CODEX_SUPABASE_SERVICE_ROLE_KEY')
    if not key:
        file=Path.home()/'.config/codex-bridge/supabase-service-role.key'
        fd=os.open(file,os.O_RDONLY|os.O_NOFOLLOW)
        with os.fdopen(fd) as f:
            st=os.fstat(f.fileno())
            if st.st_uid!=os.getuid() or st.st_mode&0o777!=0o600:raise RuntimeError('unsafe credential')
            key=f.read().strip()
    os.environ['CODEX_SUPABASE_SERVICE_ROLE_KEY']=key
    return Queue(os.environ.get('CODEX_SUPABASE_URL') or cfg['supabase']['url'],key)

def spawn_executor(folder,mode):
    env=os.environ.copy();env['CODEX_BRIDGE_RUNTIME_CHILD']='1'
    log=open(folder/'executor.log','ab',buffering=0)
    try:return subprocess.Popen(['node',str(ROOT/'runtime/execute.cjs'),mode,str(folder)],cwd=ROOT,env=env,stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
    finally:log.close()

def settle(ledger,attempt):
    folder=ledger.root/attempt['id']
    if attempt['owner'] and alive(json.loads(attempt['owner'])):return False
    done=folder/'done.json'
    if done.exists():
        data=read(done)
        if data.get('published') is True and data.get('released') is True:
            ledger.transition(attempt['id'],attempt['fence'],'completed',release=True);return True
    if attempt['state']!='uncertain':ledger.transition(attempt['id'],attempt['fence'],'uncertain')
    return False

def work(lane,root):
    ledger=Ledger(root);api=queue()
    while not STOP:
        ledger.beat(lane,'idle')
        if ledger.draining(lane):ledger.beat(lane,'drained');time.sleep(1);continue
        try:
            if legacy():raise RuntimeError('legacy runtime detected')
            for task in api.candidates(lane):
                # Never remove/archive a legacy fence to create capacity.
                if (ROOT/'.bridge-workspace-lock').exists() and any(r.startswith('workspace:') for r in resources(task)):continue
                task_id=str(uuid.UUID(task['id']));fence=ledger.reserve(task_id,lane,resources(task))
                if not fence:continue
                ledger.beat(lane,'busy')
                folder=ledger.root/task_id;folder.mkdir(mode=0o700)
                try:
                    claimed=api.claim(task)
                    if not claimed:ledger.transition(task_id,fence,'not_claimed',release=True);continue
                    write(folder/'task.json',claimed)
                    ledger.transition(task_id,fence,'executing') # durable BEFORE any process can have effects
                    child=spawn_executor(folder,'execute')
                    ledger.transition(task_id,fence,'executing',identity(child.pid))
                    while child.poll() is None:
                        ledger.beat(lane,'busy');time.sleep(1)
                        # Draining NEVER sends a signal to an active executor.
                    attempt=next(a for a in ledger.active() if a['id']==task_id)
                    settle(ledger,attempt)
                except Exception:
                    ledger.transition(task_id,fence,'uncertain')
                break
        except Exception:
            ledger.beat(lane,'queue_or_runtime_unavailable')
        time.sleep(2)
    ledger.beat(lane,'drained')

def maintenance(root):
    ledger=Ledger(root);api=queue() # credentials for publication-only child, never for a model
    while not STOP:
        ledger.beat('maintenance','idle')
        if ledger.draining('maintenance'):ledger.beat('maintenance','drained');time.sleep(1);continue
        snapshot=ledger.snapshot();now=time.time()
        health={'at':now,'workers':[{ 'lane':w['lane'],'alive':alive(json.loads(w['owner'])),'heartbeat_age':now-w['beat'],'stale':now-w['beat']>15} for w in snapshot['workers']], 'running_without_local_receipt':[]}
        try:
            rows=api.request('bridge_tasks?status=eq.running&select=id,task_number,claimed_at&order=claimed_at.asc&limit=100')
            known={a['id'] for a in snapshot['attempts']}
            health['running_without_local_receipt']=[r for r in rows if r['id'] not in known]
        except Exception:health['queue_health']='unavailable'
        health['executors']=[]
        for a in snapshot['attempts']:
            h=ledger.root/a['id']/'executor-health.json'
            try:age=now-read(h)['at']/1000
            except Exception:age=None
            health['executors'].append({'id':a['id'],'state':a['state'],'heartbeat_age':age,'needs_review':age is None or age>60})
        write(ledger.root/'health.json',health)
        for a in ledger.active():
            if a['owner'] and alive(json.loads(a['owner'])):continue
            # Don't race a live lane between reserve and child-PID journal.
            worker=ledger.db.execute('SELECT owner,state,beat FROM workers WHERE lane=?',(a['lane'],)).fetchone()
            if worker and alive(json.loads(worker[0])) and worker[1] in ('busy','starting','publishing'):continue
            if settle(ledger,a):continue
            folder=ledger.root/a['id']
            if (folder/'result.json').exists():
                # Only retry publication from durable result; NEVER execution.
                child=spawn_executor(folder,'publish')
                ledger.transition(a['id'],a['fence'],'publishing',identity(child.pid))
                while child.poll() is None:ledger.beat('maintenance','publishing');time.sleep(1)
                updated=next(x for x in ledger.active() if x['id']==a['id']);settle(ledger,updated)
        time.sleep(5)
    ledger.beat('maintenance','drained')

def supervisor(root):
    ledger=Ledger(root)
    if legacy():raise RuntimeError('Legacy worker/supervisor still active; transition not authorized')
    cfg=read(ledger.root/'activation.json')
    if cfg!={'enabled':True,'single_host':True,'legacy_drained':True}:raise RuntimeError('Explicit transition config required')
    lock=os.open(ledger.root/'supervisor.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
    fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    write(ledger.root/'supervisor-owner.json',identity())
    # Persistent retry budget: reboot must not reset a crash loop.
    budget_file=ledger.root/'restart-budget.json'
    budget=read(budget_file) if budget_file.exists() else {lane:[] for lane in LANES}
    children={};legacy_reported=False
    def launch(lane):
        if lane in children and children[lane].poll() is None:return
        now=time.time();recent=[t for t in budget.get(lane,[]) if now-t<3600]
        if len(recent)>=3 or recent and now-recent[-1]<min(2**len(recent),30):return
        # Lost supervisor may leave a worker/session alive: adopt by identity, never duplicate.
        row=ledger.db.execute('SELECT owner FROM workers WHERE lane=?',(lane,)).fetchone()
        if row and alive(json.loads(row[0])):return
        recent.append(now);budget[lane]=recent;write(budget_file,budget)
        with open(ledger.root/(lane+'.log'),'ab',buffering=0) as log:
            child=subprocess.Popen([sys.executable,'-B','-m','runtime.service',lane,'--state',str(ledger.root)],cwd=ROOT,stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
        children[lane]=child
        # Record immediately; PID-reuse safe identity is checked before any signal.
        ledger.db.execute('INSERT OR REPLACE INTO workers VALUES(?,?,?,?)',(lane,json.dumps(identity(child.pid)),'starting',now))
    while not STOP:
        if legacy():
            if not legacy_reported:ledger.event(None,'legacy_conflict_requires_review');legacy_reported=True
            for lane in LANES:
                if not ledger.draining(lane):ledger.control(str(uuid.uuid4()),lane,'drain')
        for lane in LANES:
            child=children.get(lane)
            if child and child.poll() is not None:children.pop(lane)
            if not ledger.draining(lane):launch(lane)
        for request_id,lane,action,state in ledger.db.execute("SELECT * FROM controls WHERE state NOT IN ('acknowledged','needs_review')").fetchall():
            if action=='status':ledger.db.execute("UPDATE controls SET state='acknowledged' WHERE id=?",(request_id,));continue
            row=ledger.db.execute('SELECT owner,state,beat FROM workers WHERE lane=?',(lane,)).fetchone()
            if state=='requested':ledger.db.execute("UPDATE controls SET state='draining' WHERE id=?",(request_id,))
            if not row:continue
            owner=json.loads(row[0])
            if state=='starting':
                if alive(owner) and row[1]=='idle':ledger.db.execute("UPDATE controls SET state='acknowledged' WHERE id=?",(request_id,))
                elif not alive(owner) and time.time()-row[2]>120:ledger.db.execute("UPDATE controls SET state='needs_review' WHERE id=?",(request_id,))
            elif action=='restart' and (row[1]=='drained' or not alive(owner)):
                if alive(owner):
                    ledger.db.execute("UPDATE controls SET state='stopping' WHERE id=?",(request_id,));os.kill(owner['pid'],signal.SIGTERM)
                else:
                    ledger.db.execute("UPDATE controls SET state='starting' WHERE id=?",(request_id,));launch(lane)
            elif action=='drain' and row[1]=='drained':
                # Remain drained until an explicit restart request; do not resume polling.
                pass
        time.sleep(1)
    # A stopped supervisor leaves workers draining, never kills active work.
    for lane in LANES:
        if not ledger.draining(lane):ledger.control(str(uuid.uuid4()),lane,'drain')
    os.close(lock)

if __name__=='__main__':
    os.umask(0o077)
    parser=argparse.ArgumentParser();parser.add_argument('role',choices=['supervisor',*LANES,'status','control']);parser.add_argument('--state',required=True);parser.add_argument('--lane',choices=LANES);parser.add_argument('--action',choices=['status','drain','restart'])
    args=parser.parse_args();signal.signal(signal.SIGTERM,stopping);signal.signal(signal.SIGINT,stopping)
    try:
        lane_fd=None
        if args.role in LANES:
            Ledger(args.state)
            if read(Path(args.state)/'activation.json')!={'enabled':True,'single_host':True,'legacy_drained':True} or not alive(read(Path(args.state)/'supervisor-owner.json')):raise RuntimeError('supervisor/activation required')
            lane_fd=os.open(Path(args.state)/(args.role+'.lock'),os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
            fcntl.flock(lane_fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        if args.role=='status':print(json.dumps(Ledger(args.state).snapshot()))
        elif args.role=='control':Ledger(args.state).control(str(uuid.uuid4()),args.lane,args.action)
        elif args.role=='supervisor':supervisor(args.state)
        elif args.role=='maintenance':maintenance(args.state)
        else:work(args.role,args.state)
    except Exception:
        print('Runtime indisponível: consultar configuração privada, leases e transição; nenhuma remoção automática.',file=sys.stderr);sys.exit(1)
