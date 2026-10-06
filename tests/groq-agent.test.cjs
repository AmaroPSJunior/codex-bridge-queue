'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createGroqExecutor}=require('../executors/groq');
const call=(name,args)=>({choices:[{finish_reason:'tool_calls',message:{content:null,tool_calls:[{id:'t',type:'function',function:{name,arguments:JSON.stringify(args)}}]}}]});
const done={choices:[{finish_reason:'stop',message:{content:'Concluído'}}]};
async function fixture(t,steps,options={}){
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'groq-agent-'));t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));
 fs.writeFileSync(path.join(cwd,'package.json'),JSON.stringify({scripts:{test:'node -e "process.exit(0)"'}}));
 let requests=[];const events=[];
 const executor=createGroqExecutor({cwd,env:{PATH:process.env.PATH,PREFIX:process.env.PREFIX,TMPDIR:os.tmpdir(),GROQ_TRUSTED_WORKSPACE:'1'},mode:'agent',apiKey:'mock-key',model:'openai/gpt-oss-20b',fetch:async(url,o)=>{requests.push(JSON.parse(o.body));return new Response(JSON.stringify(steps.shift()||done));},...options});
 const run=()=>executor.execute({instruction:'Alterar arquivo e validar',onProgress:async e=>events.push(e)});
 return {cwd,requests,events,run};
}
test('agent edita, valida, termina e libera lock nos dois modelos',async t=>{
 for(const model of ['openai/gpt-oss-20b','openai/gpt-oss-120b']){
 const f=await fixture(t,[call('write_file',{path:'example.js',content:'module.exports=42;'}),call('read_file',{path:'example.js'}),call('run_check',{name:'tests'}),done],{model});
 const r=await f.run();assert.equal(r.status,'completed');assert.equal(fs.readFileSync(path.join(f.cwd,'example.js'),'utf8'),'module.exports=42;');assert.equal(fs.existsSync(path.join(f.cwd,'.bridge-workspace-lock')),false);assert.ok(f.events.some(e=>e.type==='command_end'&&e.code===0));assert.equal(f.requests[0].model,model);
 }
});
test('agent permite sucesso textual sem validação quando não houve edição',async t=>{const f=await fixture(t,[done]);assert.equal((await f.run()).status,'completed');});
test('agent recusa comando arbitrário e traversal',async t=>{for(const step of [call('run_check',{name:'rm -rf /'}),call('write_file',{path:'../escape',content:'x'}),call('read_file',{path:'.env'})]){const f=await fixture(t,[step]);assert.equal((await f.run()).error.code,'permission');}});
test('agent limite de iterações e validação invalidada por edição',async t=>{const f=await fixture(t,[call('list_files',{path:''})],{maxIterations:1});assert.match((await f.run()).error.message,/iterações/);const g=await fixture(t,[call('run_check',{name:'tests'}),call('write_file',{path:'x',content:'x'}),done]);assert.equal((await g.run()).status,'failed');});
test('agent testes falhos nunca viram sucesso',async t=>{const f=await fixture(t,[call('run_check',{name:'tests'}),done]);fs.writeFileSync(path.join(f.cwd,'package.json'),JSON.stringify({scripts:{test:'node -e "process.exit(1)"'}}));assert.equal((await f.run()).status,'failed');});
test('agent recusa symlink e hardlink',async t=>{for(const hard of [false,true]){const f=await fixture(t,[call('read_file',{path:'link'})]);fs.writeFileSync(path.join(f.cwd,'source'),'x');try{fs[hard?'linkSync':'symlinkSync'](path.join(f.cwd,'source'),path.join(f.cwd,'link'));}catch(e){if(hard&&['EACCES','EPERM'].includes(e.code)){t.diagnostic('Hardlink indisponível no filesystem; verificação por symlink executada');continue;}throw e;}assert.equal((await f.run()).error.code,'permission');}});
test('agent exige opt-in confiável e modelo reconhecido',()=>{assert.throws(()=>createGroqExecutor({env:{},mode:'agent',apiKey:'x'}),/TRUSTED/);assert.throws(()=>createGroqExecutor({env:{GROQ_TRUSTED_WORKSPACE:'1'},mode:'agent',apiKey:'x',model:'unknown'}),/Modelo/);});
test('agent redação antes de enviar conteúdo de arquivo',async t=>{const f=await fixture(t,[call('read_file',{path:'example.txt'}),done]);fs.writeFileSync(path.join(f.cwd,'example.txt'),'mock-key');await f.run();assert.ok(!JSON.stringify(f.requests).includes('mock-key'));});
test('agent cancelamento prévio não chama rede nem altera arquivo',async t=>{const f=await fixture(t,[]);const c=new AbortController();c.abort();const executor=createGroqExecutor({cwd:f.cwd,env:{GROQ_TRUSTED_WORKSPACE:'1'},apiKey:'x',mode:'agent',fetch:()=>{throw Error('unexpected');}});assert.equal((await executor.execute({instruction:'x',signal:c.signal})).status,'cancelled');});
test('agent timeout HTTP termina sem falso sucesso',async t=>{const f=await fixture(t,[],{timeoutMs:25,fetch:async(u,o)=>new Promise((resolve,reject)=>{o.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});})});const r=await f.run();assert.equal(r.status,'failed');assert.equal(r.error.code,'timeout');assert.equal(r.workspaceReleased,true);});
test('agent respeita lock existente',async t=>{const f=await fixture(t,[]);const lease=require('../executors/workspace-lock').acquire(f.cwd);try{assert.equal((await f.run()).status,'failed');assert.equal(f.requests.length,0);}finally{lease.release();}});
test('agent classifica HTTP sem repassar corpo privado',async t=>{const f=await fixture(t,[],{fetch:async()=>new Response(JSON.stringify({error:{code:'rate_limit',message:'private'}}),{status:429})});const r=await f.run();assert.equal(r.error.code,'rate_limit');assert.ok(!r.error.message.includes('private'));});
test('agent interrompe grupo de comando e mantém fence incerto',async t=>{const f=await fixture(t,[call('run_check',{name:'tests'})],{timeoutMs:250});fs.writeFileSync(path.join(f.cwd,'package.json'),JSON.stringify({scripts:{test:'node -e "setTimeout(()=>{},10000)"'}}));const r=await f.run();assert.equal(r.status,'uncertain');assert.equal(r.workspaceReleased,false);assert.equal(r.error.code,'timeout');assert.ok(fs.existsSync(path.join(f.cwd,'.bridge-workspace-lock')));assert.ok(f.events.some(e=>e.type==='command_end'));});
test('agent arquivo editado mantém shell metacharacters literais',async t=>{const content='$(touch should-not-exist); `echo not-a-command`';const f=await fixture(t,[call('write_file',{path:'literal.txt',content}),call('run_check',{name:'tests'}),done]);assert.equal((await f.run()).status,'completed');assert.equal(fs.readFileSync(path.join(f.cwd,'literal.txt'),'utf8'),content);assert.equal(fs.existsSync(path.join(f.cwd,'should-not-exist')),false);});

