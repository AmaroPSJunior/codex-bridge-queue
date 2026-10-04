'use strict';
const FIELDS=Object.freeze(['requested_provider','actual_provider','provider_model','provider_session_id','fallback_from','fallback_reason']);
function supports(task){return FIELDS.every(k=>Object.prototype.hasOwnProperty.call(task,k));}
function identifier(value,max,env){
 if(typeof value!=='string'||value.length<1||value.length>max||!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value))return null;
 if(/secret|token|password|credential|bearer|gsk_|sk-|sb_|github_pat_|gh[pousr]_/i.test(value))return null;
 // Preserve opaque UUID session IDs privately; never publish them in dashboard RPCs.
 for(const [key,secret] of Object.entries(env))if(/KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL/i.test(key)&&typeof secret==='string'&&secret&&value.includes(secret))return null;
 return value;
}
function observation(task,run,env={}){
 if(!supports(task)||!run.providerSelection)return null;
 const provider=run.providerSelection.provider;
 if(!['codex','antigravity','claude','local','groq'].includes(provider))return null;
 let parsed;try{parsed=JSON.parse(run.stdout);}catch{}
 const model=Object.prototype.hasOwnProperty.call(run,'providerModel')?run.providerModel:provider==='groq'?(env.GROQ_MODEL||'openai/gpt-oss-120b'):provider==='local'?env.LOCAL_AI_MODEL:null;
 const code=run.providerErrorCode;
 const completed=run.providerOutcome?run.providerOutcome.code===0&&run.providerOutcome.status==='completed':run.code===0&&parsed?.status==='completed';
 const state=completed?'ready':['quota','rate_limit'].includes(code)?'quota_exceeded':['authentication','permission'].includes(code)?'auth_error':'unavailable';
 return {p_task_id:task.id,p_requested:provider,p_actual:provider,p_model:identifier(model,128,env),p_session:identifier(parsed?.threadId,256,env),p_state:state};
}
module.exports={FIELDS,supports,identifier,observation};
