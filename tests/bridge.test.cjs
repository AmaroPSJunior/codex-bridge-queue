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
