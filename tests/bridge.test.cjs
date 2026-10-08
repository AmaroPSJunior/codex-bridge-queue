const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {EventEmitter}=require('node:events');const {harness,flush}=require('./harness.cjs');
// Separate harness uses a pre-created temporary thread through fs adapter, never /fake.
async function setup(t,opts={}){
 const real=fs;const store=new Map(opts.saved?[['/fake/thread','thread-test\n']]:[]);
 const adapter={...real,existsSync:p=>String(p).startsWith('/fake/')?store.has(p):real.existsSync(p),readFileSync:(p,...a)=>String(p).startsWith('/fake/')?store.get(p):real.readFileSync(p,...a),writeFileSync:(p,v,...a)=>String(p).startsWith('/fake/')?store.set(p,v):real.writeFileSync(p,v,...a),renameSync:(a,b)=>{if(String(a).startsWith('/fake/')){store.set(b,store.get(a));store.delete(a);}else real.renameSync(a,b);}};
 let ws;const requests=[];
 class Socket extends EventEmitter{
  constructor(){super();ws=this;setImmediate(()=>this.emit('open'));}
  send(raw){const m=JSON.parse(raw);requests.push(m);if(!m.id||!m.method)return;let result={};
   if(m.method.startsWith('thread/'))result={thread:{id:'thread-test'}};
   if(m.method==='turn/start')result={turn:{id:'turn-test'}};
   setImmediate(()=>this.emit('message',JSON.stringify((opts.resumeError&&m.method==='thread/resume')||(opts.profileError&&m.method.startsWith('thread/'))?{id:m.id,error:{message:'resume failed'}}:{id:m.id,result})));
  }
  close(){this.emit('close');}terminate(){}
 }
 const h=harness(t,'bridge.js',{env:{CODEX_BRIDGE_LOCKED:'/fake/thread',CODEX_BRIDGE_THREAD_FILE:'/fake/thread',CODEX_BRIDGE_JSON:'1',...opts.env},argv:['node','bridge.js','literal $(touch never)'],modules:{fs:adapter,ws:Socket,http:{get:(url,cb)=>{const req=new EventEmitter();req.setTimeout=()=>{};req.destroy=()=>{};setImmediate(()=>cb({resume(){},statusCode:200}));return req;}}}});
 for(let i=0;i<8;i++)await flush();
 return {h,requests,ws,store,send:(method,params)=>ws.emit('message',JSON.stringify({method,params}))};
}
test('Bridge starts thread, passes literal input and returns completed result',async t=>{const b=await setup(t);assert.equal(b.requests.find(x=>x.method==='turn/start').params.input[0].text,'literal $(touch never)');b.send('item/completed',{threadId:'thread-test',turnId:'turn-test',item:{type:'agentMessage',text:'answer'}});b.send('turn/completed',{threadId:'thread-test',turn:{id:'turn-test',status:'completed'}});assert.equal(JSON.parse(b.h.logs[0]).answer,'answer');assert.equal(JSON.parse(b.h.logs[0]).status,'completed');assert.equal(b.store.get('/fake/thread'),'thread-test\n');});
test('Bridge resumes saved thread',async t=>{const b=await setup(t,{saved:true});assert.ok(b.requests.some(x=>x.method==='thread/resume'));assert.ok(!b.requests.some(x=>x.method==='thread/start'));});
test('Bridge resume failure preserves pointer',async t=>{const b=await setup(t,{saved:true,resumeError:true});assert.equal(b.store.get('/fake/thread'),'thread-test\n');assert.equal(JSON.parse(b.h.logs[0]).status,'failed');assert.ok(!b.requests.some(x=>x.method==='turn/start'));});
test('Bridge ignores malformed and unrelated notifications',async t=>{const b=await setup(t);b.ws.emit('message','{');b.send('turn/completed',{threadId:'other',turn:{id:'turn-test',status:'completed'}});b.send('turn/completed',{threadId:'thread-test',turn:{id:'other',status:'completed'}});assert.equal(b.h.logs.length,0);});
test('Bridge rejects interactive approval without authorizing it',async t=>{const b=await setup(t);b.ws.emit('message',JSON.stringify({id:99,method:'approval/request',params:{}}));assert.ok(b.requests.find(x=>x.id===99).error);assert.match(JSON.parse(b.h.logs[0]).error,/interativa/);});
test('Bridge timeout reports potentially continuing turn',async t=>{const b=await setup(t);const timer=b.h.timers.find(x=>x.ms===900000);timer.fn();assert.match(JSON.parse(b.h.logs[0]).error,/Não reenviar/);assert.equal(timer.cleared,true);});
test('Bridge disconnect reports uncertain result exactly once',async t=>{const b=await setup(t);b.ws.emit('close');b.ws.emit('error',Error('later'));assert.equal(b.h.logs.length,1);assert.match(JSON.parse(b.h.logs[0]).error,/incerto/);});
test('Bridge failed turn is not success',async t=>{const b=await setup(t);b.send('turn/completed',{threadId:'thread-test',turn:{id:'turn-test',status:'failed',error:{message:'test failure'}}});assert.equal(JSON.parse(b.h.logs[0]).status,'failed');});
test('Bridge wraps caller in flock with literal argv',t=>{const h=harness(t,'bridge.js',{argv:['node','bridge.js','$(touch never)'],modules:{ws:class{},http:{}}});assert.equal(h.calls[0].command,'flock');assert.equal(h.calls[0].args.at(-1),'$(touch never)');assert.equal(h.calls[0].args[0],'-x');});
test('Local inbox worker handles empty task without execution',async t=>{const h=harness(t,'worker.js');fs.writeFileSync(path.join(h.dir,'codex-bridge/inbox/1.txt'),'  ');await h.run('processQueue()');assert.equal(h.calls.length,0);assert.equal(fs.readdirSync(path.join(h.dir,'codex-bridge/inbox')).length,0);});
test('Local inbox returns output, serializes queue and keeps literal argument',async t=>{const h=harness(t,'worker.js');h.proc.stdout={write(){}};h.proc.stderr={write(){}};const inbox=path.join(h.dir,'codex-bridge/inbox');fs.writeFileSync(path.join(inbox,'1.txt'),'$(touch never)');fs.writeFileSync(path.join(inbox,'2.txt'),'second');await h.run('processQueue()');await h.run('processQueue()');assert.equal(h.calls.length,1);const c=h.calls[0];assert.equal(c.args[0],'$(touch never)');c.child.stdout.emit('data',Buffer.from('OK'));c.child.emit('close',0);assert.match(fs.readFileSync(path.join(h.dir,'codex-bridge/outbox/1.txt'),'utf8'),/EXIT_CODE=0[\s\S]*OK/);assert.ok(fs.existsSync(path.join(inbox,'2.txt')));});

