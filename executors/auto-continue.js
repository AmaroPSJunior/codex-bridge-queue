'use strict';
// Optional local safety gate for already-queued tasks. Never creates tasks or calls AI.
const fs=require('node:fs'),path=require('node:path');
function createGate({dir,env=process.env}){
 const enabled=env.CODEX_BRIDGE_AUTOCONTINUE==='1';
 const max=/^[1-9][0-9]*$/.test(env.CODEX_BRIDGE_AUTOCONTINUE_MAX||'')?Math.min(100,Number(env.CODEX_BRIDGE_AUTOCONTINUE_MAX)):10;
 const file=path.join(dir,'autocontinue-state.json');
 let state={version:1,count:0,blocked:false,lastTaskId:null};
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
