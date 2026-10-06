'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const {defineExecutor}=require('./contract');
const {acquire}=require('./workspace-lock');
const {sanitizer}=require('../task-progress');
const {LIMITS,bounded,prepare}=require('./groq-context');
const {createSafeCommandRunner}=require('./safe-command');
const MODELS=[];
const fail=(code,message)=>Object.assign(new Error(message),{kind:code});
const TOOL_DESCRIPTIONS={
 list_files:'Use somente para listar DIRETÓRIO. Exemplo: {"path":"executors"}. Arquivo conhecido deve usar read_file.',
 read_file:'Use somente para ler ARQUIVO conhecido. Exemplo: {"path":"executors/local-agent.js"}. Não use em diretório.',
 write_file:'Cria ou substitui arquivo comum. Nunca use em package.json.',
 set_package_script:'Cria ou altera script npm em package.json.',
 remove_package_script:'Remove script npm de package.json.',
 search:'Procura texto dentro de arquivo ou diretório.',
 run_check:'Executa tests, git_status ou git_diff.',
 run_command:'Executa npm, npx, node ou git sem shell.'
};

const definitions=[
 ['list_files',{path:{type:'string'}}],
 ['read_file',{path:{type:'string'}}],
 ['write_file',{path:{type:'string'},content:{type:'string'}}],
 ['set_package_script',{name:{type:'string'},command:{type:'string'}}],
 ['remove_package_script',{name:{type:'string'}}],
 ['search',{path:{type:'string'},query:{type:'string'}}],
 ['run_check',{name:{type:'string',enum:['tests','git_status','git_diff']}}],
 ['run_command',{command:{type:'string',enum:['npm','npx','node','git']},args:{type:'array',items:{type:'string'},maxItems:64}}]
].map(([name,properties])=>({
 type:'function',
 function:{
  name,
  description:TOOL_DESCRIPTIONS[name],
  parameters:{type:'object',properties,required:Object.keys(properties),additionalProperties:false}
 }
}));

definitions.find(d=>d.function.name==='read_file').function.parameters.properties.offset={type:'integer',minimum:0,maximum:131072};
definitions.find(d=>d.function.name==='read_file').function.parameters.properties.length={type:'integer',minimum:1,maximum:4096};

function routeTools(instruction){
 const text=String(instruction||'').toLowerCase();
 const names=new Set(['list_files','read_file','search','run_check']);

 if(/crie|criar|edite|editar|altere|alterar|corrija|corrigir|implemente|implementar|remova|remover|arquivo|código|codigo|função|funcao/.test(text))
  names.add('write_file');

 if(/package\.json|script npm|npm script|set_package_script|remove_package_script/.test(text)){
  names.add('set_package_script');
  names.add('remove_package_script');
 }

 if(/npm|npx|node|git|teste|testes|test|execute|executar|comando|validar|valide/.test(text))
  names.add('run_command');

 return definitions.filter(d=>names.has(d.function.name));
}

