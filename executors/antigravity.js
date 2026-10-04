'use strict';
const {spawn:realSpawn}=require('node:child_process');
const {defineExecutor}=require('./contract');
const {sanitizer}=require('../task-progress');
const {StringDecoder}=require('node:string_decoder');
const SAFE_ENV=['HOME','PREFIX','PATH','TMPDIR','LANG','LC_ALL','TERM','TZ','SSL_CERT_FILE','SSL_CERT_DIR'];
const MAX_OUTPUT=1024*1024;
function createAntigravityExecutor({cwd,env=process.env,timeoutMs=900000,spawn=realSpawn,timer=setTimeout,clear=clearTimeout,killGroup=(pid,sig)=>process.kill(-pid,sig)}={}){
 if(typeof cwd!=='string'||!cwd.startsWith('/'))throw TypeError('Antigravity requires an absolute workspace');
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>2147483647)throw TypeError('Invalid Antigravity timeout');
 const clean=sanitizer(env),safe=text=>String(text).split(/\r?\n/).map(clean).join('\n');
 const childEnv=Object.fromEntries(SAFE_ENV.filter(k=>typeof env[k]==='string').map(k=>[k,env[k]]));
 return defineExecutor({version:1,provider:{id:'antigravity'},execute:input=>new Promise(resolve=>{
  let child,deadline,grace,done=false,interrupted=null,phase='help',stdout='',stderr='',size=0,spawned=false;
  let outDecoder=new StringDecoder('utf8'),errDecoder=new StringDecoder('utf8');
  function result(status,answer,code,message,workspaceReleased=false){
   if(done)return;done=true;clear(deadline);if(grace)clear(grace);input.signal?.removeEventListener('abort',abort);
   const r={provider:'antigravity',session:{provider:'antigravity',id:null,state:status},status,answer:safe(answer),error:code?{code,message:safe(message),retryable:false}:null,workspaceReleased};
   // Never forward raw JSON, auth diagnostics or tool objects to the progress sink.
   void (async()=>{
    try{
     if(r.answer)await input.onProgress({type:'output',text:r.answer+'\n',stream:'stdout'});
     if(r.error)await input.onProgress({type:'output',text:r.error.message+'\n',stream:'stderr'});
     if(spawned&&phase==='run')await input.onProgress({type:'command_end',code:status==='completed'?0:null});
    }catch{r.status='uncertain';r.session.state='uncertain';r.error={code:'execution',message:'Falha ao entregar progresso.',retryable:false};r.workspaceReleased=false;}
    resolve(r);
   })();
  }
  function partialAnswer(){try{const p=JSON.parse(stdout);return typeof p.response==='string'?p.response:'';}catch{return '';}}
  function stop(code){
   if(done||interrupted)return;interrupted=code;
   if(!child){result('cancelled','',code,'Execução cancelada antes de iniciar.',true);return;}
   try{killGroup(child.pid,'SIGTERM');}catch{try{child.kill('SIGTERM');}catch{}}
   if(done)return;
   grace=timer(()=>{
    try{killGroup(child.pid,'SIGKILL');}catch{try{child.kill('SIGKILL');}catch{}}
    result('uncertain',partialAnswer(),code,'Antigravity interrompido; confirme o término antes de repetir.',false);
   },2000);
  }
  function abort(){stop('cancelled');}
  function launch(args){
   stdout='';stderr='';size=0;outDecoder=new StringDecoder('utf8');errDecoder=new StringDecoder('utf8');
   let proc;
   try{proc=spawn('agy',args,{cwd,shell:false,detached:true,stdio:['ignore','pipe','pipe'],env:childEnv});child=proc;spawned=true;}
   catch{return result('failed','','unavailable','Não foi possível iniciar agy.',true);}
   function data(d,stream){if(done||interrupted)return;size+=Buffer.byteLength(d);if(size>MAX_OUTPUT){stop('protocol');return;}
    if(stream==='stdout')stdout+=outDecoder.write(Buffer.from(d));else stderr+=errDecoder.write(Buffer.from(d));}
   proc.stdout.on('data',d=>data(d,'stdout'));proc.stderr.on('data',d=>data(d,'stderr'));
   proc.on('error',()=>result(proc.pid?'uncertain':'failed','','unavailable','Não foi possível iniciar agy.',!proc.pid));
   proc.on('close',code=>{
    if(done)return;stdout+=outDecoder.end();stderr+=errDecoder.end();
    if(interrupted)return result('uncertain',partialAnswer(),interrupted,'Antigravity interrompido; confirme o término antes de repetir.',false);
    if(phase==='help'){
     if(code!==0||!['--print','--output-format','--disable-slash-commands'].every(flag=>stdout.includes(flag))||!stdout.includes('json'))
      return result('failed','','protocol','CLI agy incompatível com o modo headless requerido.',true);
     phase='run';launch(['--print='+input.instruction,'--output-format','json','--disable-slash-commands']);return;
    }
    let parsed;try{parsed=JSON.parse(stdout.trim());}catch{}
    if(code===0&&parsed?.status==='SUCCESS'&&typeof parsed.response==='string')return result('completed',parsed.response,null,null,true);
    const diagnostic=stderr+' '+(typeof parsed?.error==='string'?parsed.error:'');
    const kind=/unauth|oauth|login|authenticat|401/i.test(diagnostic)?'authentication':/permission|denied|approval|403/i.test(diagnostic)?'permission':parsed?'execution':'protocol';
    const messages={authentication:'Autenticação do agy indisponível; configure-a fora do worker.',permission:'Permissão recusada pelo agy; nenhuma aprovação automática aplicada.',execution:'Antigravity não confirmou conclusão com sucesso.',protocol:'Resposta estruturada inválida do agy.'};
    result('uncertain',typeof parsed?.response==='string'?parsed.response:'',kind,messages[kind],false);
   });
  }
  if(input.signal?.aborted){result('cancelled','','cancelled','Execução cancelada antes de iniciar.',true);return;}
  input.signal?.addEventListener('abort',abort,{once:true});
  deadline=timer(()=>stop('timeout'),timeoutMs);
  launch(['--help']);
 })});
}
module.exports={createAntigravityExecutor,MAX_OUTPUT};
