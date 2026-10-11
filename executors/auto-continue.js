'use strict';
// Optional local safety gate for already-queued tasks. Never creates tasks or calls AI.
const fs=require('node:fs'),path=require('node:path');
function createGate({dir,env=process.env}){
 // A previously started supervisor may not have loaded the new settings.
 // The worker reads its own private opt-in configuration at launch.
 let settings=null,invalid=false;
 if(env===process.env && !Object.hasOwn(env,'CODEX_BRIDGE_AUTOCONTINUE')){
  const config=path.join(require('node:os').homedir(),'.config','codex-bridge','autocontinue.json');
  try{
   const st=fs.lstatSync(config);
   if(!st.isFile()||st.isSymbolicLink()||st.uid!==process.getuid()||(st.mode&0o777)!==0o600||st.size>1024)throw Error('unsafe auto-continue config');
   const v=JSON.parse(fs.readFileSync(config,'utf8'));
   if(!v||typeof v!=='object'||Array.isArray(v)||typeof v.enabled!=='boolean'||!Number.isInteger(v.max_tasks)||v.max_tasks<1||v.max_tasks>100||Object.keys(v).sort().join(',')!=='enabled,max_tasks')throw Error('invalid auto-continue config');
   settings=v;
  }catch(e){if(e.code!=='ENOENT')invalid=true;}
 }
 const enabled=invalid|| (settings?settings.enabled:env.CODEX_BRIDGE_AUTOCONTINUE==='1');
 const configuredMax=settings?settings.max_tasks:env.CODEX_BRIDGE_AUTOCONTINUE_MAX;
 const max=/^[1-9][0-9]*$/.test(String(configuredMax||''))?Math.min(100,Number(configuredMax)):10;
 const file=path.join(dir,'autocontinue-state.json');
 let state={version:1,count:0,blocked:invalid,lastTaskId:null};
 if(enabled){
  try{const saved=JSON.parse(fs.readFileSync(file,'utf8'));if(saved.version===1&&Number.isSafeInteger(saved.count)&&typeof saved.blocked==='boolean')state=saved;}
  catch(e){if(e.code!=='ENOENT')state={version:1,count:max,blocked:true,lastTaskId:null};}
 }
 function save(){
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const temp=file+'.'+process.pid+'.tmp';
  fs.writeFileSync(temp,JSON.stringify(state),{mode:0o600,flag:'wx'});
  try{fs.renameSync(temp,file);}finally{try{fs.unlinkSync(temp);}catch{}}
 }
 return {
  enabled,
  canClaim:()=>!enabled||(!state.blocked&&state.count<max),
  status:()=>({enabled,blocked:state.blocked,count:state.count,max}),
  record(taskId,status){
   if(!enabled||!taskId||state.lastTaskId===taskId)return;
   state={version:1,count:state.count+1,blocked:status!=='succeeded'||state.count+1>=max,lastTaskId:taskId};
   save();
  }
 };
}
module.exports={createGate};