test('agent permite arquivo relativo e dotfile simples na raiz, inclusive ./',async t=>{
 const steps=[];for(const p of ['plain.txt','.groq-agent-smoke.txt','./.another-smoke.txt'])steps.push(call('write_file',{path:p,content:'OK'}),call('read_file',{path:p}));
 const f=await fixture(t,[...steps,call('run_check',{name:'tests'}),done]);
 assert.equal((await f.run()).status,'completed');
 for(const p of ['plain.txt','.groq-agent-smoke.txt','.another-smoke.txt'])assert.equal(fs.readFileSync(path.join(f.cwd,p),'utf8'),'OK');
});
test('agent permite arquivo em subdiretório existente',async t=>{
 const f=await fixture(t,[call('write_file',{path:'src/example.txt',content:'OK'}),call('read_file',{path:'./src/example.txt'}),call('run_check',{name:'tests'}),done]);
 fs.mkdirSync(path.join(f.cwd,'src'));assert.equal((await f.run()).status,'completed');assert.equal(fs.readFileSync(path.join(f.cwd,'src/example.txt'),'utf8'),'OK');
});
test('agent recusa traversal inclusive quando normalização ficaria dentro da raiz',async t=>{
 for(const p of ['../escape','src/../../escape','src/../inside.txt']){const f=await fixture(t,[call('write_file',{path:p,content:'changed'})]);assert.equal((await f.run()).error.code,'permission');assert.equal(fs.existsSync(path.join(f.cwd,'inside.txt')),false);}
});
test('agent recusa caminho absoluto externo sem alterar arquivo',async t=>{
 const outside=fs.mkdtempSync(path.join(os.tmpdir(),'groq-outside-'));t.after(()=>fs.rmSync(outside,{recursive:true,force:true}));const p=path.join(outside,'file.txt');fs.writeFileSync(p,'original');
 const f=await fixture(t,[call('write_file',{path:'/'+p.split('/').filter(Boolean).join('/./'),content:'changed'})]);assert.equal((await f.run()).error.code,'permission');assert.equal(fs.readFileSync(p,'utf8'),'original');
});
test('agent recusa symlink escape em arquivo e diretório para leitura e escrita',async t=>{
 const outside=fs.mkdtempSync(path.join(os.tmpdir(),'groq-outside-'));t.after(()=>fs.rmSync(outside,{recursive:true,force:true}));fs.writeFileSync(path.join(outside,'file.txt'),'original');
 for(const name of ['read_file','write_file'])for(const directory of [false,true]){
  const p=directory?'link/file.txt':'.groq-agent-smoke.txt';const f=await fixture(t,[call(name,{path:p,...(name==='write_file'?{content:'changed'}:{})})]);
  fs.symlinkSync(directory?outside:path.join(outside,'file.txt'),path.join(f.cwd,directory?'link':p));
  assert.equal((await f.run()).error.code,'permission');assert.equal(fs.readFileSync(path.join(outside,'file.txt'),'utf8'),'original');
 }
});
test('agent mantém arquivos sensíveis e diretórios ocultos protegidos',async t=>{
 for(const p of ['.env','.env.local','.npmrc','.gitconfig','.git/config','.codex/config.toml','.bridge-workspace-lock/owner.json','.hidden/file.txt']){const f=await fixture(t,[call('read_file',{path:p})]);assert.equal((await f.run()).error.code,'permission');}
 const f=await fixture(t,[call('list_files',{path:'.hidden'})]);fs.mkdirSync(path.join(f.cwd,'.hidden'));assert.equal((await f.run()).error.code,'permission');
});