for(const value of ['1234','60000'])test('Bridge configured timeout '+value,async t=>{const b=await setup(t,{env:{CODEX_BRIDGE_TIMEOUT_MS:value}});const timer=b.h.timers.find(x=>x.ms===Number(value));assert.ok(timer);timer.fn();assert.match(JSON.parse(b.h.logs[0]).error,new RegExp(value+' ms'));assert.equal(timer.cleared,true);});
for(const value of ['0','-1','invalid','1.5','2147483648'])test('Bridge invalid timeout falls back safely: '+value,async t=>{const b=await setup(t,{env:{CODEX_BRIDGE_TIMEOUT_MS:value}});assert.ok(b.h.timers.some(x=>x.ms===900000));});
test('Bridge completion clears deadline and does not leave close timer after synchronous close',async t=>{const b=await setup(t);b.send('turn/completed',{threadId:'thread-test',turn:{id:'turn-test',status:'completed'}});assert.equal(b.h.timers.find(x=>x.ms===900000).cleared,true);assert.ok(!b.h.timers.some(x=>x.ms===1000&&!x.cleared));});
test('Bridge delayed close clears termination timer',async t=>{const b=await setup(t);b.ws.close=()=>{};b.send('turn/completed',{threadId:'thread-test',turn:{id:'turn-test',status:'completed'}});const timer=b.h.timers.find(x=>x.ms===1000);assert.ok(timer);b.ws.emit('close');assert.equal(timer.cleared,true);});

