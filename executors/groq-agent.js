'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const {defineExecutor}=require('./contract');
const {acquire}=require('./workspace-lock');
const {sanitizer}=require('../task-progress');
const {LIMITS,bounded,prepare}=require('./groq-context');
const MODELS=['openai/gpt-oss-20b','openai/gpt-oss-120b'];
const fail=(code,message)=>Object.assign(new Error(message),{kind:code});
const definitions=[['list_files',{path:{type:'string'}}],['read_file',{path:{type:'string'}}],['write_file',{path:{type:'string'},content:{type:'string'}}],['search',{path:{type:'string'},query:{type:'string'}}],['run_check',{name:{type:'string',enum:['tests','git_status','git_diff']}}]].map(([name,properties])=>({type:'function',function:{name,description:name,parameters:{type:'object',properties,required:Object.keys(properties),additionalProperties:false}}}));
// Optional character-range reads allow recovering truncated file content safely.
definitions.find(d=>d.function.name==='read_file').function.parameters.properties.offset={type:'integer',minimum:0,maximum:131072};
definitions.find(d=>d.function.name==='read_file').function.parameters.properties.length={type:'integer',minimum:1,maximum:4096};
// Exact Harmony artifact observed on GPT-OSS; no trimming, fuzzy matching or splitting.
function normalizeToolCall(call){
 const original=call?.function?.name;
 const definition=definitions.find(d=>original===d.function.name||original===d.function.name+'<|channel|>commentary');
 if(!definition)throw fail('permission','Ferramenta recusada');
 if(typeof call.id!=='string'||!call.id||call.type!=='function'||typeof call.function.arguments!=='string')throw fail('protocol','Chamada recusada');
 let args;try{args=JSON.parse(call.function.arguments);}catch{throw fail('protocol','Argumentos inválidos');}
 const schema=definition.function.parameters;
 if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!Object.hasOwn(schema.properties,k))||schema.required.some(k=>!Object.hasOwn(args,k)))throw fail('protocol','Argumentos inválidos');
 for(const [key,rule] of Object.entries(schema.properties)){
  if(!Object.hasOwn(args,key))continue;
  if((rule.type==='integer'?!Number.isSafeInteger(args[key])||args[key]<rule.minimum||args[key]>rule.maximum:typeof args[key]!==rule.type)||rule.enum&&!rule.enum.includes(args[key]))throw fail('permission','Argumento recusado');
 }
 return {id:call.id,type:'function',function:{name:definition.function.name,arguments:call.function.arguments}};
}
function createAgent({cwd,workspaceToken,model,apiKey,baseUrl,env=process.env,fetch:request=globalThis.fetch,timeoutMs=900000,maxIterations=24,classifyHttp}){
 if(!MODELS.includes(model))throw TypeError('Modelo agent Groq não suportado');
 if(env.GROQ_TRUSTED_WORKSPACE!=='1')throw TypeError('Agent exige GROQ_TRUSTED_WORKSPACE=1 para executar testes do repositório');
 if(!Number.isInteger(maxIterations)||maxIterations<1||maxIterations>100)throw TypeError('Limite de iterações inválido');
 const root=fs.realpathSync(cwd),clean=sanitizer({...env,GROQ_API_KEY:apiKey});
 const safe=s=>String(s).split(/\r?\n/).map(clean).join('\n');
 const api=baseUrl.replace(/\/$/,'');
 function target(p,write=false){
  if(typeof p!=='string'||p.length>512||p.includes('\0')||path.isAbsolute(p)||p.includes('\\'))throw fail('permission','Caminho recusado');
  const parts=p.split('/').filter(x=>x&&x!=='.');
  const protectedNames=new Set(['.git','.agents','.codex','.aws','.ssh','.config','.npmrc','.netrc','.gitconfig','.bashrc','.profile','.bridge-workspace-lock','.bridge-agent-home']);
  for(const [i,part] of parts.entries()){
   // Permit a plain dotfile at the root, never hidden directory traversal.
   const rootDotfile=parts.length===1&&i===0&&/^\.[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(part);
   if(part==='..'||protectedNames.has(part.toLowerCase())||part.startsWith('.')&&!rootDotfile||/^(node_modules|logs|state|supabase-state|pending-results|recovered-receipts)$/i.test(part)||/secret|credential|token|thread-id|\.env|\.pem$|\.key$/i.test(part))throw fail('permission','Caminho recusado');
  }
  const dest=path.resolve(root,...parts);
  if(dest!==root&&!dest.startsWith(root+path.sep)||write&&dest===root)throw fail('permission','Caminho recusado');
  let current=root;
  for(const part of parts){
   current=path.join(current,part);
   let st;try{st=fs.lstatSync(current);}catch(e){if(e.code==='ENOENT')continue;throw e;}
   if(st.isSymbolicLink()||!st.isFile()&&!st.isDirectory()||st.isFile()&&st.nlink!==1)throw fail('permission','Link recusado');
   if(part.startsWith('.')&&!st.isFile())throw fail('permission','Caminho recusado');
   const real=fs.realpathSync(current);
   if(real!==root&&!real.startsWith(root+path.sep))throw fail('permission','Caminho recusado');
  }
  return dest;
 }
 return defineExecutor({version:1,provider:{id:'groq'},async execute(input){
  let lease,answer='',uncertain=false,validated=false,edited=false,timed=false;
  const controller=new AbortController(),abort=()=>controller.abort();input.signal?.addEventListener('abort',abort,{once:true});if(input.signal?.aborted)abort();
  const timer=setTimeout(()=>{timed=true;abort();},timeoutMs);
  const emit=async text=>input.onProgress({type:'output',stream:'stdout',text:safe(text)+'\n'});
  function command(name){return new Promise((resolve,reject)=>{
   const specs={tests:['npm',['test']],git_status:['git',['--no-optional-locks','status','--short']],git_diff:['git',['--no-pager','diff','--no-ext-diff','--no-textconv']]};
   if(!Object.hasOwn(specs,name))return reject(fail('permission','Comando recusado'));
   const childEnv={};for(const k of ['PATH','PREFIX','TMPDIR','LANG','SYSTEMROOT'])if(env[k])childEnv[k]=env[k];
   childEnv.HOME=path.join(root,'.bridge-agent-home');childEnv.GIT_CONFIG_NOSYSTEM='1';childEnv.GIT_CONFIG_GLOBAL='/dev/null';childEnv.GIT_TERMINAL_PROMPT='0';
   const [exe,args]=specs[name];let text='',ended=false;
   const child=spawn(exe,args,{cwd:root,env:childEnv,shell:false,detached:true,stdio:['ignore','pipe','pipe']});
   const stop=()=>{if(ended)return;uncertain=true;try{process.kill(-child.pid,'SIGKILL');}catch{}reject(Object.assign(fail('cancelled','Comando interrompido; workspace requer verificação'),{output:safe(text)}));};
   controller.signal.addEventListener('abort',stop,{once:true});if(controller.signal.aborted)stop();
   const collect=b=>{text+=b.toString();if(Buffer.byteLength(text)>262144){stop();}};
   child.stdout.on('data',collect);child.stderr.on('data',collect);
   child.on('error',()=>{ended=true;controller.signal.removeEventListener('abort',stop);reject(fail('execution','Não foi possível iniciar comando'));});
   child.on('close',code=>{ended=true;controller.signal.removeEventListener('abort',stop);resolve({code,text:safe(text)});});
  });}
  async function tool(call){
   const name=call.function?.name;if(typeof call.id!=='string'||call.type!=='function'||typeof call.function?.arguments!=='string'||safe(call.function.arguments)!==call.function.arguments)throw fail('protocol','Chamada recusada');let a;try{a=JSON.parse(call.function.arguments);}catch{throw fail('protocol','Argumentos inválidos');}
   if(!a||Array.isArray(a)||typeof a!=='object')throw fail('protocol','Argumentos inválidos');
   let out;
   if(name==='list_files')out=fs.readdirSync(target(a.path)).filter(x=>!x.startsWith('.')&&!/secret|credential|token/i.test(x)).slice(0,500).join('\n');
   else if(name==='read_file'){const p=target(a.path),st=fs.statSync(p);if(!st.isFile()||st.size>1048576)throw fail('permission','Arquivo excede limite');const text=fs.readFileSync(p,'utf8');out=a.offset!==undefined||a.length!==undefined?Array.from(text).slice(a.offset||0,(a.offset||0)+(a.length||256)).join(''):text;}
   else if(name==='write_file'){if(typeof a.content!=='string'||Buffer.byteLength(a.content)>131072||safe(a.content)!==a.content)throw fail('permission','Conteúdo recusado');fs.writeFileSync(target(a.path,true),a.content,{flag:'w',mode:0o600});edited=true;validated=false;out='Arquivo atualizado';}
   else if(name==='search'){
    const base=target(a.path);
    if(typeof a.query!=='string'||!a.query||a.query.length>256)throw fail('permission','Consulta recusada');
    const hits=[];
    function walk(dir){
     if(hits.length>=200)return;
     let entries;
     try{entries=fs.readdirSync(dir,{withFileTypes:true});}catch{return;}
     for(const e of entries){
      if(hits.length>=200)break;
      if(e.name.startsWith('.')||['node_modules','logs','state','supabase-state'].includes(e.name))continue;
      if(/secret|credential|token|receipt|\.env|\.pem$|\.key$/i.test(e.name))continue;
      const fp=path.join(dir,e.name);
      if(e.isDirectory()){walk(fp);continue;}
      if(!e.isFile())continue;
      let st;try{st=fs.statSync(fp);}catch{continue;}
      if(st.size>131072)continue;
      let txt;try{txt=fs.readFileSync(fp,'utf8');}catch{continue;}
      const lines=txt.split(/\r?\n/);
      for(let i=0;i<lines.length&&hits.length<200;i++){
       if(lines[i].includes(a.query)){
        hits.push(path.relative(root,fp)+':'+(i+1)+': '+safe(lines[i]).slice(0,300));
       }
      }
     }
    }
    const st=fs.statSync(base);
    if(st.isDirectory())walk(base);
    else{
     const txt=fs.readFileSync(base,'utf8');
     txt.split(/\r?\n/).forEach((line,i)=>{if(hits.length<200&&line.includes(a.query))hits.push(path.relative(root,base)+':'+(i+1)+': '+safe(line).slice(0,300));});
    }
    out=hits.join('\n')||'Nenhuma ocorrência encontrada';
   }
   else if(name==='run_check'){let r;try{r=await command(a.name);}catch(e){if(typeof e.output==='string'){await emit(e.output);await input.onProgress({type:'command_end',code:null});}throw e;}await emit(r.text);await input.onProgress({type:'command_end',code:r.code});if(r.code!==0)throw fail('execution','Verificação falhou');if(a.name==='tests')validated=true;out=r.text||'Verificação concluída';}
   else throw fail('permission','Ferramenta recusada');
   await emit('Ferramenta: '+name);return bounded(safe(out),LIMITS.tool);
  }
  try{
   lease=acquire(root,workspaceToken);
   const messages=[{role:'system',content:'Você é um agente de engenharia de software autorizado pelo proprietário deste workspace a inspecionar e modificar os arquivos do projeto exclusivamente por meio das ferramentas fornecidas nesta sessão. Para tarefas sobre recibos, estado, filas ou arquivos privados, NÃO tente acessar diretórios reais como supabase-state, state, logs, .config ou receipts. Em vez disso, inspecione apenas o código-fonte e os testes do projeto e crie fixtures/mocks dentro da suíte de testes para reproduzir o comportamento de forma segura. Use list_files, read_file, write_file e run_check quando necessário. Essas operações são esperadas e autorizadas para manutenção do próprio projeto. Não recuse uma tarefa apenas porque ela envolve editar código, corrigir testes, analisar git status/diff ou executar npm test. Não acesse segredos, credenciais, arquivos protegidos, rede externa, shell arbitrário ou recursos fora das ferramentas disponíveis. Não faça commits ou push diretamente. Se a instrução pedir uma etapa que não existe nas ferramentas disponíveis, execute todas as partes possíveis da tarefa, valide as alterações e explique objetivamente no resultado final apenas a etapa externa que ficou pendente. Execute tests depois da última edição. Só finalize quando a parte executável da tarefa estiver concluída e validada. Saídas marcadas TRUNCADA são parciais: releia arquivos com read_file offset/length antes de editar; nunca reconstrua um arquivo com base em um trecho incompleto.'},{role:'user',content:safe(input.instruction)}];
   for(let i=0;i<maxIterations;i++){
    if(controller.signal.aborted)throw fail('cancelled','Execução interrompida');
    const prepared=prepare(messages,{model,tools:definitions,tool_choice:'auto',parallel_tool_calls:false,stream:false,...(model==='openai/gpt-oss-20b'?{disable_tool_validation:true}:{})},validated);
    await emit(JSON.stringify({...prepared.metrics,iteration:i+1}));
    const r=await request((api.endsWith('/v1')?api:api+'/v1')+'/chat/completions',{method:'POST',redirect:'error',signal:controller.signal,headers:{'Content-Type':'application/json',Authorization:'Bearer '+apiKey},body:prepared.body});
    let raw='',bytes=0;const decoder=new TextDecoder();for await(const b of r.body){bytes+=b.byteLength;if(bytes>1048576)throw fail('protocol','Resposta excedeu limite');raw+=decoder.decode(b,{stream:true});}raw+=decoder.decode();
    let data;try{data=JSON.parse(raw);}catch{if(r.ok)throw fail('protocol','Resposta inválida');data={};}
    if(!r.ok){const e=classifyHttp(r.status,data,r.headers);throw fail(e.code,e.message);}
    const c=data.choices?.[0],m=c?.message;if(!m||m.function_call||m.tool_calls&&!Array.isArray(m.tool_calls))throw fail('protocol','Resposta sem mensagem válida');
    if(m.content){answer=safe(m.content);await emit(answer);}
    if(m.tool_calls?.length){if(c.finish_reason!=='tool_calls'||m.tool_calls.length>8)throw fail('protocol','Chamada inválida');const calls=m.tool_calls.map(normalizeToolCall);if(new Set(calls.map(call=>call.id)).size!==calls.length)throw fail('protocol','IDs de ferramentas duplicados');messages.push({role:'assistant',content:typeof m.content==='string'?bounded(safe(m.content),LIMITS.assistant):null,tool_calls:calls});for(const call of calls){if(controller.signal.aborted)throw fail('cancelled','Execução interrompida');const output=await tool(call);messages.push({role:'tool',tool_call_id:call.id,content:output});}continue;}
    if(c.finish_reason!=='stop'||typeof m.content!=='string'||!m.content.trim()||(edited&&!validated))throw fail('execution','Conclusão sem validação bem-sucedida');
    if(controller.signal.aborted)throw fail('cancelled','Execução interrompida');
    lease.release();return {provider:'groq',session:{provider:'groq',id:null,state:'completed'},status:'completed',answer,error:null,workspaceReleased:true};
   }
   throw fail('execution','Limite de iterações atingido');
  }catch(e){if(lease){if(uncertain)lease.retain();else lease.release();}const status=uncertain?'uncertain':controller.signal.aborted&&!timed?'cancelled':'failed';return {provider:'groq',session:{provider:'groq',id:null,state:status},status,answer,error:{code:timed?'timeout':controller.signal.aborted?'cancelled':e.kind||(e instanceof TypeError?'network':'execution'),message:e.kind?safe(e.message):'Falha no agent Groq',retryable:false},workspaceReleased:!uncertain};}
  finally{clearTimeout(timer);input.signal?.removeEventListener('abort',abort);}
 }});
}
module.exports={createAgent,MODELS};
