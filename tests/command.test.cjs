'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{EventEmitter}=require('node:events');
const {mode,validate,executeCommand,MAX_OUTPUT}=require('../executors/command');
const {harness}=require('./harness.cjs');
function mock(t){
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-command-'));t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));
 const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>{child.emit('close',null);};
 const timers=[],events=[],calls=[];
 const options={cwd,env:{SECRET_KEY:'synthetic-sensitive'},spawnFn:(file,args,opts)=>{calls.push({file,args,opts});return child;},timer:(fn,ms)=>{const t={fn,ms};timers.push(t);return t;},clear:t=>{if(t)t.cleared=true;},progress:{feed:(s,k)=>events.push([k,s]),commandComplete:async code=>events.push(['end',code])}};
 return {cwd,child,timers,events,calls,options};
}
test('legacy agent is default; payload cannot silently reach a model',()=>{
 assert.equal(mode({}),'agent');assert.equal(mode({execution_mode:null}),'agent');assert.throws(()=>mode({execution_mode:'shell'}));assert.throws(()=>mode({command_payload:{command:'pwd'}}));
});
test('successful command captures output, time and code without credentials or shell',async t=>{
 const m=mock(t),p=executeCommand({command:'pwd'},m.options);
 m.child.stdout.emit('data',Buffer.from('hello\n'));m.child.emit('close',0);const r=await p;
 assert.equal(r.code,0);assert.equal(r.commandResult.stdout,'hello\n');assert.equal(r.commandResult.exit_code,0);assert.ok(r.commandResult.started_at);assert.ok(r.commandResult.completed_at);
 assert.equal(m.calls[0].opts.shell,false);assert.equal(m.calls[0].opts.env.SECRET_KEY,undefined);assert.equal(r.providerSelection,undefined);assert.deepEqual(m.events.at(-1),['end',0]);assert.ok(m.timers.every(x=>x.cleared));
});
test('nonzero exit preserves sanitized stderr and fails',async t=>{
 const m=mock(t),p=executeCommand({command:'ls'},m.options);m.child.stderr.emit('data','bad\n');m.child.emit('close',2);const r=await p;assert.equal(r.code,1);assert.equal(r.commandResult.exit_code,2);assert.equal(r.commandResult.stderr,'bad\n');
});
for(const reason of ['timeout','cancelled'])test(reason+' stops command and clears timers',async t=>{
 const m=mock(t),c=new AbortController(),p=executeCommand({command:'pwd',timeout_ms:123},{...m.options,signal:c.signal});
 if(reason==='timeout')m.timers.find(t=>t.ms===123).fn();else c.abort();
 const r=await p;assert.equal(r.commandResult.error_code,reason);assert.equal(JSON.parse(r.stdout).workspaceReleased,true);assert.ok(m.timers.every(x=>x.cleared));
});
test('unconfirmed termination retains workspace fence',async t=>{
 const m=mock(t);m.child.kill=()=>{};const p=executeCommand({command:'pwd',timeout_ms:100},m.options);m.timers[0].fn();m.timers.find(t=>t.ms===5000).fn();const r=await p;assert.equal(JSON.parse(r.stdout).workspaceReleased,false);
});
test('secret split across chunks is redacted before progress and result',async t=>{
 const m=mock(t),p=executeCommand({command:'pwd'},m.options);m.child.stdout.emit('data','synthetic-');m.child.stdout.emit('data','sensitive\n');m.child.emit('close',0);const r=await p;assert.ok(!JSON.stringify([r,m.events]).includes('synthetic-sensitive'));
});
test('output limit drops partial line and terminates',async t=>{
 const m=mock(t),p=executeCommand({command:'pwd'},m.options);m.child.stdout.emit('data',Buffer.alloc(MAX_OUTPUT+1,65));const r=await p;assert.equal(r.commandResult.error_code,'output_limit');assert.ok(Buffer.byteLength(r.commandResult.stdout+r.commandResult.stderr)<=MAX_OUTPUT);
});
test('commands, flags, private paths, traversal and symlinks fail closed',async t=>{
 const m=mock(t);fs.symlinkSync(os.tmpdir(),path.join(m.cwd,'escape'));
 for(const payload of [{command:'sh',args:['-c','pwd']},{command:'rm',args:['-rf','.']},{command:'git',args:['reset','--hard']},{command:'git',args:['status','--short']},{command:'ls',args:['; touch x']},{command:'pwd',cwd:'../'},{command:'pwd',cwd:'/tmp'},{command:'pwd',cwd:'.git'},{command:'pwd',cwd:'logs'},{command:'pwd',env:{X:'1'}},{command:'pwd',cwd:'escape'}]){
  const r=await executeCommand(payload,m.options);assert.equal(r.code,1);
 }
 assert.equal(m.calls.length,0);
});
test('real deterministic read executes only inside temporary workspace',async t=>{
 const m=mock(t);const r=await executeCommand({command:'pwd'},{cwd:m.cwd,env:{}});assert.equal(r.code,0);assert.equal(r.commandResult.stdout.trim(),require('../task-progress').sanitizer({})(m.cwd));
});
test('client creates explicit command rows and refuses GitHub or text fallback',()=>{
 const {payload}=require('../scripts/tasks.cjs');const r=payload({execution_mode:'command',command_payload:{command:'pwd'}},'supabase');assert.equal(r.execution_mode,'command');assert.equal(r.command_payload.command,'pwd');assert.throws(()=>payload({execution_mode:'command',command_payload:{command:'pwd'}},'github'));assert.throws(()=>payload({instruction:'pwd',command_payload:{command:'pwd'}},'supabase'));
});
test('worker command bypasses provider and lifecycle, persists mode/result only',async t=>{
 let invoked=0,released=0,body;
 const h=harness(t,'supabase-worker.js',{modules:{
  './executors/command':{mode,executeCommand:async()=>{invoked++;return {code:0,executionMode:'command',commandResult:{exit_code:0,stdout:'OK',stderr:''},stdout:JSON.stringify({status:'completed',answer:'OK',workspaceReleased:true})};}},
  './executors/workspace-lock':{acquire:()=>({release(){released++;},retain(){}})},
  './executors/task-lifecycle':{createLifecycle(){throw Error('must not call');}}
 },env:{AI_PROVIDER:'invalid',CODEX_BRIDGE_TASK_GIT:'1'},fetch:async(u,o)=>{assert.ok(!u.includes('/rpc/'));body=JSON.parse(o.body);return {ok:true,text:async()=>''};}});
 h.set('task',{id:'task',execution_mode:'command',command_payload:{command:'pwd'},command_result:null,actual_provider:null});
 const r=await h.run("execute('must never reach model',task)");h.set('r',r);await h.run('finish(task,r)');
 assert.equal(invoked,1);assert.equal(released,1);assert.equal(h.calls.length,0);assert.equal(body.execution_mode,'command');assert.equal(body.command_result.exit_code,0);assert.equal(body.actual_provider,null);
});
test('worker command cancellation publishes cancelled and final flush',async t=>{
 let body,stage;const h=harness(t,'supabase-worker.js',{fetch:async(u,o)=>{body=JSON.parse(o.body);return {ok:true,text:async()=>''};}});
 h.set('progress',{close:async s=>{stage=s;}});h.set('r',{code:1,executionMode:'command',stdout:JSON.stringify({status:'cancelled',answer:'',error:'cancelled'})});await h.run("finish({id:'task',execution_mode:'command'},r,progress)");assert.equal(body.status,'cancelled');assert.equal(stage,'cancelled');
});
