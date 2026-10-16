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

test('Publication retry slot is atomically reserved across competing processes',()=>{
 const run=spawnSync('python3',['-B','-c',`
import concurrent.futures, tempfile
from runtime.ledger import Ledger
from runtime.recovery import publication_budget

def contender(root):
    return publication_budget(Ledger(root),'same-task',now=10**12)

with tempfile.TemporaryDirectory() as root:
    with concurrent.futures.ProcessPoolExecutor(max_workers=8) as pool:
        allowed=list(pool.map(contender,[root]*8))
    assert sum(allowed)==1,allowed
    l=Ledger(root)
    assert l.db.execute("SELECT count(*) FROM events WHERE id='same-task' AND event='publication_retry'").fetchone()[0]==1
`],{encoding:'utf8'});assert.equal(run.status,0,run.stderr);
});
