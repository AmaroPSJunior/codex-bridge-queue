"""No live API, process stop or production bootstrap in this test suite."""
import importlib.util
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
spec=importlib.util.spec_from_file_location('control_bootstrap',Path(__file__).resolve().parents[1]/'autostart/control-bootstrap.py')
bootstrap=importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)

class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store=SimpleNamespace(directory=Path(self.temp.name),read=lambda p:json.loads(p.read_text()))
        self.record={'phase':'waiting_legacy_exit','tasks':{'status_before':'00000000-0000-4000-8000-000000000001','restart':'00000000-0000-4000-8000-000000000002','status_after':'00000000-0000-4000-8000-000000000003'}}
        self.rows={}
        self.posts=[]
    def remote(self,method,suffix,body=None):
        if method=='POST':
            self.posts.append(body['id']);self.rows[body['id']]={'status':'queued'};return
        return [self.rows[suffix.split('eq.')[1].split('&')[0]]] if suffix.split('eq.')[1].split('&')[0] in self.rows else []
    def tick(self,**kw):
        self.record=bootstrap.step(self.record,self.store,remote=self.remote,is_ready=kw.get('is_ready',lambda:True),worker_list=kw.get('worker_list',lambda:[]),launch=kw.get('launch',lambda:self.fail('unexpected launch')))
    def test_legacy_preserved_without_remote_mutations(self):
        self.tick(is_ready=lambda:False,worker_list=lambda:[100])
        self.assertEqual(self.record['phase'],'waiting_legacy_exit');self.assertEqual(self.posts,[])
    def test_launch_only_after_legacy_exit(self):
        launches=[]
        self.tick(is_ready=lambda:False,launch=lambda:launches.append(1))
        self.assertEqual(launches,[1]);self.assertEqual(self.record['phase'],'waiting_supervisor')
    def test_real_protocol_ack_required_and_no_duplicate_post(self):
        self.tick();self.tick();self.assertEqual(len(self.posts),1)
        self.rows[self.record['tasks']['status_before']]={'status':'succeeded','result':'[]'}
        self.tick();self.assertEqual(len(self.posts),2)
        self.rows[self.record['tasks']['restart']]={'status':'succeeded','result':'accepted'}
        self.tick();self.assertEqual(self.record['phase'],'waiting_restart_ack');self.assertEqual(len(self.posts),2)
        (self.store.directory/(self.record['tasks']['restart']+'.json')).write_text(json.dumps({'status':'acknowledged'}))
        self.tick();self.assertEqual(len(self.posts),3)
        ref=hashlib.sha256(self.record['tasks']['restart'].encode()).hexdigest()[:12]
        self.rows[self.record['tasks']['status_after']]={'status':'succeeded','result':json.dumps([{'request_ref':ref,'status':'acknowledged'}])}
        self.tick();self.assertEqual(self.record['phase'],'completed');self.assertTrue(self.record['restart_ack_verified'])
        self.tick();self.assertEqual(len(self.posts),3)
    def test_false_success_rejected(self):
        self.rows[self.record['tasks']['status_before']]={'status':'succeeded','result':'IA diz que funcionou'}
        self.tick();self.assertEqual(self.record['phase'],'needs_review')

if __name__=='__main__':unittest.main()
