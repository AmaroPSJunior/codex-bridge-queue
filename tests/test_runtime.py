import concurrent.futures
import json
import multiprocessing
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import uuid
ROOT=Path(__file__).resolve().parent.parent
sys.path.insert(0,str(ROOT))
from runtime.ledger import Ledger,identity,alive
from runtime.service import resources,settle,write
from runtime.queue import Queue

def contender(root,task,resource):
    return Ledger(root).reserve(task,'command',[resource])

class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);os.chmod(self.root,0o700);self.l=Ledger(self.root)
    def test_concurrent_atomic_reservation_and_no_partial_deadlock(self):
        with concurrent.futures.ProcessPoolExecutor(4) as pool:
            results=list(pool.map(contender,[str(self.root)]*8,[str(uuid.uuid4()) for _ in range(8)],['adb']*8))
        self.assertEqual(sum(x is not None for x in results),1)
        self.assertIsNone(self.l.reserve('blocked','agent',['free','adb']))
        self.assertIsNotNone(self.l.reserve('independent','command',['free']))
    def test_fencing_replay_and_reboot_preserve_uncertainty(self):
        f=self.l.reserve('task','agent',['workspace','adb']);self.l.transition('task',f,'executing',{'pid':99999999,'start':'1','boot':'old'})
        reopened=Ledger(self.root);self.assertIsNone(reopened.reserve('task','agent',['workspace']))
        self.assertIsNone(reopened.reserve('other','command',['adb']))
        with self.assertRaises(RuntimeError):reopened.transition('task','wrong','completed',release=True)
        with self.assertRaises(RuntimeError):reopened.transition('task',f,'uncertain',release=True)
        self.assertFalse(settle(reopened,reopened.active()[0]));self.assertEqual(reopened.active()[0]['state'],'uncertain')
    def test_publication_and_release_both_required(self):
        task=str(uuid.uuid4());f=self.l.reserve(task,'command',['adb']);folder=self.root/task;folder.mkdir(mode=0o700)
        write(folder/'done.json',{'published':False,'released':True});self.assertFalse(settle(self.l,self.l.active()[0]))
        write(folder/'done.json',{'published':True,'released':False});self.assertFalse(settle(self.l,self.l.active()[0]))
        write(folder/'done.json',{'published':True,'released':True});self.assertTrue(settle(self.l,self.l.active()[0]))
        self.assertIsNone(self.l.reserve(task,'command',['adb']))
        self.assertIsNotNone(self.l.reserve('new','command',['adb']))
    def test_live_executor_cannot_be_recovered_even_with_done_file(self):
        task=str(uuid.uuid4());f=self.l.reserve(task,'command',['adb']);self.l.transition(task,f,'executing',identity())
        folder=self.root/task;folder.mkdir(mode=0o700);write(folder/'done.json',{'published':True,'released':True})
        self.assertFalse(settle(self.l,self.l.active()[0]));self.assertTrue(alive(identity()))
        wrong={**identity(),'start':'incorrect'};self.assertFalse(alive(wrong))
    def test_control_is_typed_idempotent_and_drain_persists(self):
        ident=str(uuid.uuid4());self.l.control(ident,'command','drain');self.assertTrue(self.l.draining('command'))
        with self.assertRaises(Exception):self.l.control(ident,'command','restart')
        self.l.control(str(uuid.uuid4()),'command','restart');self.assertTrue(self.l.draining('command'))
        with self.assertRaises(ValueError):self.l.control(str(uuid.uuid4()),'shell','kill')
    def test_resource_policy_is_conservative_across_device_aliases(self):
        a=resources({'execution_mode':'command','command_payload':{'action':'adb.inspect','target':'10.0.0.1:5555'}})
        b=resources({'execution_mode':'command','command_payload':{'action':'adb.inspect','target':'10.0.0.2:5555'}})
        self.assertEqual(a,b);self.assertIn('device:adb',resources({}))
    def test_queue_claim_uses_english_cas_without_requeue(self):
        q=Queue('https://example.invalid','synthetic');calls=[]
        q.request=lambda *args: calls.append(args) or []
        self.assertIsNone(q.claim({'id':str(uuid.uuid4())}));self.assertIn('&status=eq.queued',calls[0][0]);self.assertEqual(calls[0][2]['status'],'running')
        q.candidates('command');self.assertIn('execution_mode=eq.command',calls[-1][0])
    def test_crash_after_reservation_never_reclaims(self):
        code="from runtime.ledger import Ledger;import os;Ledger(os.environ['TEST_ROOT']).reserve('crashed','agent',['adb']);os._exit(7)"
        r=subprocess.run([sys.executable,'-c',code],cwd=ROOT,env={**os.environ,'TEST_ROOT':str(self.root)})
        self.assertEqual(r.returncode,7);self.assertIsNone(self.l.reserve('retry','command',['adb']))
    def test_unsafe_storage_and_no_unlink_of_old_fence(self):
        os.chmod(self.root,0o755)
        with self.assertRaises(RuntimeError):Ledger(self.root)
        os.chmod(self.root,0o700)
        source=(ROOT/'runtime/service.py').read_text();self.assertNotIn('SIGKILL',source);self.assertNotIn('rmtree',source)


