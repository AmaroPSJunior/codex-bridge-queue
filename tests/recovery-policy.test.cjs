const {test}=require('node:test'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process');
test('Recovery never repeats effects; publication retry budget survives reopening',()=>{
 const run=spawnSync('python3',['-B','-c',`
import tempfile
from runtime.ledger import Ledger
from runtime.recovery import decision, publication_budget, request_inactivity_drain
with tempfile.TemporaryDirectory() as root:
 l=Ledger(root)
 assert decision({},True,True,True,True)=='observe'
 assert decision({},False,True,False,False)=='publish_only'
 assert decision({},False,False,False,False)=='blocked'
 assert decision({},False,True,True,True)=='complete'
 for n in range(3):
  assert publication_budget(l,'task',now=10**12+n*1000)
 del l
 l=Ledger(root)
 assert not publication_budget(l,'task',now=10**12+9999)
 fence=l.reserve('active-task','agent',['workspace:test'])
 a={'id':'active-task','lane':'agent'}
 assert not request_inactivity_drain(l,a,899)
 assert request_inactivity_drain(l,a,900)
 assert not request_inactivity_drain(l,a,1000)
 assert l.draining('agent')
 assert l.db.execute('SELECT count(*) FROM resources').fetchone()[0]==1
 assert l.active()[0]['fence']==fence
`],{encoding:'utf8'});assert.equal(run.status,0,run.stderr);
});
