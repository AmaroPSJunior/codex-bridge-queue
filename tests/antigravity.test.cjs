'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {createAntigravityExecutor,MAX_OUTPUT}=require('../executors/antigravity');
const {harness}=require('./harness.cjs');
const HELP='--print --output-format (text, json, stream-json) --disable-slash-commands';
function fixture(){
 const calls=[],timers=[],kills=[],events=[];
 const e=createAntigravityExecutor({cwd:'/workspace',env:{HOME:'/private',PATH:'/bin',CODEX_SUPABASE_SERVICE_ROLE_KEY:'secret-value',CODEX_BRIDGE_WORKSPACE_TOKEN:'lease-private'},
  spawn:(command,args,opts)=>{const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.pid=42;child.kill=s=>kills.push(s);calls.push({command,args,opts,child});return child;},
  timer:(fn,ms)=>{const t={fn,ms};timers.push(t);return t;},clear:t=>{if(t)t.cleared=true;},killGroup:(pid,sig)=>kills.push([pid,sig])});
 const start=(extra={})=>e.execute({instruction:'$(touch never); literal',onProgress:async e=>events.push(e),...extra});
 function help(){calls[0].child.stdout.emit('data',HELP);calls[0].child.emit('close',0);}
 function end(value,code=0,stderr=''){const c=calls.at(-1).child;c.stdout.emit('data',typeof value==='string'?value:JSON.stringify(value));if(stderr)c.stderr.emit('data',stderr);c.emit('close',code);}
 return {calls,timers,kills,events,start,help,end};
}
test('discovers flags, passes literal prompt and removes bridge credentials',async()=>{
 const f=fixture(),p=f.start();assert.deepEqual(f.calls[0].args,['--help']);f.help();
 const c=f.calls[1];assert.equal(c.command,'agy');assert.equal(c.opts.shell,false);assert.equal(c.opts.detached,true);
 assert.deepEqual(c.args,['--print=$(touch never); literal','--output-format','json','--disable-slash-commands']);
 assert.equal(c.opts.env.CODEX_SUPABASE_SERVICE_ROLE_KEY,undefined);assert.equal(c.opts.env.CODEX_BRIDGE_WORKSPACE_TOKEN,undefined);
 f.end({status:'SUCCESS',response:'ok'});const r=await p;assert.equal(r.status,'completed');assert.equal(r.workspaceReleased,true);
 assert.equal(f.events.at(-1).type,'command_end');assert.ok(f.timers.every(t=>t.cleared));
});
test('unsupported help fails before executing a task',async()=>{
 const f=fixture(),p=f.start();f.end('old flags');const r=await p;assert.equal(r.error.code,'protocol');assert.equal(f.calls.length,1);assert.equal(r.workspaceReleased,true);
});
test('missing executable returns unavailable without raw error details',async()=>{
 const f=fixture(),p=f.start();f.calls[0].child.pid=undefined;f.calls[0].child.emit('error',Error('secret-value'));const r=await p;assert.equal(r.error.code,'unavailable');assert.ok(!JSON.stringify(r).includes('secret-value'));
});
for(const [text,code] of [['OAuth login failed','authentication'],['permission denied','permission'],['oops','protocol']])test('classifies '+code+' without exposing diagnostics',async()=>{
 const f=fixture(),p=f.start();f.help();f.end('invalid',1,text+' secret-value');const r=await p;
 assert.equal(r.error.code,code);assert.equal(r.status,'uncertain');assert.equal(r.workspaceReleased,false);assert.ok(!JSON.stringify(r).includes('secret-value'));
});
test('nonzero exit never becomes success; unknown JSON never grants release',async()=>{
 const f=fixture(),p=f.start();f.help();f.end({status:'SUCCESS',response:'ok'},7);assert.equal((await p).workspaceReleased,false);
});
test('timeout kills process group, escalates, retains fence and clears timers',async()=>{
 const f=fixture(),p=f.start();f.help();f.timers[0].fn();assert.deepEqual(f.kills[0],[42,'SIGTERM']);f.timers[1].fn();
 const r=await p;assert.equal(r.error.code,'timeout');assert.equal(r.status,'uncertain');assert.deepEqual(f.kills[1],[42,'SIGKILL']);assert.ok(f.timers.every(t=>t.cleared));
});
test('cancellation before launch and while running is explicit',async()=>{
 const a=fixture(),c=new AbortController();c.abort();assert.equal((await a.start({signal:c.signal})).status,'cancelled');assert.equal(a.calls.length,0);
 const b=fixture(),d=new AbortController(),p=b.start({signal:d.signal});b.help();d.abort();b.end('',null);const r=await p;assert.equal(r.error.code,'cancelled');assert.equal(r.workspaceReleased,false);
});
test('UTF8 split chunks and secrets are handled before progress and result',async()=>{
 const f=fixture(),p=f.start();f.help();const bytes=Buffer.from(JSON.stringify({status:'SUCCESS',response:'Olá\nsecret-value\nAuthorization: Bearer abc'}));const c=f.calls[1].child;
 for(const byte of bytes)c.stdout.emit('data',Buffer.from([byte]));c.emit('close',0);const r=await p;
 assert.ok(r.answer.includes('Olá'));assert.ok(!JSON.stringify([r,f.events]).includes('secret-value'));assert.ok(!JSON.stringify([r,f.events]).includes('Bearer abc'));
});
test('output limit interrupts without returning partial secret fragments',async()=>{
 const f=fixture(),p=f.start();f.help();f.calls[1].child.stdout.emit('data',Buffer.alloc(MAX_OUTPUT+1,65));f.calls[1].child.emit('close',null);
 const r=await p;assert.equal(r.error.code,'protocol');assert.equal(r.answer,'');assert.equal(r.workspaceReleased,false);
});
test('progress callback failure settles safely',async()=>{
 const f=fixture(),p=f.start({onProgress:async()=>{throw Error('secret-value');}});f.help();f.end({status:'SUCCESS',response:'ok'});
 assert.equal((await p).status,'uncertain');
});
test('worker selects Antigravity inside shared lock and preserves cancellation',async t=>{
 const actions=[];const h=harness(t,'supabase-worker.js',{env:{AI_PROVIDER:'antigravity'},modules:{'./executors/workspace-lock':{acquire:()=>({token:'test',release:()=>actions.push('release'),retain:()=>actions.push('retain')})}}});
 const p=h.run("execute('ok')");assert.equal(typeof p.cancel,'function');h.calls[0].child.stdout.emit('data',HELP);h.calls[0].child.emit('close',0);
 h.calls[1].child.stdout.emit('data',JSON.stringify({status:'SUCCESS',response:'answer'}));h.calls[1].child.emit('close',0);
 const r=await p;assert.equal(r.provider,'antigravity');assert.equal(JSON.parse(r.stdout).answer,'answer');assert.deepEqual(actions,['release']);
});
test('nonzero Antigravity result retains sanitized partial answer',async()=>{
 const f=fixture(),p=f.start();f.help();f.end({status:'ERROR',response:'partial secret-value',error:'failed'},1);
 const r=await p;assert.notEqual(r.status,'completed');assert.ok(r.answer.includes('partial'));assert.ok(!r.answer.includes('secret-value'));
});
