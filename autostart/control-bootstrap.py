#!/data/data/com.termux/files/usr/bin/python3
"""Passive upgrade/bootstrap and real queue probes. Never signals a process."""
import fcntl
import importlib.util
import json
import hashlib
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.request
import urllib.error
import urllib.parse
import uuid

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('bridge_launcher', ROOT/'autostart/supabase-launcher.py')
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


def api(method, suffix, body=None):
    url = json.loads((ROOT/'remote-config.json').read_text())['supabase']['url'].rstrip('/')
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != 'https' or not parsed.hostname.endswith('.supabase.co') or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path:
        raise RuntimeError('endpoint_invalid')
    key = launcher.credential().strip()
    request = urllib.request.Request(url+'/rest/v1/bridge_tasks'+suffix,
        data=json.dumps(body).encode() if body is not None else None, method=method,
        headers={'apikey': key, 'Authorization': 'Bearer '+key, 'Content-Type': 'application/json', 'Prefer': 'return=minimal'})
    # Never redirect authenticated requests to another endpoint.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=10) as response:
            raw=response.read(65537)
            if len(raw)>65536:
                raise RuntimeError('response_limit')
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as error:
        raise RuntimeError('http_'+str(error.code)) from None


def ready(store):
    try:
        supervisor=store.read(store.directory/'supervisor.json')
        boot=store.read(store.directory/'boot.json')
        if boot['pid'] not in launcher.workers():
            return False
        args=(Path('/proc')/str(supervisor['pid'])/'cmdline').read_bytes().split(b'\0')
        if str(ROOT/'autostart/supabase-launcher.py').encode() not in args or b'--supervise' not in args:
            return False
        parent=int((Path('/proc')/str(boot['pid'])/'stat').read_text().split(') ')[1].split()[1])
        return parent==supervisor['pid'] and isinstance(boot.get('generation'), str)
    except (OSError, ValueError, KeyError):
        return False


def step(record, store, remote=api, is_ready=None, worker_list=None, launch=None):
    is_ready=is_ready or (lambda: ready(store))
    worker_list=worker_list or launcher.workers
    launch=launch or (lambda: subprocess.run([sys.executable, str(ROOT/'autostart/supabase-launcher.py')], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
    if record['phase'] in ('completed', 'needs_review'):
        return record
    if not is_ready():
        if worker_list():
            return {**record, 'phase': 'waiting_legacy_exit'}
        launch()
        return {**record, 'phase': 'waiting_supervisor'}
    # IDs are persisted before any POST, and GET reconciles lost POST replies.
    for label, command in [('status_before', 'status'), ('restart', 'restart'), ('status_after', 'status')]:
        if label=='status_after':
            ack_file=store.directory/(record['tasks']['restart']+'.json')
            if not ack_file.exists() or store.read(ack_file).get('status')!='acknowledged':
                return {**record, 'phase': 'waiting_restart_ack'}
        task_id=record['tasks'][label]
        rows=remote('GET', '?id=eq.'+task_id+'&select=status,result,error&limit=1')
        if not rows:
            remote('POST', '', {'id': task_id, 'instruction': json.dumps({'bridge_control': command}, separators=(',', ':')), 'status': 'queued'})
            return {**record, 'phase': 'waiting_'+label}
        if rows[0]['status'] not in ('succeeded', 'failed', 'cancelled'):
            return {**record, 'phase': 'waiting_'+label}
        if rows[0]['status']!='succeeded':
            return {**record, 'phase': 'needs_review', 'reason': 'control_task_not_succeeded'}
        if command=='status':
            try:
                result=json.loads(rows[0]['result'])
                if not isinstance(result,list):
                    raise ValueError()
                if label=='status_after' and not any(r.get('request_ref')==hashlib.sha256(record['tasks']['restart'].encode()).hexdigest()[:12] and r.get('status')=='acknowledged' for r in result):
                    raise ValueError()
            except (ValueError, TypeError, AttributeError):
                return {**record, 'phase': 'needs_review', 'reason': 'remote_status_not_verified'}
    return {**record, 'phase': 'completed', 'remote_status_verified': True, 'restart_ack_verified': True, 'completed_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}


def store_for_bootstrap():
    # Do not instantiate SupervisorControl: its recovery belongs to the supervisor.
    store=object.__new__(launcher.SupervisorControl)
    store.directory=ROOT/'supabase-state/control'
    store.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    st=store.directory.lstat()
    if store.directory.is_symlink() or not store.directory.is_dir() or st.st_uid!=os.getuid() or st.st_mode&0o777!=0o700:
        raise RuntimeError('unsafe_control_directory')
    return store


def main():
    os.umask(0o077)
    store=store_for_bootstrap()
    file=store.directory/'bootstrap.json'
    if len(sys.argv)==2 and sys.argv[1]=='--detach':
        fd=os.open(store.directory/'bootstrap.lock', os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW, 0o600)
        try:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX|fcntl.LOCK_NB)
            except BlockingIOError:
                return
            if not file.exists():
                store.write(file, {'version': 1, 'phase': 'waiting_legacy_exit', 'tasks': {k:str(uuid.uuid4()) for k in ('status_before','restart','status_after')}})
            if store.read(file)['phase'] in ('completed','needs_review'):
                return
            subprocess.Popen([sys.executable, str(Path(__file__).resolve()), '--run', str(fd)], pass_fds=(fd,), start_new_session=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        finally:
            os.close(fd)
        return
    if len(sys.argv)!=3 or sys.argv[1]!='--run':
        raise RuntimeError('invalid_arguments')
    lock_fd=int(sys.argv[2])
    os.fstat(lock_fd)
    record=store.read(file)
    record={**record, 'bootstrap_pid': os.getpid()}
    store.write(file,record)
    while record['phase'] not in ('completed','needs_review'):
        try:
            record=step(record,store)
            record.pop('last_error',None)
        except Exception:
            record={**record,'last_error':'bootstrap_probe_unavailable'}
        store.write(file,record)
        if record['phase'] not in ('completed','needs_review'):
            time.sleep(15)

if __name__=='__main__':
    try:
        main()
    except Exception:
        print('Bootstrap unavailable; existing processes preserved.', file=sys.stderr)
        sys.exit(1)
