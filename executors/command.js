'use strict';
// Closed command grammar, not a shell or a general-purpose tool runner.
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const {StringDecoder}=require('node:string_decoder');
const {sanitizer}=require('../task-progress');
const MAX_OUTPUT=65536,MAX_TIMEOUT=60000;
function mode(task={}){
 const value=task.execution_mode??'agent';

 if(!['agent','command','plan'].includes(value))
  throw Error('Modo/payload incompatível.');

 if(
  (value==='agent'&&(task.command_payload!=null||task.plan_payload!=null))||
  (value==='command'&&(task.command_payload==null||task.plan_payload!=null))||
  (value==='plan'&&(task.plan_payload==null||task.command_payload!=null))
 ) throw Error('Modo/payload incompatível.');

 return value;
}
function validate(payload){
 if(!payload||Array.isArray(payload)||typeof payload!=='object'||Object.keys(payload).some(k=>!['command','args','cwd','timeout_ms'].includes(k)))throw Error('Payload inválido.');
 const {command,args=[],cwd='.',timeout_ms=10000}=payload;
 const permitted={pwd:[[]],ls:[[],['-la']]};
 if(!Object.hasOwn(permitted,command)||!Array.isArray(args)||!permitted[command].some(a=>JSON.stringify(a)===JSON.stringify(args)))throw Error('Comando/argumentos recusados.');
 if(typeof cwd!=='string'||cwd.length>256||path.isAbsolute(cwd)||cwd!=='.'&&cwd.split('/').some(x=>!x||x==='..'||x.startsWith('.')||!/^[A-Za-z0-9_-]+$/.test(x)||['logs','supabase-state','remote-state','node_modules'].includes(x)))throw Error('Diretório recusado.');
 if(!Number.isSafeInteger(timeout_ms)||timeout_ms<1||timeout_ms>MAX_TIMEOUT)throw Error('Timeout inválido.');
 return {command,args,cwd,timeout_ms};
}
function directory(root,relative){
 root=fs.realpathSync(root);let current=root;
 for(const part of relative==='.'?[]:relative.split('/')){
  current=path.join(current,part);const info=fs.lstatSync(current);
  if(info.isSymbolicLink()||!info.isDirectory())throw Error('Diretório recusado.');
 }
 const real=fs.realpathSync(current);if(real!==root&&!real.startsWith(root+path.sep))throw Error('Diretório recusado.');return real;
}
function executeCommand(payload,{cwd,env=process.env,signal,progress,spawnFn=spawn,timer=setTimeout,clear=clearTimeout}={}){
 let spec,dir;
 try{spec=validate(payload);dir=directory(cwd,spec.cwd);}catch{return Promise.resolve(envelope({exit_code:null,stdout:'',stderr:'',started_at:null,completed_at:new Date().toISOString(),error_code:'invalid_input'},false));}
 const started=new Date().toISOString(),clean=sanitizer(env),output={stdout:'',stderr:''},pending={stdout:'',stderr:''},decoders={stdout:new StringDecoder('utf8'),stderr:new StringDecoder('utf8')};
 let child,reason=null,size=0,settled=false,deadline,grace;
 const promise=new Promise(resolve=>{
  function emit(stream,line){const safe=clean(line);if(Buffer.byteLength(output.stdout)+Buffer.byteLength(output.stderr)+Buffer.byteLength(safe)+1>MAX_OUTPUT){if(!settled)stop('output_limit');else reason=reason||'output_limit';return;}output[stream]+=safe+'\n';try{progress?.feed(safe+'\n',stream);}catch{}}
  async function finish(code,released){
   if(settled)return;settled=true;clear(deadline);clear(grace);signal?.removeEventListener('abort',abort);
   for(const stream of ['stdout','stderr']){
    pending[stream]+=decoders[stream].end();
    if(pending[stream]&&!reason)emit(stream,pending[stream]);
   }
   try{await progress?.commandComplete?.(code);}catch{}
   resolve(envelope({exit_code:code,...output,started_at:started,completed_at:new Date().toISOString(),error_code:reason||(code===0?null:'execution')},released));
  }
  function stop(code){
   if(settled||reason)return;reason=code;
   if(!child){void finish(null,true);return;}
   grace=timer(()=>void finish(null,false),5000);
   try{child.kill('SIGTERM');}catch{void finish(null,false);}
  }
  function abort(){stop('cancelled');}
  if(signal?.aborted){abort();return;}
  const bins=[path.dirname(process.execPath),env.PREFIX?path.join(env.PREFIX,'bin'):null,'/usr/bin','/bin'].filter(Boolean);
  const executable=bins.map(bin=>path.join(bin,spec.command)).find(file=>{try{return fs.statSync(file).isFile();}catch{return false;}});
  const args=spec.args;
  if(!executable){reason='unavailable';void finish(null,true);return;}
  try{child=spawnFn(executable,args,{cwd:dir,shell:false,stdio:['ignore','pipe','pipe'],env:{PATH:path.dirname(executable),LANG:'C.UTF-8'}});}catch{reason='unavailable';void finish(null,true);return;}
  for(const stream of ['stdout','stderr'])child[stream].on('data',chunk=>{
   if(settled||reason)return;size+=Buffer.byteLength(chunk);
   if(size>MAX_OUTPUT){pending.stdout=pending.stderr='';emit('stderr','[saída excedeu limite; restante omitido]');stop('output_limit');return;}
   pending[stream]+=decoders[stream].write(Buffer.from(chunk));let end;
   while((end=pending[stream].indexOf('\n'))>=0){emit(stream,pending[stream].slice(0,end));pending[stream]=pending[stream].slice(end+1);}
  });
  child.on('error',()=>{reason=reason||'unavailable';void finish(null,!child.pid);});
  child.on('close',code=>void finish(code,true));
  deadline=timer(()=>stop('timeout'),spec.timeout_ms);
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
 });
 return promise;
}
function envelope(result,released){
 const ok=!result.error_code&&result.exit_code===0,status=ok?'completed':result.error_code==='cancelled'?'cancelled':'failed';
 const error=ok?null:({invalid_input:'Comando, diretório ou payload recusado.',timeout:'Comando excedeu o prazo.',cancelled:'Comando cancelado.',output_limit:'Saída excedeu 64 KiB.',unavailable:'Executável indisponível.',execution:'Comando terminou com falha.'}[result.error_code]||'Falha na execução.');
 return {code:ok?0:1,executionMode:'command',commandResult:result,stdout:JSON.stringify({status,answer:result.stdout||result.stderr||(ok?'Comando concluído sem saída.':''),error,workspaceReleased:released}),stderr:''};
}
module.exports={mode,validate,directory,executeCommand,MAX_OUTPUT};