test('agent HTTP 400 preserva diagnóstico sanitizado sem headers ou failed_generation',async t=>{
 const f=await fixture(t,[],{fetch:async()=>new Response(JSON.stringify({error:{code:'tool_use_failed',type:'invalid_request_error',param:'tools',message:'Failed to call a function. Adjust the arguments.\nmock-key\nAuthorization: Bearer private-value',failed_generation:'private generated instruction'},headers:{authorization:'private-header'}}),{status:400,headers:{'x-private':'private-header'}})});
 const r=await f.run();assert.equal(r.status,'failed');assert.equal(r.error.code,'http');
 assert.match(r.error.message,/HTTP 400/);assert.match(r.error.message,/code=tool_use_failed/);assert.match(r.error.message,/param=tools/);assert.match(r.error.message,/Adjust the arguments/);
 for(const hidden of ['mock-key','private-value','private-header','private generated instruction','failed_generation'])assert.ok(!JSON.stringify(r).includes(hidden));
 assert.equal(r.workspaceReleased,true);assert.equal(fs.existsSync(path.join(f.cwd,'.bridge-workspace-lock')),false);
});
test('agent HTTP 400 não JSON permanece erro seguro e não repete chamada',async t=>{
 let count=0;const f=await fixture(t,[],{fetch:async()=>{count++;return new Response('private raw server body',{status:400});}});const r=await f.run();assert.equal(r.status,'failed');assert.equal(r.error.code,'http');assert.equal(count,1);assert.ok(!r.error.message.includes('private raw'));
});
test('agent 20B usa payload explícito compatível e encadeia resultados de ferramentas',async t=>{
 const f=await fixture(t,[call('write_file',{path:'.groq-agent-smoke.txt',content:'OK'}),call('run_check',{name:'tests'}),done]);assert.equal((await f.run()).status,'completed');
 for(const p of f.requests){assert.equal(p.model,'openai/gpt-oss-20b');assert.equal(p.tool_choice,'auto');assert.equal(p.stream,false);assert.equal(p.parallel_tool_calls,false);assert.deepEqual(Object.keys(p).sort(),['disable_tool_validation','messages','model','parallel_tool_calls','stream','tool_choice','tools']);for(const tool of p.tools){assert.equal(tool.type,'function');assert.equal(tool.function.parameters.type,'object');assert.equal(tool.function.parameters.additionalProperties,false);assert.deepEqual(tool.function.parameters.required,tool.function.name==='read_file'?['path']:Object.keys(tool.function.parameters.properties));}}
 assert.equal(f.requests[1].messages[2].role,'assistant');assert.equal(f.requests[1].messages[3].role,'tool');assert.equal(f.requests[1].messages[3].tool_call_id,f.requests[1].messages[2].tool_calls[0].id);
 assert.equal(fs.readFileSync(path.join(f.cwd,'.groq-agent-smoke.txt'),'utf8'),'OK');
});

