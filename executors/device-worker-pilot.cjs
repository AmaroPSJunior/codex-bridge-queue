'use strict';
// Minimal BYD pilot worker: only the literal pwd operation. No shell, ADB,
// vehicle APIs, git, CodeX, updates or file writes. NOT started by default.
const path=require('node:path');
const {readFileSync}=require('node:fs');
const {setTimeout:pause}=require('node:timers/promises');

const must=(value,name)=>{if(typeof value!=='string'||!value)throw Error(name+' required');return value;};
function config(env=process.env){
 const url=new URL(must(env.CODEX_SUPABASE_URL,'Supabase URL'));
 if(url.protocol!=='https:')throw Error('HTTPS required');
 const id=must(env.CODEX_DEVICE_ID,'Device ID');
 if(!/^[0-9a-f-]{36}$/i.test(id))throw Error('Invalid device ID');
 const key=must(env.CODEX_SUPABASE_ANON_KEY,'Supabase anonymous key');
 const token=must(env.CODEX_DEVICE_TOKEN,'Device token');
 if(!/^[A-Za-z0-9_-]{43,128}$/.test(token))throw Error('Invalid device token');
 return {url:url.origin,key,token,id};
}
function isAllowed(task){
 const p=task&&task.command_payload;
 return task?.execution_mode==='command'&&p&&typeof p==='object'
  &&Object.keys(p).every(k=>['command','args','cwd','timeout_ms'].includes(k))
  &&p.command==='pwd'&&Array.isArray(p.args)&&p.args.length===0
  &&(p.cwd===undefined||p.cwd==='.')
  &&(p.timeout_ms===undefined||Number.isSafeInteger(p.timeout_ms)&&p.timeout_ms>=1&&p.timeout_ms<=60000);
}
async function rpc(cfg,name,body,fetcher=fetch){
 const response=await fetcher(cfg.url+'/rest/v1/rpc/'+name,{
  method:'POST',headers:{apikey:cfg.key,Authorization:'Bearer '+cfg.key,'Content-Type':'application/json'},
  body:JSON.stringify(body),signal:AbortSignal.timeout(20000)
 });
 if(!response.ok)throw Error('RPC '+name+' failed with HTTP '+response.status);
 return response.json();
}
async function one(cfg,{fetcher=fetch,cwd=process.cwd()}={}){
 const claimed=await rpc(cfg,'bridge_device_claim',{p_device_id:cfg.id,p_token:cfg.token},fetcher);
 if(!Array.isArray(claimed)||!claimed.length)return 'idle';
 const task=claimed[0];
 // Always finalize a claimed task (unless network fails; then it remains uncertain).
 const ok=isAllowed(task);
 const response=ok?'pwd: '+path.resolve(cwd):'Device command rejected by read-only pilot allowlist';
 const complete=await rpc(cfg,'bridge_device_complete',{
  p_device_id:cfg.id,p_token:cfg.token,p_task_id:task.task_id,
  p_claim_nonce:task.claim_nonce,p_success:ok,p_result:response
 },fetcher);
 if(complete!==true)throw Error('Claim completion was not accepted');
 return ok?'completed':'rejected';
}
async function main(){
 const cfg=config();
 // Explicit opt-in. This worker must NEVER run on the legacy phone supervisor.
 if(process.env.CODEX_DEVICE_WORKER_ENABLED!=='1')throw Error('Device worker not enabled');
 for(;;){
  try{await one(cfg);}catch(e){
   console.error('Device worker cycle failed (no secrets or task contents logged)');
  }
  await pause(15000);
 }
}
if(require.main===module)main().catch(()=>{console.error('Device worker startup refused');process.exitCode=1;});
module.exports={config,isAllowed,rpc,one,main};