# Real subprocess supervision without network, credentials, models or ADB.
class SupervisorE2ETests(unittest.TestCase):
    def test_cross_restart_drains_acknowledges_and_preserves_single_lane(self):
        import time
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);os.chmod(root,0o700);write(root/'activation.json',{'enabled':True,'single_host':True,'legacy_drained':True})
            fake='''import sys,time,signal,os
from runtime.ledger import Ledger
lane,root=sys.argv[1:];l=Ledger(root);stop=False
def end(*_):
 global stop
 stop=True
signal.signal(signal.SIGTERM,end)
while not stop:
 l.beat(lane,'drained' if l.draining(lane) else 'idle');time.sleep(.05)
'''
            harness='''import sys,subprocess
from runtime import service
service.legacy=lambda:[]
original=subprocess.Popen
fake=sys.argv[2]
def launch(argv,**kwargs):
 return original([sys.executable,'-c',fake,argv[4],argv[6]],**kwargs)
service.subprocess.Popen=launch
import signal
signal.signal(signal.SIGTERM,service.stopping)
service.supervisor(sys.argv[1])
'''
            proc=subprocess.Popen([sys.executable,'-c',harness,str(root),fake],cwd=ROOT,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
            ledger=Ledger(root)
            def wait(predicate,timeout=12):
                end=time.monotonic()+timeout
                while time.monotonic()<end:
                    if predicate():return
                    if proc.poll() is not None:raise AssertionError(proc.stderr.read().decode())
                    time.sleep(.05)
                self.fail('supervisor timeout')
            try:
                wait(lambda:len(ledger.snapshot()['workers'])==3 and all(w['state']=='idle' for w in ledger.snapshot()['workers']))
                before={w['lane']:json.loads(w['owner'])['pid'] for w in ledger.snapshot()['workers']}
                rid=str(uuid.uuid4());ledger.control(rid,'command','restart')
                wait(lambda:any(c['id']==rid and c['state']=='acknowledged' for c in ledger.snapshot()['controls']))
                after={w['lane']:json.loads(w['owner'])['pid'] for w in ledger.snapshot()['workers']}
                self.assertNotEqual(before['command'],after['command']);self.assertEqual(before['agent'],after['agent']);self.assertEqual(before['maintenance'],after['maintenance'])
                self.assertTrue(all(alive(json.loads(w['owner'])) for w in ledger.snapshot()['workers']))
            finally:
                proc.terminate();proc.wait(timeout=5)
                for w in ledger.snapshot()['workers']:
                    owner=json.loads(w['owner'])
                    if alive(owner):os.kill(owner['pid'],15)
                proc.stderr.close()



class CrashBudgetTests(unittest.TestCase):
    def test_supervisor_crash_loop_budget_survives_restart(self):
        import time
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);os.chmod(root,0o700);write(root/'activation.json',{'enabled':True,'single_host':True,'legacy_drained':True})
            code="""import sys,subprocess,signal
from runtime import service
service.legacy=lambda:[]
original=subprocess.Popen
service.subprocess.Popen=lambda argv,**kw:original([sys.executable,'-c','import os;os._exit(7)'],**kw)
signal.signal(signal.SIGTERM,service.stopping)
service.supervisor(sys.argv[1])
"""
            def start():return subprocess.Popen([sys.executable,'-c',code,str(root)],cwd=ROOT,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            proc=start()
            try:
                end=time.monotonic()+15
                while time.monotonic()<end:
                    file=root/'restart-budget.json'
                    if file.exists() and all(len(v)==3 for v in json.loads(file.read_text()).values()):break
                    time.sleep(.1)
                else:self.fail('crash budget did not stop retries')
            finally:proc.terminate();proc.wait(timeout=5)
            before=(root/'restart-budget.json').read_bytes()
            proc=start()
            try:
                time.sleep(2)
                self.assertEqual(before,(root/'restart-budget.json').read_bytes())
            finally:proc.terminate();proc.wait(timeout=5)

if __name__=='__main__':unittest.main()
