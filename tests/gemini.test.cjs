const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process');
const {createClient,loadLocal}=require('../integrations/gemini/client.cjs');
const {createProtocol}=require('../integrations/gemini/server.cjs');
const id='12345678-1234-1234-1234-123456789abc',key='synthetic-private-service-key';
const response=(body,status=200)=>({ok:status<400,status,json:async()=>body});
function mock({legacy=false,postStatus=201,lost=false}={}){
 let row;const calls=[],titles=new Map();
 const client=createClient({url:'https://example.invalid',key,newId:()=>id,legacy:{get:id=>titles.get(id),set:(id,title)=>titles.set(id,title)},fetch:async(url,opts)=>{
  calls.push({url,opts});assert.equal(opts.redirect,'error');assert.ok(opts.signal);assert.equal(opts.headers.apikey,key);
  if(url.includes('limit=0'))return legacy?response({code:'42703'},400):response([]);
  if(opts.method==='POST'){
   const b=JSON.parse(opts.body);row={...b,...(legacy?{}:{task_number:7}),created_at:'2026-01-01T00:00:00Z'};
   if(lost)throw Error('network '+key);
   return response(postStatus<400?[row]:{message:key},postStatus);
  }
  return response(row?[row]:[]);
 }});
 return {client,calls,setRow:r=>{row=r;}};
}
test('Gemini creates queued task with friendly title and literal instruction',async()=>{
 const m=mock();const result=await m.client.create({title:'Conferir ponte',instruction:'literal $(touch never)'});
 assert.equal(result.label,'Tarefa 7 — Conferir ponte');assert.equal(result.identifier,'7');assert.equal(result.status,'queued');
 const post=m.calls.find(c=>c.opts.method==='POST');const body=JSON.parse(post.opts.body);assert.equal(body.instruction,'literal $(touch never)');assert.equal(body.id,id);assert.equal(body.task_number,undefined);
 assert.ok(!JSON.stringify(result).includes(key));assert.equal(result.id,id);assert.ok(!result.summary.includes(id));
});
test('Gemini queries by number and returns status result and error',async()=>{
 const m=mock();m.setRow({id,task_number:7,title:'Conferir ponte',status:'failed',result:'resultado',error:'erro legível'});
 const r=await m.client.get({identifier:'Tarefa 7 — Conferir ponte'});
 assert.equal(r.result,'resultado');assert.equal(r.error,'erro legível');assert.equal(r.status,'failed');assert.match(m.calls.at(-1).url,/task_number=eq.7/);
});
test('Gemini lists with bounded limit and status without exposing instructions',async()=>{
 const m=mock();m.setRow({id,task_number:1,title:'Teste',status:'running',instruction:'private',result:'large'});
 const r=await m.client.list({status:'running',limit:5});assert.equal(r.tasks.length,1);assert.match(m.calls.at(-1).url,/limit=5&status=eq.running/);assert.equal(r.tasks[0].instruction,undefined);assert.equal(r.tasks[0].result,undefined);
});
test('Gemini old schema preserves title locally and never modifies instruction',async()=>{
 const m=mock({legacy:true});const created=await m.client.create({title:'Título antigo',instruction:'original'});
 assert.equal(created.identifier,id);assert.equal(created.label,'Tarefa legada — Título antigo');assert.equal(created.legacy_schema,true);
 const b=JSON.parse(m.calls.find(c=>c.opts.method==='POST').opts.body);assert.equal(b.title,undefined);assert.equal(b.instruction,'original');
 const read=await m.client.get({identifier:id});assert.equal(read.title,'Título antigo');
 const list=await m.client.list({});assert.equal(list.tasks[0].title,'Título antigo');
});
test('Gemini legacy tasks without metadata have readable fallback',async()=>{
 const m=mock({legacy:true});m.setRow({id,status:'succeeded',result:'OK'});
 const r=await m.client.get({identifier:id});assert.equal(r.label,'Tarefa legada — Tarefa sem título');assert.equal(r.result,'OK');
 await assert.rejects(m.client.get({identifier:'1'}),e=>e.code==='legacy');
});
test('Gemini rejects injection, arbitrary HTTP/SQL and excessive limits before requests',async()=>{
 const m=mock();
 for(const args of [{identifier:'1&select=secret'},{identifier:'../secret'},{identifier:'1',url:'https://evil.invalid'}])await assert.rejects(m.client.get(args));
 for(const args of [{limit:51},{limit:-1},{status:'queued&delete=true'},{sql:'select *'}])await assert.rejects(m.client.list(args));
 for(const args of [{title:'',instruction:'ok'},{title:'ok',instruction:'x\0y'},{title:'ok',instruction:'x'.repeat(24001)},{title:'ok',instruction:'ok',status:'succeeded'}])await assert.rejects(m.client.create(args));
 assert.equal(m.calls.length,0);
});
test('Gemini ambiguous creation returns receipt and never repeats POST',async()=>{
 const m=mock({lost:true});await assert.rejects(m.client.create({title:'Teste',instruction:'ok'}),e=>e.code==='uncertain'&&e.identifier===id&&!e.message.includes(key));
 assert.equal(m.calls.filter(c=>c.opts.method==='POST').length,1);
 assert.equal((await m.client.get({identifier:id})).status,'queued');
});
test('Gemini explicit same receipt reconciles conflict without execution',async()=>{
 const m=mock({postStatus:409});const r=await m.client.create({title:'Teste',instruction:'ok',request_id:id});assert.equal(r.already_exists,true);assert.equal(m.calls.filter(c=>c.opts.method==='POST').length,1);
});
test('Gemini sanitizes service key echoed inside database data',async()=>{
 const m=mock();m.setRow({id,title:key,task_number:1,status:'failed',result:'prefix '+key,error:key,created_at:key});const r=await m.client.get({identifier:id});assert.ok(!JSON.stringify(r).includes(key));assert.match(r.result,/omitida/);
});
test('Gemini auth error does not fall back to legacy schema',async()=>{
 let count=0;const c=createClient({url:'https://example.invalid',key,fetch:async()=>{count++;return response({code:'42703'},401);}});
 await assert.rejects(c.create({title:'Test',instruction:'ok'}));assert.equal(count,1);
});
test('MCP initialize lists exactly three client tools without loading credentials',async()=>{
 let loaded=0;const handle=createProtocol(()=>{loaded++;throw Error(key);});
 const initial=await handle({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18'}});assert.equal(initial.result.protocolVersion,'2025-06-18');
 const list=await handle({jsonrpc:'2.0',id:2,method:'tools/list'});assert.equal(list.result.tools.length,3);assert.equal(loaded,0);
 const unknown=await handle({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'execute_sql'}});assert.equal(unknown.error.code,-32602);assert.equal(loaded,0);
});
test('MCP create get list exercise real client with mocked network',async()=>{
 const m=mock();const h=createProtocol(()=>m.client);await h({jsonrpc:'2.0',id:1,method:'initialize'});
 for(const [name,args] of [['bridge_create_task',{title:'Teste',instruction:'ok'}],['bridge_get_task',{identifier:'7'}],['bridge_list_tasks',{}]]){
  const r=await h({jsonrpc:'2.0',id:2,method:'tools/call',params:{name,arguments:args}});assert.equal(r.result.isError,false);assert.ok(!JSON.stringify(r).includes(key));
 }
});
test('MCP contains raw configuration errors and does not echo secrets',async()=>{
 const h=createProtocol(()=>{throw Error(key);});await h({jsonrpc:'2.0',id:1,method:'initialize'});
 const r=await h({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'bridge_list_tasks'}});assert.equal(r.result.isError,true);assert.ok(!JSON.stringify(r).includes(key));
});
test('Private credential reader rejects insecure permissions and persists private legacy metadata',t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-gemini-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));const dir=path.join(home,'.config/codex-bridge');fs.mkdirSync(dir,{recursive:true,mode:0o700});fs.chmodSync(dir,0o700);
 const secret=path.join(dir,'supabase-service-role.key');fs.writeFileSync(secret,key,{mode:0o600});fs.writeFileSync(path.join(home,'remote-config.json'),JSON.stringify({supabase:{url:'https://example.invalid'}}));
 const local=loadLocal(home,home);assert.equal(local.key,key);local.legacy.set(id,'Título');assert.equal(loadLocal(home,home).legacy.get(id),'Título');assert.equal(fs.statSync(path.join(dir,'gemini-titles',id+'.json')).mode&0o777,0o600);
 fs.chmodSync(secret,0o644);assert.throws(()=>loadLocal(home,home));fs.chmodSync(secret,0o600);fs.renameSync(secret,secret+'.original');fs.symlinkSync(secret+'.original',secret);assert.throws(()=>loadLocal(home,home));
});
test('MCP actual stdio handshake returns only JSON, without touching credentials',async()=>{
 const root=path.resolve(__dirname,'..');const child=spawn(process.execPath,[path.join(root,'integrations/gemini/entry.cjs')],{env:{PATH:process.env.PATH,HOME:os.tmpdir(),CODEX_BRIDGE_ROOT:root},stdio:['pipe','pipe','pipe']});
 let out='',err='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);
 const exit=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
 child.stdin.end(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05'}})+'\n'+JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n'+JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list'})+'\n');
 assert.equal(await exit,0);assert.equal(err,'');const rows=out.trim().split('\n').map(JSON.parse);assert.equal(rows.length,2);assert.equal(rows[1].result.tools.length,3);
});
test('Gemini extension declares only a public path setting and excludes native file/shell tools',()=>{
 const manifest=JSON.parse(fs.readFileSync(path.join(__dirname,'../integrations/gemini/gemini-extension.json'),'utf8'));
 assert.deepEqual(manifest.settings.map(s=>s.envVar),['CODEX_BRIDGE_ROOT']);assert.ok(manifest.excludeTools.includes('run_shell_command'));assert.ok(manifest.excludeTools.includes('read_file'));
 assert.equal(manifest.mcpServers['bridge-queue'].includeTools.length,3);assert.ok(!JSON.stringify(manifest).includes('SERVICE_ROLE'));
});
test('Gemini launcher removes inherited service credentials before exec',()=>{
 const {spawnSync}=require('node:child_process');
 const source="import importlib.util; s=importlib.util.spec_from_file_location('launch','integrations/gemini/run-gemini.py'); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); e=m.environment({'PATH':'safe','CODEX_SUPABASE_SERVICE_ROLE_KEY':'synthetic','SUPABASE_SERVICE_ROLE_KEY':'synthetic','SUPABASE_SECRET_KEY':'synthetic'}); assert e=={'PATH':'safe'}";
 const r=spawnSync('python3',['-B','-c',source],{cwd:path.join(__dirname,'..'),encoding:'utf8'});assert.equal(r.status,0,r.stderr);
});

test('Gemini exposes optional bounded progress safely without extra requests',async()=>{
 const m=mock();m.setRow({id,status:'running',progress_seq:9,last_flush_reason:'command_end',last_flush_line_count:3,progress_message:'Executando comando.',recent_output:'Authorization: Bearer hidden\n'+'safe line\n'.repeat(9000),last_progress_at:'2026-10-01T12:00:00Z'});
 const r=await m.client.get({identifier:id});assert.equal(r.progress_seq,'9');assert.equal(r.last_flush_reason,'command_end');assert.equal(r.last_flush_line_count,3);assert.equal(r.progress_truncated,true);assert.ok(r.recent_output.length<=64000);assert.ok(!r.recent_output.includes('hidden'));assert.equal(m.calls.length,1);
 m.setRow({id,status:'queued'});assert.equal((await m.client.get({identifier:id})).progress_seq,undefined);
});

test('Gemini creates named task from instruction alone and returns Portuguese summary',async()=>{
 const m=mock();const r=await m.client.create({instruction:'Execute ADB diagnostic'});assert.equal(r.task_name,'Diagnóstico ADB do BYD');assert.equal(r.status,'queued');assert.equal(r.status_label,'na fila');assert.equal(r.summary,'Tarefa 7 — Diagnóstico ADB do BYD — na fila');
});
test('Gemini task_name aliases title and cancelled remains English in API',async()=>{
 const m=mock();const r=await m.client.create({instruction:'hello',task_name:'Consultar central'});assert.equal(r.title,'Consultar central');assert.equal(JSON.parse(m.calls.find(c=>c.opts.method==='POST').opts.body).task_name,undefined);
 m.setRow({id,task_number:7,title:'Consultar central',status:'cancelled'});const read=await m.client.get({identifier:id});assert.equal(read.status,'cancelled');assert.equal(read.status_label,'cancelada');assert.ok(!read.summary.includes(id));await m.client.list({status:'cancelled'});
});
