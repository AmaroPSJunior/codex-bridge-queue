'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {createGroqExecutor,clientDescriptor,FALLBACK_POLICY,DEFAULT_MODEL,DEFAULT_BASE_URL}=require('../executors/groq');
async function fixture(t,handler){
 const calls=[];const server=http.createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;calls.push({url:req.url,headers:req.headers,body:raw?JSON.parse(raw):null});handler(req,res,calls.at(-1));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});
 const baseUrl='http://127.0.0.1:'+server.address().port+'/openai/v1';
 const make=(options={})=>createGroqExecutor({env:{GROQ_API_KEY:'groq-test-private',CODEX_SUPABASE_SERVICE_ROLE_KEY:'sb-test-private'},baseUrl,...options});
 return {calls,make,baseUrl};
}
const models={data:[{id:DEFAULT_MODEL}]};
function json(res,body,status=200){res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));}
const answer={choices:[{message:{content:'Resposta'},finish_reason:'stop'}]};
test('default model, endpoint descriptor and external client configuration contain no credentials',()=>{
 assert.equal(DEFAULT_MODEL,'openai/gpt-oss-120b');assert.equal(DEFAULT_BASE_URL,'https://api.groq.com/openai/v1');
 const d=clientDescriptor({GROQ_API_KEY:'private'});assert.equal(d.apiKeyEnv,'GROQ_API_KEY');assert.ok(!JSON.stringify(d).includes('private'));
 assert.deepEqual(FALLBACK_POLICY,{candidate:true,priority:1,requiresHealthy:true,automatic:false,capability:'text'});
 assert.throws(()=>createGroqExecutor({env:{}}),/não configurada/);
 assert.throws(()=>createGroqExecutor({env:{GROQ_API_KEY:'same',CODEX_SUPABASE_SERVICE_ROLE_KEY:'same'}}),/inválida/);
});
test('health only discovers model and never posts a task; execution revalidates health',async t=>{
 const f=await fixture(t,(req,res)=>json(res,req.url.endsWith('models')?models:answer));
 const e=f.make(),h=await e.healthCheck();assert.equal(h.healthy,true);assert.equal(f.calls.length,1);assert.equal(f.calls[0].body,null);
 const r=await e.execute({instruction:'groq-test-private sb-test-private'});assert.equal(r.provider,'groq');assert.equal(r.status,'completed');
 assert.equal(f.calls[2].body.model,DEFAULT_MODEL);assert.equal(f.calls[2].headers.authorization,'Bearer groq-test-private');
 assert.ok(!JSON.stringify(f.calls[2].body).includes('private'));assert.equal(f.calls[2].headers.apikey,undefined);
});
for(const [status,kind,expected] of [[429,'rate_limit_exceeded','rate_limit'],[429,'insufficient_quota','quota'],[402,null,'quota'],[401,null,'authentication'],[403,null,'permission'],[500,null,'http'],[400,null,'http']])test('Groq classifies '+status+'/'+kind+' without leaking bodies',async t=>{
 const f=await fixture(t,(req,res)=>{res.setHeader('retry-after','2');json(res,{error:{code:kind,message:'groq-test-private'}},status);});
 const r=await f.make().execute({instruction:'ok'});assert.equal(r.error.code,expected);assert.equal(r.error.retryAfterMs,2000);
 assert.ok(!JSON.stringify(r).includes('groq-test-private'));assert.equal(f.calls.length,1);
 assert.equal(r.error.retryable,expected==='rate_limit'||status===500);
 assert.equal((await f.make().healthCheck()).healthy,false);
});
test('catalog unavailable or model absent is not considered healthy',async t=>{
 for(const [body,status] of [[{},404],[{data:[]},200]]){
  const f=await fixture(t,(req,res)=>json(res,body,status));assert.equal((await f.make().healthCheck()).healthy,false);assert.equal(f.calls.length,1);
 }
});
test('remote SSE progress is sanitized and independent of client/agent loop',async t=>{
 const f=await fixture(t,(req,res)=>{if(req.url.endsWith('models'))return json(res,models);res.writeHead(200,{'Content-Type':'text/event-stream'});
  res.end(['groq-test-','private\n','Resposta'].map(content=>'data: '+JSON.stringify({choices:[{delta:{content}}]})+'\n\n').join('')+'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');});
 const e=f.make();const progress=[];
 // Two textual planning steps in a host-owned loop: no OpenCode imports or tools.
 for(let i=0;i<2;i++){const r=await e.execute({instruction:'Etapa '+i,onProgress:async x=>progress.push(x)});assert.equal(r.status,'completed');assert.ok(!r.answer.includes('groq-test-private'));}
 assert.equal(f.calls.filter(x=>x.body).length,2);assert.ok(!JSON.stringify(progress).includes('groq-test-private'));
});
test('network, timeout, cancellation and malformed response are classified without retries',async t=>{
 const e=createGroqExecutor({env:{GROQ_API_KEY:'private'},fetch:async()=>{throw Error('private');}});
 assert.equal((await e.execute({instruction:'ok'})).error.code,'network');
 const f=await fixture(t,()=>{});assert.equal((await f.make({timeoutMs:30}).execute({instruction:'ok'})).error.code,'timeout');
 const c=new AbortController();c.abort();assert.equal((await f.make().execute({instruction:'ok',signal:c.signal})).error.code,'cancelled');
 const bad=await fixture(t,(req,res)=>res.end('{'));assert.equal((await bad.make().execute({instruction:'ok'})).error.code,'protocol');
});
test('worker selects Groq without invoking OpenCode and uses existing queue/lock',async t=>{
 const {harness}=require('./harness.cjs');const f=await fixture(t,(req,res)=>json(res,req.url.endsWith('models')?models:answer));
 const released=[],h=harness(t,'supabase-worker.js',{env:{AI_PROVIDER:'groq',GROQ_BASE_URL:f.baseUrl,GROQ_API_KEY:'groq-test-private'},modules:{'./executors/workspace-lock':{acquire:()=>({token:'private',release:()=>released.push(true),retain:()=>released.push(false)})}}});
 const p=h.run("execute('ok')");assert.equal(typeof p.cancel,'function');const r=await p;
 assert.equal(r.provider,'groq');assert.equal(JSON.parse(r.stdout).status,'completed');assert.equal(h.calls.length,0);assert.deepEqual(released,[true]);
});
test('Groq credential prefix is redacted even without an inherited matching key',()=>{
 const {sanitizer}=require('../task-progress');assert.equal(sanitizer({})('gsk_syntheticExample123456'),'[REDACTED]');
});
