'use strict';
const {createLocalExecutor}=require('./local-openai');
const {sanitizer}=require('../task-progress');
const DEFAULT_MODEL='openai/gpt-oss-120b';
const DEFAULT_BASE_URL='https://api.groq.com/openai/v1';
// Scheduling hint only: no router, retry, fallback or price promise.
const FALLBACK_POLICY=Object.freeze({candidate:true,priority:1,requiresHealthy:true,automatic:false,capability:'text'});
function configFromEnv(env=process.env){
 return {baseUrl:env.GROQ_BASE_URL||DEFAULT_BASE_URL,model:env.GROQ_MODEL||DEFAULT_MODEL,apiKey:env.GROQ_API_KEY||'',stream:env.GROQ_STREAM!=='0'};
}
function classifyHttp(status,body,headers){
 const kind=typeof body?.error?.code==='string'?body.error.code:body?.error?.type;
 const quota=status===402||['insufficient_quota','quota_exceeded','billing_limit_reached','billing_hard_limit_reached','spend_limit_exceeded'].includes(kind);
 const code=status===413?'payload_too_large':status===401?'authentication':status===403?'permission':quota?'quota':status===429?'rate_limit':'http';
 const messages={payload_too_large:'Groq retornou HTTP 413: payload excede o limite do provider; reduza o contexto.',authentication:'Credencial Groq recusada.',permission:'Acesso Groq negado.',quota:'Cota ou limite financeiro Groq atingido.',rate_limit:'Limite de requisições Groq atingido.',http:'Groq retornou HTTP '+status+'.'};
 const raw=headers.get('retry-after');const seconds=raw!==null&&/^\d+(\.\d+)?$/.test(raw)?Number(raw):NaN;
 return {code,message:messages[code],retryable:code==='rate_limit'||code==='http'&&status>=500,
  ...(Number.isFinite(seconds)?{retryAfterMs:Math.min(seconds*1000,86400000)}:{})};
}
function createGroqExecutor({env=process.env,...options}={}){
 const config={...configFromEnv(env),...options};
 if(typeof config.apiKey!=='string'||!config.apiKey.trim())throw TypeError('GROQ_API_KEY não configurada');
 const redact=sanitizer({...env,GROQ_API_KEY:config.apiKey});
 const classify=(status,body,headers)=>{
  const result=classifyHttp(status,body,headers);
  // Only selected error fields, never headers, request bodies or failed_generation.
  // Redact before truncation so a partially cut credential cannot escape matching.
  if(status===400&&body?.error&&typeof body.error==='object'){
   const detail=['code','type','param','message'].flatMap(field=>{
    const value=body.error[field];
    if(typeof value!=='string')return [];
    return [field+'='+value.split(/\r?\n/).map(redact).join(' ').slice(0,512)];
   }).join('; ');
   if(detail)result.message+=' '+detail;
  }
  return result;
 };
 const common={...config,env,providerId:'groq',strictModels:true,classifyHttp:classify,networkCode:'network'};
 const textExecutor=createLocalExecutor(common);
 const mode=config.mode||env.GROQ_MODE||'text';
 if(!['text','agent'].includes(mode))throw TypeError('GROQ_MODE inválido');
 const executor=mode==='agent'?require('./groq-agent').createAgent(common):textExecutor;
 return Object.freeze({...executor,fallbackPolicy:FALLBACK_POLICY,async healthCheck({signal}={}){
  const r=await createLocalExecutor({...common,healthOnly:true,timeoutMs:Math.min(config.timeoutMs||900000,10000)}).execute({instruction:'health',signal});
  return {provider:'groq',healthy:r.status==='completed',checkedAt:new Date().toISOString(),error:r.error};
 }});
}
// Portable, secret-free connection description for external clients/agent loops.
// A client resolves apiKeyEnv itself; this is not an OpenCode config file schema.
function clientDescriptor(env=process.env){
 const {baseUrl,model}=configFromEnv(env);const url=new URL(baseUrl);
 if(url.username||url.password||url.search||url.hash||!(url.protocol==='https:'||url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)))throw TypeError('Endpoint Groq inválido');
 if(typeof model!=='string'||!model.trim()||model.length>256)throw TypeError('Modelo Groq inválido');
 return {protocol:'openai-chat-completions',baseUrl,model,apiKeyEnv:'GROQ_API_KEY'};
}
module.exports={createGroqExecutor,configFromEnv,clientDescriptor,FALLBACK_POLICY,DEFAULT_MODEL,DEFAULT_BASE_URL};
