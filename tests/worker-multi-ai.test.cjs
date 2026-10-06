'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {harness}=require('./harness.cjs'),{FIELDS}=require('../executors/task-metadata');
const {defineExecutor}=require('../executors/contract'),{receipt}=require('../executors/result-receipt'),{createLifecycle}=require('../executors/task-lifecycle');
for(const provider of ['codex','antigravity','local','groq'])for(const legacy of [true,false])test('end-to-end '+provider+(legacy?' legacy':' migrated')+' preserves identity and partial failures',async t=>{
 const calls=[],events=[];let release;
 const mock=()=>defineExecutor({version:1,provider:{id:provider},execute:async input=>{
  await input.onProgress({type:'output',stream:'stdout',text:'partial\n'});await new Promise(r=>release=r);
  await input.onProgress({type:'command_end',code:1});
  return {provider,session:{provider,id:null,state:'failed'},status:'failed',answer:'partial',error:{code:'execution',message:'safe error',retryable:false},workspaceReleased:true};
 }});
 const modules={'./executors/antigravity':{createAntigravityExecutor:mock},'./executors/local-openai':{configFromEnv:()=>({}),createLocalExecutor:mock},'./executors/local':{createLocalProviderExecutor:mock},'./executors/groq':{createGroqExecutor:mock}};
 const h=harness(t,'supabase-worker.js',{env:{AI_PROVIDER:'codex',LOCAL_AI_MODEL:'original',GROQ_MODEL:'openai/gpt-oss-120b'},modules,fetch:async(url,opts)=>{calls.push({url,body:JSON.parse(opts.body)});return {ok:true,text:async()=>url.includes('/rpc/')?'true':''};}});
 const task={id:'technical-id',task_number:9,title:'Minha tarefa',...(legacy?{ai_provider:provider}:{...Object.fromEntries(FIELDS.map(k=>[k,null])),requested_provider:provider})};
 h.set('task',task);h.set('progress',{feed:(text)=>events.push(text),commandComplete:async()=>events.push('end')});
 const p=h.run("execute('instruction',task,progress)");
 if(provider==='codex'){h.calls[0].child.stdout.emit('data',JSON.stringify({status:'failed',answer:'partial',error:'safe error',threadId:'thread-123',workspaceReleased:true}));h.calls[0].child.emit('close',1);}
 else{while(!release)await new Promise(r=>setImmediate(r));release();}
 h.proc.env.LOCAL_AI_MODEL='changed';h.proc.env.GROQ_MODEL='changed';const run=await p;h.set('run',run);await h.run('finish(task,run)');
 const last=calls.at(-1);assert.equal(last.body.status,'failed');assert.equal(last.body.result,'partial');assert.ok(last.url.includes('technical-id'));
 assert.equal(last.body.task_number,undefined);assert.equal(last.body.title,undefined);assert.equal(task.task_number,9);assert.equal(task.title,'Minha tarefa');
 if(!legacy){assert.equal(calls[0].body.p_actual,provider);if(provider==='local')assert.equal(calls[0].body.p_model,'original');if(provider==='groq')assert.equal(calls[0].body.p_model,'openai/gpt-oss-120b');if(provider==='codex')assert.equal(calls[0].body.p_session,'thread-123');}
 else assert.equal(calls.length,1);
 for(const c of h.calls)if(c.command==='termux-tts-speak')c.child.emit('close',0);
});
test('Claude optional is fail-closed and never substitutes Codex',async t=>{
 const h=harness(t,'supabase-worker.js');const r=await h.run("execute('ok',{requested_provider:'claude'})");assert.equal(r.code,1);assert.equal(h.calls.length,0);
});
test('receipt recovery republishes without execution, preserves cancelled rows',async t=>{
 const h=harness(t,'supabase-worker.js');const dir=path.join(h.dir,'supabase-state'),payload={status:'failed',result:'partial',error:'failure',execution_mode:'agent'};
 receipt(dir,'id',payload);let row={status:'running'},patches=0;
 h.set('fetch',async(url,opts={})=>{if(opts.method==='PATCH'){patches++;row=payload;return {ok:true,text:async()=>''};}return {ok:true,text:async()=>JSON.stringify([row])};});
 await h.run('recoverResults()');assert.equal(patches,1);assert.equal(h.calls.length,0);assert.equal(fs.readdirSync(path.join(dir,'pending-results')).length,0);
 receipt(dir,'id',payload);row={status:'cancelled'};await h.run('recoverResults()');assert.equal(patches,1);assert.equal(fs.readdirSync(path.join(dir,'pending-results')).length,1);
});
test('receipt recovery accepts cancelled command payload',async t=>{
 const h=harness(t,'supabase-worker.js'),dir=path.join(h.dir,'supabase-state');
 const payload={status:'cancelled',result:'cancelled',error:null,execution_mode:'command',command_result:{cancelled:true},actual_provider:null,provider_model:null,provider_session_id:null,fallback_from:null,fallback_reason:null};
 receipt(dir,'cancelled-id',payload);
 let row={status:'running'},patches=0;
 h.set('fetch',async(url,opts={})=>{
  if(opts.method==='PATCH'){patches++;row=payload;return {ok:true,text:async()=>''};}
  return {ok:true,text:async()=>JSON.stringify([row])};
 });
 await h.run('recoverResults()');
 assert.equal(patches,1);
 assert.equal(fs.readdirSync(path.join(dir,'pending-results')).length,0);
});