test('Bridge sends human task header to TTS stdin while preserving JSON answer',async t=>{
 const b=await setup(t,{env:{CODEX_BRIDGE_TASK_NUMBER:'9',CODEX_BRIDGE_TASK_TITLE:'Revisar saída'}});
 b.send('item/completed',{threadId:'thread-test',turnId:'turn-test',item:{type:'agentMessage',text:'Resposta existente.'}});
 b.send('turn/completed',{threadId:'thread-test',turn:{id:'turn-test',status:'completed'}});
 const call=b.h.calls.find(c=>c.command==='termux-tts-speak');
 assert.equal(call.child.input,'Tarefa 9 — Revisar saída foi finalizada com sucesso.\n\nResposta existente.');
 assert.equal(JSON.parse(b.h.logs[0]).answer,'Resposta existente.');
 assert.deepEqual(Array.from(b.requests.find(r=>r.method==='thread/start').params.config.notify),[]);
 call.child.emit('close',0);assert.ok(b.h.timers.find(t=>t.ms===120000).cleared);
});
test('Bridge speaks failure once and resumes with scoped notify override',async t=>{
 const b=await setup(t,{saved:true,env:{CODEX_BRIDGE_TASK_NUMBER:'4',CODEX_BRIDGE_TASK_TITLE:'Consultar'}});
 assert.deepEqual(Array.from(b.requests.find(r=>r.method==='thread/resume').params.config.notify),[]);
 b.send('turn/completed',{threadId:'thread-test',turn:{id:'turn-test',status:'failed',error:{message:'network'}}});
 b.ws.emit('close');
 const calls=b.h.calls.filter(c=>c.command==='termux-tts-speak');assert.equal(calls.length,1);
 assert.ok(calls[0].child.input.startsWith('Tarefa 4 — Consultar foi finalizada com falha.'));
});
test('Bridge legacy TTS has readable fallback and no UUID announcement',async t=>{
 const b=await setup(t);b.send('turn/completed',{threadId:'thread-test',turn:{id:'turn-test',status:'completed'}});
 assert.ok(b.h.calls.find(c=>c.command==='termux-tts-speak').child.input.startsWith('Tarefa legada — Tarefa sem título foi finalizada com sucesso.'));
});
test('Explicit TTS opt-out preserves global notification configuration',async t=>{
 const b=await setup(t,{env:{CODEX_BRIDGE_TTS:'0'}});assert.equal(b.requests.find(r=>r.method==='thread/start').params.config,undefined);
 b.send('turn/completed',{threadId:'thread-test',turn:{id:'turn-test',status:'completed'}});
 assert.ok(!b.h.calls.some(c=>c.command==='termux-tts-speak'));
});


test('Bridge opt-in terminal deltas use stderr and ignore unrelated turns without changing JSON',async t=>{
 const b=await setup(t,{env:{CODEX_BRIDGE_PROGRESS:'1'}});const output=[];b.h.proc.stderr={write:s=>output.push(s)};
 b.send('item/commandExecution/outputDelta',{threadId:'other',turnId:'turn-test',delta:'wrong'});
 b.send('item/commandExecution/outputDelta',{threadId:'thread-test',turnId:'other',delta:'wrong'});
 b.send('item/commandExecution/outputDelta',{threadId:'thread-test',turnId:'turn-test',delta:'terminal\n'});
 b.send('turn/completed',{threadId:'thread-test',turn:{id:'turn-test',status:'completed'}});
 b.send('item/commandExecution/outputDelta',{threadId:'thread-test',turnId:'turn-test',delta:'late'});
 assert.equal(output.length,1);assert.deepEqual(JSON.parse(output[0]),{bridge_progress:1,type:'data',id:'command',text:'terminal\n'});assert.equal(JSON.parse(b.h.logs[0]).status,'completed');
});


