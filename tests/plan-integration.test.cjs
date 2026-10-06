'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {payload}=require('../scripts/tasks.cjs');
const {mode}=require('../executors/command');
const {harness}=require('./harness.cjs');

test('client cria plan somente via Supabase',()=>{
 const input={
  project_id:'11111111-1111-4111-8111-111111111111',
  execution_mode:'plan',
  plan_payload:{
   version:1,
   steps:[{type:'write_file',path:'x.js',content:'ok'}]
  }
 };

 const r=payload(input,'supabase');

 assert.equal(r.execution_mode,'plan');
 assert.equal(r.plan_payload.version,1);
 assert.equal(r.plan_payload.steps.length,1);
 assert.throws(()=>payload(input,'github'));
});

test('worker executa plan sem provider',async t=>{
 let body,released=0;

 const h=harness(t,'supabase-worker.js',{modules:{
  './executors/command':{mode,executeCommand:async()=>{throw Error('command must not run');}},
  './executors/plan':{executePlan:async()=>({
   code:0,executionMode:'plan',
   planResult:{version:1,status:'completed',steps:[]},
   stdout:JSON.stringify({status:'completed',answer:'OK',workspaceReleased:true}),
   stderr:''
  })},
  './executors/workspace-lock':{acquire:()=>({release(){released++;},retain(){}})},
  './executors/task-lifecycle':{createLifecycle(){throw Error('provider must not run');}}
 },fetch:async(u,o)=>{
  body=JSON.parse(o.body);
  return {ok:true,text:async()=>''};
 }});

 h.set('task',{
  id:'task',
  execution_mode:'plan',
  plan_payload:{version:1,steps:[{type:'write_file',path:'x.js',content:'ok'}]},
  plan_result:null,
  actual_provider:null
 });

 const r=await h.run("execute('x',task)");
 h.set('r',r);
 await h.run('finish(task,r)');

 assert.equal(released,1);
 assert.equal(body.plan_result.status,'completed');
 assert.equal(body.actual_provider,null);
});
