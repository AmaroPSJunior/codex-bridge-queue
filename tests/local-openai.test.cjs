'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {createLocalExecutor}=require('../executors/local-openai');
async function server(t,handler){
 const calls=[];const s=http.createServer(async(req,res)=>{let raw='';for await(const x of req)raw+=x;
  calls.push({url:req.url,headers:req.headers,body:raw&&JSON.parse(raw)});
  try{handler(req,res,calls.at(-1));}catch{res.writeHead(500);res.end();}
 });await new Promise(r=>s.listen(0,'127.0.0.1',r));t.after(()=>{s.closeAllConnections();s.close();});
 return {url:'http://127.0.0.1:'+s.address().port,calls};
}
function json(res,data,status=200){res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));}
const models={data:[{id:'test-model'}]};
const answer={choices:[{message:{content:'Olá'},finish_reason:'stop'}]};
function adapter(url,extra={}){return createLocalExecutor({baseUrl:url,model:'test-model',env:{CODEX_SUPABASE_SERVICE_ROLE_KEY:'private-value'},...extra});}
test('JSON response, model discovery, literal prompt and no Supabase credentials',async t=>{
 const s=await server(t,(req,res)=>json(res,req.url.endsWith('/models')?models:answer));const events=[];
 const r=await adapter(s.url,{stream:false}).execute({instruction:'$(id) private-value',onProgress:async e=>events.push(e)});
 assert.equal(r.status,'completed');assert.equal(r.answer,'Olá');assert.equal(s.calls[1].url,'/v1/chat/completions');
 assert.equal(s.calls[1].body.model,'test-model');assert.equal(s.calls[1].body.stream,false);
 assert.ok(!JSON.stringify(s.calls).includes('private-value'));assert.equal(s.calls[1].headers.authorization,undefined);
 assert.ok(s.calls[1].body.messages[0].content.includes('$(id)'));assert.equal(events.at(-1).type,'command_end');
});
test('SSE handles fragmented frames/UTF8 and redacts secrets split between deltas',async t=>{
 const s=await server(t,(req,res)=>{if(req.url.endsWith('/models'))return json(res,models);
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  const text=['Olá\n','private-','value\n','Fim'].map(content=>'data: '+JSON.stringify({choices:[{delta:{content},finish_reason:null}]})+'\r\n\r\n').join('')+
   'data: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n';
  const bytes=Buffer.from(text);for(let i=0;i<bytes.length;i+=3)res.write(bytes.subarray(i,i+3));res.end();
 });const events=[];const r=await adapter(s.url+'/v1/').execute({instruction:'ok',onProgress:async e=>events.push(e)});
 assert.equal(r.status,'completed');assert.ok(r.answer.startsWith('Olá'));assert.ok(!JSON.stringify([r,events]).includes('private-value'));assert.equal(events.filter(e=>e.type==='output').length,3);
});
test('models unavailable uses health; both absent permit chat without repeat',async t=>{
 for(const health of [200,404]){
  const s=await server(t,(req,res)=>{if(req.url.endsWith('/models'))return json(res,{},404);if(req.url==='/health')return json(res,{status:'ok'},health);json(res,answer);});
  assert.equal((await adapter(s.url).execute({instruction:'ok'})).status,'completed');assert.equal(s.calls.filter(x=>x.url.endsWith('completions')).length,1);
 }
});
test('unknown model and unhealthy server never receive a prompt',async t=>{
 const s=await server(t,(req,res)=>json(res,{data:[]}));assert.equal((await adapter(s.url).execute({instruction:'ok'})).error.code,'invalid_input');assert.equal(s.calls.length,1);
 const bad=await server(t,(req,res)=>json(res,{},503));assert.equal((await adapter(bad.url).execute({instruction:'ok'})).error.code,'unavailable');assert.equal(bad.calls.length,1);
});
for(const [status,code] of [[401,'authentication'],[403,'permission'],[429,'unavailable'],[500,'unavailable']])test('HTTP '+status+' classification hides response body',async t=>{
 const s=await server(t,(req,res)=>json(res,{error:'private-value'},status));const r=await adapter(s.url).execute({instruction:'ok'});
 assert.equal(r.error.code,code);assert.ok(!JSON.stringify(r).includes('private-value'));
});
test('malformed JSON, tool calls, truncated generation and incomplete SSE fail closed',async t=>{
 for(const payload of ['bad-json',{choices:[{message:{content:'tool',tool_calls:[{}]},finish_reason:'stop'}]}, {choices:[{message:{content:'partial'},finish_reason:'length'}]},'sse']){
  const s=await server(t,(req,res)=>{if(req.url.endsWith('/models'))return json(res,models);
   if(payload==='sse'){res.writeHead(200,{'Content-Type':'text/event-stream'});return res.end('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');}
   if(payload==='bad-json')return res.end('{');json(res,payload);
  });const r=await adapter(s.url).execute({instruction:'ok'});assert.equal(r.status,'failed');
 }
});
test('timeout and cancellation abort HTTP without retries',async t=>{
 const s=await server(t,()=>{});const r=await adapter(s.url,{timeoutMs:50}).execute({instruction:'ok'});assert.equal(r.error.code,'timeout');assert.equal(r.workspaceReleased,true);
 const controller=new AbortController(),p=adapter(s.url).execute({instruction:'ok',signal:controller.signal});controller.abort();assert.equal((await p).status,'cancelled');
});
test('connection failure, dedicated key and unsafe configuration',async t=>{
 const s=await server(t,(req,res)=>json(res,req.url.endsWith('/models')?models:answer));
 await adapter(s.url,{apiKey:'dedicated-key'}).execute({instruction:'ok'});assert.equal(s.calls[0].headers.authorization,'Bearer dedicated-key');
 for(const baseUrl of ['http://remote.example/v1','https://user:pass@example.com/v1','https://example.com/v1?key=x'])assert.throws(()=>adapter(baseUrl));
 assert.throws(()=>adapter(s.url,{apiKey:'private-value'}));
 const failing=createLocalExecutor({baseUrl:s.url,model:'test-model',fetch:async()=>{throw Error('private-value');}});
 assert.equal((await failing.execute({instruction:'ok'})).error.code,'unavailable');
});
test('oversized response is bounded and rejected',async t=>{
 const s=await server(t,(req,res)=>{if(req.url.endsWith('/models'))return json(res,models);res.end('x'.repeat(1024*1024+1));});
 assert.equal((await adapter(s.url).execute({instruction:'ok'})).error.code,'protocol');
});
test('worker uses local provider under lease, progress and existing finalization/TTS',async t=>{
 const {harness}=require('./harness.cjs');const actions=[],events=[],patches=[];
 const s=await server(t,(req,res)=>json(res,req.url.endsWith('/models')?models:answer));
 const h=harness(t,'supabase-worker.js',{env:{AI_PROVIDER:'local',LOCAL_AI_BASE_URL:s.url,LOCAL_AI_MODEL:'test-model'},
  modules:{'./executors/workspace-lock':{acquire:()=>({token:'private',release:()=>actions.push('released'),retain:()=>actions.push('retained')})}},
  fetch:async(url,opts)=>{patches.push(JSON.parse(opts.body));return {ok:true,text:async()=>''};}});
 h.set('progress',{feed:(text,stream)=>events.push([text,stream]),commandComplete:async()=>events.push(['end'])});
 const p=h.run("execute('ok',{},progress)");assert.equal(typeof p.cancel,'function');const r=await p;h.set('r',r);
 await h.run("finish({id:'test',task_number:4,title:'Texto'},r)");assert.equal(patches[0].status,'succeeded');assert.equal(patches[0].result,'Olá');
 assert.deepEqual(actions,['released']);assert.deepEqual(events.at(-1),['end']);assert.equal(h.calls.at(-1).command,'termux-tts-speak');
 h.calls.at(-1).child.emit('close',0);assert.ok(!JSON.stringify(s.calls).includes('synthetic-only'));
});
test('cancellation interrupts a live SSE response and retains only sanitized complete lines',async t=>{
 const controller=new AbortController();
 const s=await server(t,(req,res)=>{if(req.url.endsWith('/models'))return json(res,models);
  res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: {"choices":[{"delta":{"content":"ready\\n"}}]}\n\n');
 });const r=await adapter(s.url).execute({instruction:'ok',signal:controller.signal,onProgress:async event=>{if(event.type==='output'&&event.text==='ready\n')controller.abort();}});
 assert.equal(r.status,'cancelled');assert.equal(r.answer,'ready');assert.equal(r.workspaceReleased,true);
});
test('incomplete stream preserves a sanitized final partial line',async t=>{
 const s=await server(t,(req,res)=>{if(req.url.endsWith('/models'))return json(res,models);res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: {"choices":[{"delta":{"content":"partial private-value"}}]}\n\n');});
 const r=await adapter(s.url).execute({instruction:'ok'});assert.equal(r.status,'failed');assert.ok(r.answer.includes('partial'));assert.ok(!r.answer.includes('private-value'));
});