function workspaceInventory(root){
 try{
  return fs.readdirSync(root,{withFileTypes:true})
   .filter(e=>
    !e.name.startsWith('.') &&
    !['node_modules','logs','state','supabase-state'].includes(e.name) &&
    !/secret|credential|token|receipt|\.env|\.pem$|\.key$/i.test(e.name)
   )
   .slice(0,40)
   .map(e=>e.name+(e.isDirectory()?'/':''))
   .join(', ')||'(workspace vazio)';
 }catch{
  return '(inventário indisponível)';
 }
}
// Exact Harmony artifact observed on GPT-OSS; no trimming, fuzzy matching or splitting.
function normalizeToolCall(call,allowedDefinitions=definitions){
 const original=call?.function?.name;
 const definition=allowedDefinitions.find(d=>original===d.function.name||original===d.function.name+'<|channel|>commentary');
 if(!definition)throw fail('permission','Ferramenta recusada');
 if(typeof call.id!=='string'||!call.id||call.type!=='function'||typeof call.function.arguments!=='string')throw fail('protocol','Chamada recusada');
 let args;try{args=JSON.parse(call.function.arguments);}catch{throw fail('protocol','Argumentos inválidos');}
 const schema=definition.function.parameters;
 if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!Object.hasOwn(schema.properties,k))||schema.required.some(k=>!Object.hasOwn(args,k)))throw fail('protocol','Argumentos inválidos');
 for(const [key,rule] of Object.entries(schema.properties)){
  if(!Object.hasOwn(args,key))continue;
  if(rule.type==='array'){
    if(!Array.isArray(args[key])||
       args[key].length>(rule.maxItems||64)||
       args[key].some(v=>typeof v!=='string'))
      throw fail('permission','Argumento recusado');
   }else if(
    (rule.type==='integer'
      ? !Number.isSafeInteger(args[key])||args[key]<rule.minimum||args[key]>rule.maximum
      : typeof args[key]!==rule.type)||
    rule.enum&&!rule.enum.includes(args[key])
   )throw fail('permission','Argumento recusado');
 }
 return {id:call.id,type:'function',function:{name:definition.function.name,arguments:call.function.arguments}};
}
function createAgent({cwd,workspaceToken,model,apiKey,baseUrl,env=process.env,fetch:request=globalThis.fetch,timeoutMs=900000,maxIterations=24,classifyHttp=(status)=>({
 code:status===429?'rate_limit':'http',
 message:'Servidor local retornou HTTP '+status+'.',
 retryable:status===429||status>=500
})}){
 if(typeof model!=='string'||!model.trim()||model.length>256)throw TypeError('Modelo agent local inválido');
 if(env.LOCAL_AI_TRUSTED_WORKSPACE!=='1')throw TypeError('Agent exige LOCAL_AI_TRUSTED_WORKSPACE=1 para executar testes do repositório');
 if(!Number.isInteger(maxIterations)||maxIterations<1||maxIterations>100)throw TypeError('Limite de iterações inválido');
 const root=fs.realpathSync(cwd),clean=sanitizer({...env,LOCAL_AI_API_KEY:apiKey});
 const safe=s=>String(s).split(/\r?\n/).map(clean).join('\n');
 const runSafeCommand=createSafeCommandRunner({
  cwd:root,
  env,
  timeoutMs:120000,
  maxOutputBytes:262144,
  allowGitCommit:env.LOCAL_AI_ALLOW_GIT_COMMIT==='1'
 });
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
 return defineExecutor({version:1,provider:{id:'local'},async execute(input){
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
  let lastCommandFailure=null,repeatedCommandFailures=0,rejectedToolCalls=0,repeatedCompaction=0;
  async function tool(call){
   const name=call.function?.name;if(typeof call.id!=='string'||call.type!=='function'||typeof call.function?.arguments!=='string'||safe(call.function.arguments)!==call.function.arguments)throw fail('protocol','Chamada recusada');let a;try{a=JSON.parse(call.function.arguments);}catch{throw fail('protocol','Argumentos inválidos');}
   if(!a||Array.isArray(a)||typeof a!=='object')throw fail('protocol','Argumentos inválidos');
   let out;

   if(['list_files','read_file','search'].includes(name)){
    const checked=target(a.path);
    let checkedStat;

    try{checkedStat=fs.statSync(checked);}
    catch(e){
     if(e.code==='ENOENT')
      throw fail('execution','Caminho inexistente: '+a.path+'. A raiz do workspace é ".". Entradas disponíveis: '+workspaceInventory(root)+'. Use list_files com path "." ou um diretório listado.');
     throw e;
    }

    if(name==='list_files'&&!checkedStat.isDirectory())
     throw fail('execution','Caminho incompatível com a ferramenta escolhida: list_files requer DIRETÓRIO; "'+a.path+'" é arquivo. Use read_file.');

    if(name==='read_file'&&!checkedStat.isFile())
     throw fail('execution','Caminho incompatível com a ferramenta escolhida: read_file requer ARQUIVO; "'+a.path+'" é diretório. Use list_files.');
   }

   if(name==='list_files')out=fs.readdirSync(target(a.path)).filter(x=>!x.startsWith('.')&&!/secret|credential|token/i.test(x)).slice(0,500).join('\n');
   else if(name==='read_file'){const p=target(a.path),st=fs.statSync(p);if(!st.isFile()||st.size>1048576)throw fail('permission','Arquivo excede limite');const text=fs.readFileSync(p,'utf8');out=a.offset!==undefined||a.length!==undefined?Array.from(text).slice(a.offset||0,(a.offset||0)+(a.length||256)).join(''):text;}
   else if(name==='write_file'){
     if(typeof a.content!=='string'||Buffer.byteLength(a.content)>131072||safe(a.content)!==a.content)throw fail('permission','Conteúdo recusado');
     const dest=target(a.path,true);
     if(dest===path.join(root,'package.json'))throw fail('permission','package.json deve ser alterado somente com set_package_script/remove_package_script');
     fs.writeFileSync(dest,a.content,{flag:'w',mode:0o600});
     edited=true;validated=false;out='Arquivo atualizado';
    }
    else if(name==='set_package_script'){
     if(!/^[A-Za-z0-9:_-]{1,80}$/.test(a.name)||typeof a.command!=='string'||!a.command.trim()||a.command.length>2048||safe(a.command)!==a.command)throw fail('permission','Script recusado');
     const file=path.join(root,'package.json');
     let doc;try{doc=JSON.parse(fs.readFileSync(file,'utf8'));}catch{throw fail('execution','package.json inválido');}
     if(!doc.scripts)doc.scripts={};
     doc.scripts[a.name]=a.command;
     fs.writeFileSync(file,JSON.stringify(doc,null,2)+'\n',{flag:'w',mode:0o600});
     edited=true;validated=false;out='Script npm atualizado';
    }
    else if(name==='remove_package_script'){
     if(!/^[A-Za-z0-9:_-]{1,80}$/.test(a.name))throw fail('permission','Script recusado');
     const file=path.join(root,'package.json');
     let doc;try{doc=JSON.parse(fs.readFileSync(file,'utf8'));}catch{throw fail('execution','package.json inválido');}
     if(doc.scripts&&typeof doc.scripts==='object')delete doc.scripts[a.name];
     fs.writeFileSync(file,JSON.stringify(doc,null,2)+'\n',{flag:'w',mode:0o600});
     edited=true;validated=false;out='Script npm removido';
    }
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
   else if(name==='run_command'){
     await emit('Executando comando.');

     const readOnlyGit=a.command==='git'&&
       ['status','diff','log','show','rev-parse'].includes(a.args[0]);

     if(!readOnlyGit){edited=true;validated=false;}

     const r=await runSafeCommand({
      command:a.command,
      args:a.args,
      signal:controller.signal
     });

     const text=safe(r.output||'');
     await emit(text);
     await input.onProgress({type:'command_end',code:r.code});

     if(r.code!==0){
      const fingerprint=a.command+'\0'+a.args.join('\0')+'\0'+text.slice(-1200);

      if(fingerprint===lastCommandFailure)repeatedCommandFailures++;
      else{
       lastCommandFailure=fingerprint;
       repeatedCommandFailures=1;
      }

      if(repeatedCommandFailures>=3)
       throw fail('execution','Mesmo comando falhou repetidamente sem progresso; estratégia interrompida');

      out='exit_code='+r.code+'\n'+text;

      if(repeatedCommandFailures>=2)
       out+='\nERRO_REPETIDO: releia o arquivo relevante e mude a estratégia.';
     }else{
      lastCommandFailure=null;
      repeatedCommandFailures=0;

      if(a.command==='npm'&&
         (a.args[0]==='test'||(a.args[0]==='run'&&a.args[1]==='test')))
       validated=true;

      out='exit_code=0\n'+text;
     }
    }
    else throw fail('permission','Ferramenta recusada');
   await emit('Ferramenta: '+name);return bounded(safe(out),LIMITS.tool);
  }
  try{
   lease=acquire(root,workspaceToken);
   const activeDefinitions=routeTools(input.instruction);
   const activeToolNames=activeDefinitions.map(d=>d.function.name).join(', ');
   const workspaceSummary=workspaceInventory(root);
   const messages=[{role:'system',content:'Você é um agente de engenharia de software autorizado pelo proprietário deste workspace a inspecionar e modificar os arquivos do projeto exclusivamente por meio das ferramentas fornecidas nesta sessão. Para tarefas sobre recibos, estado, filas ou arquivos privados, NÃO tente acessar diretórios reais como supabase-state, state, logs, .config ou receipts. Em vez disso, inspecione apenas o código-fonte e os testes do projeto e crie fixtures/mocks dentro da suíte de testes para reproduzir o comportamento de forma segura. Todos os caminhos enviados às ferramentas devem ser relativos à raiz do workspace, por exemplo executors ou executors/local.js. Nunca use caminhos absolutos, /path/to, $HOME ou prefixos fictícios. Use list_files, read_file, write_file, set_package_script, remove_package_script, run_check e run_command quando necessário. Nunca use write_file em package.json; para scripts npm use somente set_package_script e remove_package_script. run_command executa somente npm, npx, node e git permitidos pela política local. Passe cada argumento separadamente no array args; nunca tente usar bash, sh, pipes, redirecionamentos ou operadores como &&. Para verificar se um arquivo conhecido existe ou ler seu conteúdo, use read_file diretamente; não use search para isso. search exige sempre uma query textual não vazia. Nunca copie, repita ou apresente como resposta final mensagens internas iniciadas por "Histórico antigo compactado:". Essas operações são esperadas e autorizadas para manutenção do próprio projeto. Não recuse uma tarefa apenas porque ela envolve editar código, corrigir testes, analisar git status/diff ou executar npm test. Não acesse segredos, credenciais, arquivos protegidos, rede externa, shell arbitrário ou recursos fora das ferramentas disponíveis. Não faça commits ou push diretamente. Se a instrução pedir uma etapa que não existe nas ferramentas disponíveis, execute todas as partes possíveis da tarefa, valide as alterações e explique objetivamente no resultado final apenas a etapa externa que ficou pendente. Execute tests depois da última edição. Só finalize quando a parte executável da tarefa estiver concluída e validada. Saídas marcadas TRUNCADA são parciais: releia arquivos com read_file offset/length antes de editar; nunca reconstrua um arquivo com base em um trecho incompleto.'},{role:'system',content:'Ferramentas liberadas: '+activeToolNames+'. A raiz do workspace é ".". Inventário inicial: '+workspaceSummary+'. Não invente diretórios. Para listar a raiz use list_files com path ".". Para criar arquivo novo na raiz, use diretamente o nome do arquivo, por exemplo "tmp-qwen-autonomy.js"; não use um diretório "tmp" a menos que ele apareça no inventário. Regras: arquivo conhecido = read_file; diretório = list_files; localizar texto = search; arquivo comum = write_file; package.json scripts = set_package_script/remove_package_script; npm/node/git = run_command.'},{role:'user',content:safe(input.instruction)}];
   for(let i=0;i<maxIterations;i++){
    if(controller.signal.aborted)throw fail('cancelled','Execução interrompida');
    const prepared=prepare(messages,{model,tools:activeDefinitions,tool_choice:'auto',parallel_tool_calls:false,stream:false,...(model==='openai/gpt-oss-20b'?{disable_tool_validation:true}:{})},validated);
    await emit(JSON.stringify({...prepared.metrics,iteration:i+1}));
    const r=await request((api.endsWith('/v1')?api:api+'/v1')+'/chat/completions',{method:'POST',redirect:'error',signal:controller.signal,headers:{'Content-Type':'application/json',...(apiKey?{Authorization:'Bearer '+apiKey}:{})},body:prepared.body});
    let raw='',bytes=0;const decoder=new TextDecoder();for await(const b of r.body){bytes+=b.byteLength;if(bytes>1048576)throw fail('protocol','Resposta excedeu limite');raw+=decoder.decode(b,{stream:true});}raw+=decoder.decode();
    let data;try{data=JSON.parse(raw);}catch{if(r.ok)throw fail('protocol','Resposta inválida');data={};}
    if(!r.ok){const e=classifyHttp(r.status,data,r.headers);throw fail(e.code,e.message);}
    const c=data.choices?.[0],m=c?.message;if(!m||m.function_call||m.tool_calls&&!Array.isArray(m.tool_calls))throw fail('protocol','Resposta sem mensagem válida');

    // Alguns modelos locais via llama.cpp serializam a intenção de ferramenta
    // como JSON textual em message.content em vez de message.tool_calls.
    // Aceitamos somente o envelope exato {name, arguments}, sem markdown,
    // texto adicional ou chaves extras. A validação normal da ferramenta
    // continua sendo feita por normalizeToolCall().
    if(!m.tool_calls&&c.finish_reason==='stop'&&typeof m.content==='string'){
      let textual=null;
      let textualSource=m.content.trim();

      function firstJsonObject(text){
        const begin=text.indexOf('{');
        if(begin<0)return null;

        let depth=0,inString=false,escape=false;

        for(let j=begin;j<text.length;j++){
          const ch=text[j];

          if(inString){
            if(escape)escape=false;
            else if(ch==='\\')escape=true;
            else if(ch==='"')inString=false;
            continue;
          }

          if(ch==='"'){
            inString=true;
            continue;
          }

          if(ch==='{')depth++;
          else if(ch==='}'){
            depth--;
            if(depth===0)return text.slice(begin,j+1);
          }
        }

        return null;
      }

      const candidate=firstJsonObject(textualSource);

      if(candidate){
        try{textual=JSON.parse(candidate);}catch{}
      }
      if(textual&&
         !Array.isArray(textual)&&
         typeof textual==='object'&&
         Object.keys(textual).sort().join(',')==='arguments,name'&&
         typeof textual.name==='string'&&
         textual.arguments&&
         typeof textual.arguments==='object'&&
         !Array.isArray(textual.arguments)){
        m.tool_calls=[{
          id:'local-text-tool-'+(i+1),
          type:'function',
          function:{
            name:textual.name,
            arguments:JSON.stringify(textual.arguments)
          }
        }];
        m.content=null;
        c.finish_reason='tool_calls';
      }
    }

    const content=typeof m.content==='string'?safe(m.content):null;

    const copiedCompaction=typeof content==='string'&&

     /^Histórico antigo compactado: \d+ lotes omitidos\. Releia arquivos necessários\. Testes após última edição: (?:aprovados|pendentes)\.$/.test(content.trim());


    if(copiedCompaction){
       repeatedCompaction++;

       if(repeatedCompaction>=3)
        throw fail('execution','Agente estagnado repetindo aviso interno de compactação');

       messages.push({
        role:'system',
        content:repeatedCompaction===1
         ? 'Você repetiu um aviso interno e isso não conclui a tarefa. Execute agora uma ferramenta concreta necessária à tarefa.'
         : 'ESTAGNAÇÃO DETECTADA. Execute exatamente uma ferramenta válida. Não explique nem repita avisos internos.'
       });

       continue;
      }

      repeatedCompaction=0;

      if(content){answer=content;await emit(answer);}
    if(m.tool_calls?.length){if(c.finish_reason!=='tool_calls'||m.tool_calls.length>8)throw fail('protocol','Chamada inválida');let calls;
try{
   calls=m.tool_calls.map(call=>normalizeToolCall(call,activeDefinitions));
   rejectedToolCalls=0;
  }catch(e){
   if(e.kind!=='protocol')throw e;

   rejectedToolCalls++;
   await emit('ERRO_TOOL: '+safe(e.message));

   if(rejectedToolCalls>=3)
    throw fail('execution','Chamadas de ferramenta inválidas repetidas sem correção');

   messages.push({
    role:'assistant',
    content:typeof m.content==='string'
      ? bounded(safe(m.content),LIMITS.assistant)
      : null
   });

   messages.push({
    role:'system',
    content:'A chamada de ferramenta anterior foi recusada. Corrija a chamada e tente novamente. Use somente argumentos previstos pelo schema e caminhos relativos à raiz do workspace. Para package.json use set_package_script/remove_package_script.'
   });

   continue;
  }
if(new Set(calls.map(call=>call.id)).size!==calls.length)throw fail('protocol','IDs de ferramentas duplicados');messages.push({role:'assistant',content:typeof m.content==='string'?bounded(safe(m.content),LIMITS.assistant):null,tool_calls:calls});for(const call of calls){
 if(controller.signal.aborted)throw fail('cancelled','Execução interrompida');
 let output;
 try{
  output=await tool(call);
 }catch(e){
  if(controller.signal.aborted||e.kind==='cancelled')throw e;
  const controlled=e.kind
   ? safe(e.message)
   : ['ENOENT','ENOTDIR','EISDIR'].includes(e.code)
     ? 'Caminho incompatível com a ferramenta escolhida'
     : null;
  if(!controlled)throw e;
  output=bounded('ERRO_TOOL: '+controlled,LIMITS.tool);
  await emit(output);
 }
 messages.push({role:'tool',tool_call_id:call.id,content:output});
}continue;}
    if(c.finish_reason!=='stop'||typeof m.content!=='string'||!m.content.trim()||(edited&&!validated))throw fail('execution','Conclusão sem validação bem-sucedida');
    if(controller.signal.aborted)throw fail('cancelled','Execução interrompida');
    lease.release();return {provider:'local',session:{provider:'local',id:null,state:'completed'},status:'completed',answer,error:null,workspaceReleased:true};
   }
   throw fail('execution','Limite de iterações atingido');
  }catch(e){if(lease){if(uncertain)lease.retain();else lease.release();}const status=uncertain?'uncertain':controller.signal.aborted&&!timed?'cancelled':'failed';return {provider:'local',session:{provider:'local',id:null,state:status},status,answer,error:{code:timed?'timeout':controller.signal.aborted?'cancelled':e.kind||(e instanceof TypeError?'network':'execution'),message:safe(e?.message||'Falha no agent local'),retryable:false},workspaceReleased:!uncertain};}
  finally{clearTimeout(timer);input.signal?.removeEventListener('abort',abort);}
 }});
}
module.exports={createAgent,MODELS};
