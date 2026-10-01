"""Isolated integration checks; no real network or Codex invocation."""
import json, os, pathlib, shutil, subprocess, tempfile, time
ROOT = pathlib.Path(__file__).resolve().parents[1]
SHEBANG = '#!' + shutil.which('python3') + '\n'

def wait_for(check, timeout=12):
    end=time.monotonic()+timeout
    while time.monotonic()<end:
        try:
            value=check()
            if value:return value
        except (FileNotFoundError,json.JSONDecodeError,KeyError):pass
        time.sleep(.1)
    raise AssertionError('Timed out')

with tempfile.TemporaryDirectory(prefix='bridge-queue-test-') as temp:
    root=pathlib.Path(temp); bridge=root/'bridge'; bridge.mkdir()
    for name in ('remote','remote-worker.js','task-display.js'): shutil.copy(ROOT/name,bridge/name)
    (bridge/'logs').mkdir(); (root/'bin').mkdir()
    (bridge/'remote-config.json').write_text(json.dumps({'repository':'owner/queue','allowedAuthors':['owner'],'pollSeconds':.1,'maxPromptBytes':24000}))
    db=root/'db.json'
    def issue(n,task='test-unique-001',prompt='literal $(touch /must-not-exist); `uname` "quote"\nnew line'):
        return {'number':n,'id':n,'user':{'login':'owner'},'body':json.dumps({'protocol':'codex-bridge/v1','task_id':task,'prompt':prompt}),'labels':[{'name':'codex:queued'}],'state':'open','comments':[]}
    db.write_text(json.dumps({'issues':[issue(1)],'nextComment':1,'failResultOnce':True}))
    fakegh=SHEBANG+r'''
import json,os,sys,pathlib
p=pathlib.Path(os.environ['MOCK_DB']);db=json.loads(p.read_text());args=sys.argv[1:];endpoint=args[3];method=args[args.index('--method')+1];body=json.load(sys.stdin) if '--input' in args else None
endpoint=endpoint.split('?')[0];parts=endpoint.split('/');out=None
if endpoint=='repos/owner/queue':out={'private':True,'has_issues':True}
elif endpoint=='repos/owner/queue/issues':out=[i for i in db['issues'] if i['state']=='open' and {'name':'codex:queued'} in i['labels']]
else:
 i=next(i for i in db['issues'] if i['number']==int(parts[4]))
 if len(parts)==6:
  if method=='GET':out=i['comments']
  else:
   out={'id':db['nextComment'],'body':body['body'],'user':{'login':'owner'}};i['comments'].append(out);db['nextComment']+=1
   # Server accepted result but client sees an error: retry must reconcile.
   if db.get('failResultOnce') and 'codex-bridge:result:' in body['body']:
    db['failResultOnce']=False;p.write_text(json.dumps(db));sys.exit(1)
 elif method=='PATCH':
  if 'labels' in body:i['labels']=[{'name':x} for x in body['labels']]
  if 'state' in body:i['state']=body['state']
  out=i
 else:out=i
p.write_text(json.dumps(db));print(json.dumps(out))
'''
    (root/'bin/gh').write_text(fakegh);(root/'bin/gh').chmod(0o700)
    (root/'bin/codex-bridge').write_text(SHEBANG+r'''
import json,os,sys,time
with open(os.environ['MOCK_CALLS'],'a') as f:f.write(json.dumps(sys.argv[1:])+'\n')
if os.path.exists(os.environ['MOCK_SLOW']):time.sleep(30)
print(json.dumps({'status':'completed','answer':'PONTE REMOTA FUNCIONANDO','threadId':'mock-thread','turnId':'mock-turn'}))
''');(root/'bin/codex-bridge').chmod(0o700)
    env={**os.environ,'PATH':str(root/'bin')+':'+os.environ['PATH'],'PREFIX':str(root),'MOCK_DB':str(db),'MOCK_CALLS':str(root/'calls'),'MOCK_SLOW':str(root/'slow')}
    def ctl(action):return subprocess.run([shutil.which('node'),str(bridge/'remote'),action],env=env,capture_output=True,text=True,check=True)
    def state(n):return json.loads((bridge/'remote-state'/f'{n}.json').read_text())
    try:
        ctl('start');wait_for(lambda:state(1)['status']=='done')
        assert state(1)['executions']==1
        assert json.loads((root/'calls').read_text().splitlines()[0])==[json.loads(issue(1)['body'])['prompt']]
        actual=json.loads(db.read_text())['issues'][0]
        assert len([c for c in actual['comments'] if 'codex-bridge:result:' in c['body']])==1
        before=(bridge/'remote.pid').read_text();ctl('start');assert (bridge/'remote.pid').read_text()==before
        ctl('stop')
        data=json.loads(db.read_text());data['issues'][0]['state']='open';data['issues'][0]['labels']=[{'name':'codex:queued'}];data['issues'].append(issue(2));data['issues'].append(issue(3,'invalid-task',prompt=''))
        db.write_text(json.dumps(data));ctl('start')
        wait_for(lambda:state(2)['status']=='duplicate');wait_for(lambda:state(3)['status']=='rejected')
        assert len((root/'calls').read_text().splitlines())==1
        assert state(2)['executions']==0 and state(3)['executions']==0
        ctl('restart');time.sleep(.5);assert len((root/'calls').read_text().splitlines())==1;ctl('stop')
        # Simulate durable execution fence left behind by an interrupted worker.
        data=json.loads(db.read_text());data['issues'].append(issue(4,'crash-task-004'));db.write_text(json.dumps(data))
        (bridge/'remote-state/4.json').write_text(json.dumps({'issue':4,'taskId':'crash-task-004','status':'executing','executions':1}))
        ctl('start');wait_for(lambda:state(4)['status']=='uncertain');assert len((root/'calls').read_text().splitlines())==1;ctl('stop')
        print('PASS: literal argv; one execution; lost HTTP reply reconciliation; one result comment; singleton lock; reopen; duplicate task_id; invalid input; restart; uncertain crash recovery')
    finally:
        ctl('stop')
