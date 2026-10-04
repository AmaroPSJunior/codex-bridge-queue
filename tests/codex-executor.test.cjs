'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createCodexExecutor,toLegacyRun}=require('../executors/codex');
const {validateResult}=require('../executors/contract');
const {harness}=require('./harness.cjs');

const cases=[
 ['success',0,'{"status":"completed","answer":"Olá","error":null,"threadId":"thread-1","turnId":"turn-1"}',''],
 ['failed',0,'{"status":"failed","answer":"partial","error":"denied"}',''],
 ['malformed',0,'not json','warning'],
 ['empty',1,'',''],
 ['exit mismatch',2,'{"status":"completed","answer":"partial"}','exit'],
 ['timeout',1,'{"status":"failed","answer":"","error":"Timeout; Não reenviar"}',''],
 ['object error',1,'{"status":"failed","error":{"message":"failure"}}',''],
 ['signal exit',null,'','signal']
];
for(const [name,code,stdout,stderr] of cases){
 test('Codex adapter preserves exact transport envelope: '+name,async()=>{
  const run={code,stdout,stderr};let calls=0;
  const executor=createCodexExecutor(async input=>{calls++;assert.equal(input.instruction,' literal $(id) ');return run;});
  const result=await executor.execute({instruction:' literal $(id) '});
  assert.equal(validateResult(result),result);
  assert.equal(result.status,name==='success'?'completed':'failed');
  assert.equal(toLegacyRun(result),run);assert.equal(calls,1);
  assert.equal(JSON.stringify(result).includes('stderr'),false);
  if(name==='success')assert.equal(result.session.id,'thread-1');
 });
 test('Queue patch identical through contract and established runner: '+name,async t=>{
  const bodies=[];
  const h=harness(t,'supabase-worker.js',{fetch:async(url,opts)=>{bodies.push(JSON.parse(opts.body));return {ok:true,text:async()=>''};}});
  h.set('prompt','literal $(id)');h.set('task',{id:'task',task_number:4,title:'Compatibilidade'});
  async function execute(expression){
   const p=h.run(expression);const child=h.calls.at(-1).child;
   child.stdout.emit('data',stdout);child.stderr.emit('data',stderr);child.emit('close',code);return p;
  }
  const legacy=await execute('runCodexProcess(prompt,task)');
  const adapted=await execute('executeCodex(prompt,task)');
  assert.deepEqual(adapted,legacy);
  h.set('a',legacy);h.set('b',adapted);
  await h.run('finish(task,a)');await h.run('finish(task,b)');
  for(const body of bodies){delete body.completed_at;delete body.updated_at;}
  assert.deepEqual(bodies[1],bodies[0]);
  assert.deepEqual(h.calls[1].args,h.calls[0].args);
  assert.deepEqual(h.calls[1].opts,h.calls[0].opts);
 });
}
test('adapter does not invent cancellation, retry, or process execution',async()=>{
 let calls=0;const e=createCodexExecutor(async()=>{calls++;throw Error('spawn failed');});
 await assert.rejects(e.execute({instruction:'ok',signal:new AbortController().signal}),/AbortSignal/);
 await assert.rejects(e.execute({instruction:''}),/instruction/);assert.equal(calls,0);
 await assert.rejects(e.execute({instruction:'ok'}),/spawn failed/);assert.equal(calls,1);
 assert.throws(()=>toLegacyRun({status:'completed'}),TypeError);
});
test('adapter forwards awaited contract progress from its runner',async()=>{
 const events=[];
 const e=createCodexExecutor(async input=>{
  await input.onProgress({type:'output',stream:'stdout',text:'hi'});
  assert.equal(events.length,1);
  await input.onProgress({type:'command_end',code:0});
  return {code:0,stdout:'{"status":"completed","answer":"ok"}',stderr:''};
 });
 await e.execute({instruction:'ok',onProgress:async event=>{await Promise.resolve();events.push(event);}});
 assert.equal(events.length,2);
});
test('queue progress retains native Buffer chunks, channels, stage and final completion',async t=>{
 const events=[];const progress={feed:(chunk,channel)=>events.push(['feed',Buffer.isBuffer(chunk)?chunk.toString('hex'):chunk,channel]),
  setStage:stage=>events.push(['stage',stage]),commandComplete:async(code,channel)=>events.push(['end',code,channel])};
 const h=harness(t,'supabase-worker.js');h.set('progress',progress);
 async function run(name){
  events.length=0;const p=h.run(name+"('ok',{},progress)");const child=h.calls.at(-1).child;
  child.stdout.emit('data',Buffer.from([0xc3]));child.stdout.emit('data',Buffer.from([0xa1]));
  child.stderr.emit('data',JSON.stringify({bridge_progress:1,type:'data',id:'cmd',text:'partial'})+'\n');
  child.stderr.emit('data',JSON.stringify({bridge_progress:1,type:'end',id:'cmd',code:3})+'\n');
  child.emit('close',1);await p;return [...events];
 }
 assert.deepEqual(await run('executeCodex'),await run('runCodexProcess'));
 assert.ok(events.some(e=>e[0]==='stage'));
});
