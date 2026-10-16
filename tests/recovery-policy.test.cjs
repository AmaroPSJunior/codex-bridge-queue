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
import subprocess, sys, tempfile
from runtime.ledger import Ledger

# Spawn independent interpreters instead of ProcessPoolExecutor from -c:
# Python 3.14's forkserver cannot import __main__.contender.
worker = """import sys
from runtime.ledger import Ledger
from runtime.recovery import publication_budget
print(int(publication_budget(Ledger(sys.argv[1]), 'same-task', now=10**12)))
"""
with tempfile.TemporaryDirectory() as root:
    procs = [subprocess.Popen([sys.executable, '-B', '-c', worker, root],
              stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
             for _ in range(8)]
    outputs = [p.communicate(timeout=30) for p in procs]
    for p, (stdout, stderr) in zip(procs, outputs):
        assert p.returncode == 0, stderr
    allowed = [int(stdout.strip()) for stdout, _ in outputs]
    assert sum(allowed) == 3, allowed
    l = Ledger(root)
    assert l.db.execute("SELECT count(*) FROM events WHERE id='same-task' AND event='publication_retry'").fetchone()[0] == 3
`],{encoding:'utf8'});assert.equal(run.status,0,run.stderr);
});