test('20B normaliza apenas canal commentary conhecido e serializa nome canônico',async t=>{
 const f=await fixture(t,[call('run_check<|channel|>commentary',{name:'tests'}),done]);
 assert.equal((await f.run()).status,'completed');assert.equal(f.requests[0].disable_tool_validation,true);
 assert.equal(f.requests[1].messages[2].tool_calls[0].function.name,'run_check');
 assert.equal(f.requests[1].messages[3].tool_call_id,'t');
 assert.ok(f.requests[0].tools.every(t=>!t.function.name.includes('<|')));
});
test('run_check puro funciona e 120B mantém validação remota padrão',async t=>{
 const f=await fixture(t,[call('run_check',{name:'tests'}),done],{model:'openai/gpt-oss-120b'});assert.equal((await f.run()).status,'completed');assert.equal(Object.hasOwn(f.requests[0],'disable_tool_validation'),false);
});
test('nomes desconhecidos e sufixos/prefixos não autorizados não executam',async t=>{
 for(const name of ['shell','shell<|channel|>commentary','run_check<|channel|>analysis','run_check<|channel|>commentary;rm','run_check<|channel|>commentary<|channel|>commentary','prefix_run_check','run_check_suffix',' run_check','run_check ']){
  const f=await fixture(t,[call(name,{name:'tests'})]);const r=await f.run();assert.equal(r.status,'failed');assert.equal(r.error.code,'permission');assert.ok(!f.events.some(e=>e.type==='command_end'));assert.equal(f.requests.length,1);
 }
});
test('normalização não amplia comandos, schema nem acesso a arquivos',async t=>{
 for(const [name,args] of [['run_check<|channel|>commentary',{name:'shell'}],['run_check<|channel|>commentary',{name:'tests',command:'rm'}],['run_check<|channel|>commentary',{}],['run_check<|channel|>commentary',{name:12}],['write_file<|channel|>commentary',{path:'../escape',content:'x'}],['write_file<|channel|>commentary',{path:'.git/config',content:'x'}]]){
  const f=await fixture(t,[call(name,args)]);assert.equal((await f.run()).status,'failed');assert.ok(!f.events.some(e=>e.type==='command_end'));
 }
});
test('batch inteiro validado antes da primeira ferramenta e 429 nunca é reinterpretado',async t=>{
 const batch=call('write_file',{path:'must-not-exist',content:'x'});batch.choices[0].message.tool_calls.push({id:'other',type:'function',function:{name:'unknown',arguments:'{}'}});
 const f=await fixture(t,[batch]);assert.equal((await f.run()).status,'failed');assert.equal(fs.existsSync(path.join(f.cwd,'must-not-exist')),false);
 let n=0;const g=await fixture(t,[],{fetch:async()=>{n++;return new Response(JSON.stringify({error:{code:'tool_use_failed',failed_generation:'run_check<|channel|>commentary'}}),{status:429});}});assert.equal((await g.run()).error.code,'rate_limit');assert.equal(n,1);
});

test('413 classificado separadamente e sem retry, inclusive corpo com quota',async t=>{
 let n=0;const f=await fixture(t,[],{fetch:async()=>{n++;return new Response(JSON.stringify({error:{code:'quota_exceeded'}}),{status:413});}});const r=await f.run();assert.equal(r.error.code,'payload_too_large');assert.equal(r.status,'failed');assert.equal(n,1);assert.equal(r.workspaceReleased,true);
});
test('20B limita resultados, permite reler por faixa e publica métricas numéricas',async t=>{
 const f=await fixture(t,[call('read_file',{path:'large.txt'}),call('read_file',{path:'large.txt',offset:0,length:20}),call('run_check',{name:'tests'}),done]);fs.writeFileSync(path.join(f.cwd,'large.txt'),'linha de teste\n'.repeat(4000));const r=await f.run();assert.equal(r.status,'completed');assert.match(f.requests[1].messages.at(-1).content,/SAÍDA TRUNCADA/);assert.equal(f.requests[2].messages.at(-1).content,('linha de teste\n'.repeat(2)).slice(0,20));
 for(const p of f.requests){assert.ok(Buffer.byteLength(JSON.stringify(p))<=12*1024);for(const m of p.messages)if(m.role==='tool')assert.ok(Buffer.byteLength(JSON.stringify(m.content))<=2048);}
 const metrics=f.events.filter(e=>e.type==='output'&&e.text.startsWith('{"event":"groq_payload"')).map(e=>JSON.parse(e.text));assert.equal(metrics.length,f.requests.length);for(const [i,m] of metrics.entries()){assert.equal(m.bytes,Buffer.byteLength(JSON.stringify(f.requests[i])));assert.ok(!JSON.stringify(m).includes('mock-key'));}
});
test('saída grande de testes é truncada só no contexto, preservando progress e exit code',async t=>{
 const f=await fixture(t,[call('run_check',{name:'tests'}),done]);fs.writeFileSync(path.join(f.cwd,'check.cjs'),"console.log('linha de teste\\n'.repeat(6000));\n");fs.writeFileSync(path.join(f.cwd,'package.json'),JSON.stringify({scripts:{test:'node check.cjs'}}));assert.equal((await f.run()).status,'completed');assert.match(f.requests[1].messages.at(-1).content,/SAÍDA TRUNCADA/);assert.ok(f.events.some(e=>e.type==='output'&&e.text.length>60000));assert.ok(f.events.some(e=>e.type==='command_end'&&e.code===0));
});
