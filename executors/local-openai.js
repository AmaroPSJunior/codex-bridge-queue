'use strict';
const {defineExecutor}=require('./contract');
const {sanitizer}=require('../task-progress');
const LIMIT=1024*1024;
function configFromEnv(env=process.env){
 return {baseUrl:env.LOCAL_AI_BASE_URL,model:env.LOCAL_AI_MODEL,apiKey:env.LOCAL_AI_API_KEY||'',stream:env.LOCAL_AI_STREAM!=='0'};
}
function createLocalExecutor({baseUrl,model,apiKey='',stream=true,timeoutMs=900000,env=process.env,fetch:request=globalThis.fetch,providerId='local',strictModels=false,healthOnly=false,classifyHttp=null,networkCode='unavailable'}={}){
 let base;try{base=new URL(baseUrl);}catch{throw TypeError('LOCAL_AI_BASE_URL inválida');}
 const loopback=['127.0.0.1','localhost','[::1]'].includes(base.hostname);
 if(base.username||base.password||base.search||base.hash||!(base.protocol==='https:'||(base.protocol==='http:'&&loopback)))throw TypeError('Endpoint local inseguro');
 if(typeof model!=='string'||!model.trim()||model.length>256)throw TypeError('LOCAL_AI_MODEL inválido');
 if(typeof apiKey!=='string'||/[\r\n]/.test(apiKey)||apiKey&&apiKey===env.CODEX_SUPABASE_SERVICE_ROLE_KEY)throw TypeError('Credencial local inválida');
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<=0||timeoutMs>2147483647)throw TypeError('Timeout local inválido');
 const root=base.href.replace(/\/$/,''),api=root.endsWith('/v1')?root:root+'/v1';
 const clean=sanitizer({...env,LOCAL_AI_API_KEY:apiKey});
 const safe=s=>s.split(/\r?\n/).map(clean).join('\n');
 const headers={'Content-Type':'application/json',...(apiKey?{Authorization:'Bearer '+apiKey}:{})};
 return defineExecutor({version:1,provider:{id:providerId},async execute(input){
  const controller=new AbortController();let timedOut=false,answer='',partial='',dropping=false,terminal=false,posted=false;
  const abort=()=>controller.abort();input.signal?.addEventListener('abort',abort,{once:true});if(input.signal?.aborted)abort();
  const timer=setTimeout(()=>{timedOut=true;controller.abort();},timeoutMs);
  function error(code,message){const e=new Error(message);e.kind=code;return e;}
  async function get(url,options={}){
   const response=await request(url,{...options,headers,signal:controller.signal,redirect:'error'});
   return response;
  }
  async function http(r){if(!r.ok){
   if(classifyHttp){let body;try{body=await json(r);}catch{}
    const info=classifyHttp(r.status,body,r.headers);const e=error(info.code,info.message);e.details=info;throw e;
   }
   throw error(r.status===401?'authentication':r.status===403?'permission':'unavailable','Servidor local retornou HTTP '+r.status+'.');
  }}
  async function consume(response,accept){
   if(!response.body)throw error('protocol','Resposta local sem corpo.');
   const reader=response.body.getReader(),decoder=new TextDecoder();let bytes=0;
   try{while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;
     if(bytes>LIMIT)throw error('protocol','Resposta local excedeu o limite.');
     await accept(decoder.decode(value,{stream:true}));
    }await accept(decoder.decode());
   }finally{try{await reader.cancel();}catch{}reader.releaseLock();}
  }
  async function json(r){let text='';await consume(r,s=>{text+=s;});try{return JSON.parse(text);}catch{throw error('protocol','JSON local inválido.');}}
  async function emitLine(line){const text=clean(line);answer+=(answer?'\n':'')+text;await input.onProgress({type:'output',stream:'stdout',text:text+'\n'});}
  async function output(text){
   for(const part of text.split(/(?<=\n)/)){
    if(dropping){if(part.endsWith('\n')){dropping=false;await emitLine('[linha excede limite; omitida]');}continue;}
    partial+=part;if(Buffer.byteLength(partial)>16384){partial='';dropping=!part.endsWith('\n');if(!dropping)await emitLine('[linha excede limite; omitida]');continue;}
    if(partial.endsWith('\n')){await emitLine(partial.slice(0,-1).replace(/\r$/,''));partial='';}
   }
  }
  try{
   let r=await get(api+'/models');
   if(!strictModels&&(r.status===404||r.status===405)){await r.body?.cancel();r=await get(root.replace(/\/v1$/,'')+'/health');
    if(r.status===404||r.status===405)await r.body?.cancel();
    else{await http(r);await json(r);}
   }else{await http(r);const models=await json(r);if(!Array.isArray(models?.data))throw error('protocol','Lista de modelos inválida.');
    if(!models.data.some(x=>x.id===model))throw error('invalid_input','Modelo configurado não anunciado pelo servidor.');}
   if(healthOnly)return {provider:providerId,session:{provider:providerId,id:null,state:'completed'},status:'completed',answer:'Modelo disponível.',error:null,workspaceReleased:true};
   posted=true;
   r=await get(api+'/chat/completions',{method:'POST',body:JSON.stringify({model,messages:[{role:'user',content:safe(input.instruction)}],stream})});await http(r);
   if((r.headers.get('content-type')||'').includes('text/event-stream')){
    let pending='',data=[],done=false;
    async function event(){if(!data.length)return;const raw=data.join('\n');data=[];
     if(raw==='[DONE]'){done=true;return;}
     if(done)throw error('protocol','Evento após término do stream.');
     let frame;try{frame=JSON.parse(raw);}catch{throw error('protocol','Evento SSE inválido.');}
     if(frame.error)throw error('execution','Servidor local reportou erro.');
     if(Array.isArray(frame.choices)&&frame.choices.length===0)return;
     const choice=frame.choices?.[0];if(!choice||choice.delta?.tool_calls||choice.delta?.function_call)throw error('protocol','Resposta local não textual.');
     if(choice.delta?.content!=null){if(typeof choice.delta.content!=='string')throw error('protocol','Conteúdo local inválido.');await output(choice.delta.content);}
     if(choice.finish_reason!=null){if(choice.finish_reason!=='stop')throw error('execution','Geração local terminou incompleta.');terminal=true;}
    }
    await consume(r,async text=>{pending+=text;let index;while((index=pending.indexOf('\n'))>=0){const line=pending.slice(0,index).replace(/\r$/,'');pending=pending.slice(index+1);
     if(line==='')await event();else if(line.startsWith('data:'))data.push(line.slice(5).replace(/^ /,''));
    }});
    if(pending.startsWith('data:'))data.push(pending.slice(5).trimStart());await event();
    if(!terminal)throw error('protocol','Stream local terminou sem confirmação.');
   }else{
    const body=await json(r),choice=body.choices?.[0];
    if(body.error||typeof choice?.message?.content!=='string'||choice.message.tool_calls||choice.message.function_call)throw error('protocol','Resposta local inválida ou não textual.');
    if(choice.finish_reason!=='stop')throw error('execution','Geração local terminou incompleta.');
    await output(choice.message.content);terminal=true;
   }
   if(dropping)await emitLine('[linha excede limite; omitida]');else if(partial)await emitLine(partial);
   if(!answer.trim())throw error('protocol','Resposta local vazia.');
   await input.onProgress({type:'command_end',code:0});
   return {provider:providerId,session:{provider:providerId,id:null,state:'completed'},status:'completed',answer,error:null,workspaceReleased:true};
  }catch(e){
   // Preserve sanitized partial output, including a last line without newline.
   try{if(dropping)await emitLine('[linha excede limite; omitida]');else if(partial)await emitLine(partial);partial='';}catch{}
   controller.abort();const status=input.signal?.aborted?'cancelled':'failed';
   const code=timedOut?'timeout':input.signal?.aborted?'cancelled':e.kind||networkCode;
   const message=timedOut?'Tempo limite do servidor local excedido.':input.signal?.aborted?'Consulta local cancelada.':e.kind?e.message:'Não foi possível comunicar com o servidor local.';
   try{await input.onProgress({type:'output',stream:'stderr',text:message+'\n'});if(posted)await input.onProgress({type:'command_end',code:null});}catch{}
   // Text-only requests have no filesystem tools. Aborted inference cannot write the workspace.
   return {provider:providerId,session:{provider:providerId,id:null,state:status},status,answer,error:{code,message:safe(message),retryable:e.details?.retryable===true||code==='network',...(e.details?.retryAfterMs!==undefined?{retryAfterMs:e.details.retryAfterMs}:{})},workspaceReleased:true};
  }finally{clearTimeout(timer);input.signal?.removeEventListener('abort',abort);}
 }});
}
module.exports={configFromEnv,createLocalExecutor};
