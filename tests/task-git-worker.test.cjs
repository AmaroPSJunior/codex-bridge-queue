const {test}=require('node:test');
const assert=require('node:assert/strict');
const {harness}=require('./harness.cjs');

function worker(t,{commitResult,commitError}={}){
  let commitCalls=0;
  let body;

  const taskGit={
    inspectRepository:async()=>({
      root:'/repo',
      head:'1111111111111111111111111111111111111111',
      clean:true,
      status:''
    }),
    commitTaskChanges:async opts=>{
      commitCalls++;
      if(commitError)throw commitError;
      return commitResult||{
        status:'committed',
        commit_sha:'2222222222222222222222222222222222222222',
        files:['a.js']
      };
    }
  };

  const h=harness(t,'supabase-worker.js',{
    env:{CODEX_BRIDGE_TASK_AUTOCOMMIT:'1'},
    modules:{'./task-git':taskGit},
    fetch:async(u,o)=>{
      body=JSON.parse(o.body);
      return {ok:true,text:async()=>''};
    }
  });

  return {
    h,
    get body(){return body;},
    get commitCalls(){return commitCalls;}
  };
}

test('successful validated task commits once and exposes SHA',async t=>{
  const w=worker(t);

  const r=await w.h.run(`
    finish(
      {id:'uuid',task_number:31,title:'Alterar código'},
      {code:0,stdout:JSON.stringify({status:'completed',answer:'OK'}),stderr:''},
      null,
      {before:{root:'/repo',head:'1111111111111111111111111111111111111111',clean:true}}
    )
  `);

  assert.equal(w.commitCalls,1);
  assert.equal(r.status,'succeeded');
  assert.equal(r.git_status,'committed');
  assert.equal(r.commit_sha,'2222222222222222222222222222222222222222');
  assert.equal(w.body.result,'OK');
});

test('validation failure never attempts commit',async t=>{
  const w=worker(t);

  const r=await w.h.run(`
    finish(
      {id:'uuid',task_number:32,title:'Falha de validação'},
      {code:1,stdout:JSON.stringify({status:'failed',answer:'resultado parcial'}),stderr:'teste falhou'},
      null,
      {before:{root:'/repo',head:'1111111111111111111111111111111111111111',clean:true}}
    )
  `);

  assert.equal(w.commitCalls,0);
  assert.equal(r.status,'failed');
  assert.equal(r.commit_sha,null);
  assert.equal(w.body.result,'resultado parcial');
});

test('commit failure marks task failed but preserves task output',async t=>{
  const w=worker(t,{commitError:new Error('synthetic commit failure')});

  const r=await w.h.run(`
    finish(
      {id:'uuid',task_number:33,title:'Commit quebrado'},
      {code:0,stdout:JSON.stringify({status:'completed',answer:'TRABALHO PRONTO'}),stderr:''},
      null,
      {before:{root:'/repo',head:'1111111111111111111111111111111111111111',clean:true}}
    )
  `);

  assert.equal(w.commitCalls,1);
  assert.equal(r.status,'failed');
  assert.equal(r.git_status,'failed');
  assert.equal(r.commit_sha,null);
  assert.equal(w.body.result,'TRABALHO PRONTO');
  assert.match(w.body.error,/Git commit failed/);
});

test('Git metadata is persisted when schema columns are present',async t=>{
  const w=worker(t);

  const r=await w.h.run(`
    finish(
      {
        id:'uuid',
        task_number:34,
        title:'Persistir Git',
        git_status:null,
        commit_sha:null,
        git_files:null
      },
      {
        code:0,
        stdout:JSON.stringify({status:'completed',answer:'OK'}),
        stderr:''
      },
      null,
      {
        before:{
          root:'/repo',
          head:'1111111111111111111111111111111111111111',
          clean:true
        }
      }
    )
  `);

  assert.equal(r.status,'succeeded');
  assert.equal(w.body.git_status,'committed');
  assert.equal(
    w.body.commit_sha,
    '2222222222222222222222222222222222222222'
  );
  assert.deepEqual(
    Array.from(w.body.git_files),
    ['a.js']
  );
});

test('legacy schema omits Git columns from completion PATCH',async t=>{
  const w=worker(t);

  await w.h.run(`
    finish(
      {id:'uuid',task_number:35,title:'Schema antigo'},
      {
        code:0,
        stdout:JSON.stringify({status:'completed',answer:'OK'}),
        stderr:''
      },
      null,
      {
        before:{
          root:'/repo',
          head:'1111111111111111111111111111111111111111',
          clean:true
        }
      }
    )
  `);

  assert.equal(
    Object.prototype.hasOwnProperty.call(w.body,'git_status'),
    false
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(w.body,'commit_sha'),
    false
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(w.body,'git_files'),
    false
  );
});