test('validation failure preserves answer and prevents false success/commit',async()=>{
 const calls=[];const l=createLifecycle({cwd:'/unused',env:{CODEX_BRIDGE_VALIDATE:'1'},run:async(file,args)=>{calls.push([file,args]);throw Error('test failed');}});
 const r=await l.complete({code:0,stdout:JSON.stringify({status:'completed',answer:'partial',workspaceReleased:true})});
 assert.equal(r.code,1);assert.equal(JSON.parse(r.stdout).answer,'partial');assert.equal(calls.length,1);
});
test('task git rejects dirty start and never resets existing work',async()=>{
 const calls=[];const l=createLifecycle({cwd:'/unused',env:{CODEX_BRIDGE_TASK_GIT:'1'},run:async(file,args)=>{calls.push(args);return ' M existing.js';}});
 await assert.rejects(l.begin(),/sujo/);assert.equal(calls.length,1);assert.equal(calls[0][0],'status');
});
test('clean isolated task validates and commits exactly once with no push',async t=>{
 const h=harness(t,'supabase-worker.js');fs.writeFileSync(path.join(h.dir,'new.js'),'module.exports=1;');let statuses=0,heads=0;const calls=[];
 const l=createLifecycle({cwd:h.dir,env:{CODEX_BRIDGE_TASK_GIT:'1'},run:async(file,args)=>{
  calls.push([file,...args]);if(args[0]==='status')return statuses++?'?? new.js':'';if(args[0]==='rev-parse')return heads++<2?'before':'after';if(args[0]==='ls-files')return 'new.js\0';return '';
 }});
 await l.begin();const r=await l.complete({code:0,stdout:JSON.stringify({status:'completed',answer:'ok',workspaceReleased:true})});
 assert.equal(r.gitMetadata.git_status,'committed');assert.equal(calls.filter(x=>x[1]==='commit').length,1);assert.ok(!calls.some(x=>['push','reset','clean'].includes(x[1])));
});
test('provider success followed by validation failure remains a ready provider observation',()=>{
 const {observation}=require('../executors/task-metadata');const row={id:'id',...Object.fromEntries(FIELDS.map(k=>[k,null]))};
 const r={providerSelection:{provider:'groq'},providerOutcome:{code:0,status:'completed'},code:1,stdout:'{"status":"failed","answer":"preserved"}'};
 assert.equal(observation(row,r).p_state,'ready');
});
test('head changed by provider prevents a second automatic commit',async()=>{
 let count=0;const commands=[];const l=createLifecycle({cwd:'/unused',env:{CODEX_BRIDGE_TASK_GIT:'1'},run:async(file,args)=>{commands.push(args[0]);return args[0]==='rev-parse'?(count++?'changed':'before'):'';}});
 await l.begin();const r=await l.complete({code:0,stdout:'{"status":"completed","answer":"kept","workspaceReleased":true}'});
 assert.equal(r.code,1);assert.ok(!commands.includes('commit'));assert.equal(JSON.parse(r.stdout).answer,'kept');
});