test('Bridge command completion captures aggregate tail and exit after streamed output',async t=>{
 const b=await setup(t,{env:{CODEX_BRIDGE_PROGRESS:'1'}});const frames=[];b.h.proc.stderr={write:s=>frames.push(JSON.parse(s))};
 b.send('item/started',{threadId:'thread-test',turnId:'turn-test',item:{type:'commandExecution',id:'cmd',command:'echo hello'}});
 assert.equal(b.h.logs.length,0);
 b.send('item/commandExecution/outputDelta',{threadId:'thread-test',turnId:'turn-test',itemId:'cmd',delta:'first\n'});
 b.send('item/completed',{threadId:'thread-test',turnId:'turn-test',item:{type:'commandExecution',id:'cmd',exitCode:7,aggregatedOutput:'first\nlast'}});
 assert.deepEqual(frames.map(f=>[f.type,f.command??f.text??f.code]),[['start','echo hello'],['data','first\n'],['data','last'],['end',7]]);
});
test('Bridge silent command completion emits only control, not an output line',async t=>{
 const b=await setup(t,{env:{CODEX_BRIDGE_PROGRESS:'1'}});const frames=[];b.h.proc.stderr={write:s=>frames.push(JSON.parse(s))};
 b.send('item/completed',{threadId:'thread-test',turnId:'turn-test',item:{type:'commandExecution',id:'empty',exitCode:0,aggregatedOutput:''}});
 assert.deepEqual(frames,[{bridge_progress:1,type:'end',id:'empty',code:0}]);assert.equal(b.h.logs.length,0);
});


test('Bridge applies backpressure to progress stream without changing task execution commands',async t=>{
 const b=await setup(t,{env:{CODEX_BRIDGE_PROGRESS:'1'}});let paused=0,resumed=0,drain;
 b.ws.pause=()=>paused++;b.ws.resume=()=>resumed++;b.h.proc.stderr={write:()=>false,once:(name,fn)=>{assert.equal(name,'drain');drain=fn;}};
 b.send('item/commandExecution/outputDelta',{threadId:'thread-test',turnId:'turn-test',itemId:'cmd',delta:'output\n'});
 assert.equal(paused,1);drain();assert.equal(resumed,1);
});

for(const saved of [false,true])test('Operator profile selected exclusively for thread and turn '+saved,async t=>{
 const b=await setup(t,{saved,env:{CODEX_BRIDGE_PERMISSIONS_PROFILE:'bridge-git'}});
 for(const request of b.requests.filter(r=>['thread/start','thread/resume','turn/start'].includes(r.method))){
  assert.equal(request.params.permissions,'bridge-git');assert.equal(request.params.approvalPolicy,'never');
  assert.equal(request.params.sandbox,undefined);assert.equal(request.params.sandboxPolicy,undefined);
 }
 assert.ok(b.requests.some(r=>r.method==='turn/start'));
});
test('Default retains existing workspace sandbox and private config roots',async t=>{
 const b=await setup(t);const thread=b.requests.find(r=>r.method==='thread/start').params,turn=b.requests.find(r=>r.method==='turn/start').params;
 assert.equal(thread.sandbox,'workspace-write');assert.equal(turn.sandboxPolicy.type,'workspaceWrite');assert.equal(turn.permissions,undefined);
 assert.equal(turn.sandboxPolicy.writableRoots.length,2);assert.ok(!turn.sandboxPolicy.writableRoots.some(p=>p.endsWith('/.git')));
});
test('Rejected profile fails closed without default fallback or turn',async t=>{
 const b=await setup(t,{saved:true,profileError:true,env:{CODEX_BRIDGE_PERMISSIONS_PROFILE:'bridge-git'}});
 assert.ok(!b.requests.some(r=>r.method==='turn/start'));assert.equal(b.requests.filter(r=>r.method==='thread/resume').length,1);assert.equal(b.store.get('/fake/thread'),'thread-test\n');
});
test('Built-in unrestricted profile cannot be selected through bridge option',async t=>{
 const b=await setup(t,{env:{CODEX_BRIDGE_PERMISSIONS_PROFILE:':danger-full-access'}});
 assert.ok(!b.requests.some(r=>r.method==='thread/start'));assert.equal(JSON.parse(b.h.logs[0]).status,'failed');
});

