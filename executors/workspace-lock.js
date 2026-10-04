'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
// Persistent safety fence: never steal on PID age/death. A remote turn may survive.
function acquire(workspace, inheritedToken) {
 const root=fs.realpathSync(workspace),dir=path.join(root,'.bridge-workspace-lock');
 const owner=path.join(dir,'owner.json');
 function read(){
  const st=fs.lstatSync(dir);
  if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==process.getuid()||(st.mode&0o777)!==0o700)throw Error('WORKSPACE_LOCK_UNSAFE');
  const fd=fs.openSync(owner,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try{const s=fs.fstatSync(fd);if(!s.isFile()||s.size>1024||(s.mode&0o777)!==0o600||s.uid!==process.getuid())throw Error('WORKSPACE_LOCK_UNSAFE');return JSON.parse(fs.readFileSync(fd,'utf8'));}finally{fs.closeSync(fd);}
 }
 if(inheritedToken){
  const record=read();
  if(record.token!==inheritedToken||record.state!=='active')throw Error('WORKSPACE_LOCK_INVALID_LEASE');
  return {token:inheritedToken,release(){},retain(){}};
 }
 try{fs.mkdirSync(dir,{mode:0o700});}catch(e){if(e.code==='EEXIST')throw Error('WORKSPACE_BUSY_OR_UNCERTAIN');throw e;}
 const token=crypto.randomBytes(32).toString('hex');
 const record={version:1,token,pid:process.pid,state:'active'};
 // If initialization fails, leave fence in place. Never expose token in logs.
 fs.writeFileSync(owner,JSON.stringify(record),{mode:0o600,flag:'wx'});
 let finished=false;
 return {token,
  release(){if(finished)return;const saved=read();if(saved.token!==token)throw Error('WORKSPACE_LOCK_OWNER_CHANGED');fs.unlinkSync(owner);fs.rmdirSync(dir);finished=true;},
  retain(){if(finished)return;const saved=read();if(saved.token!==token)throw Error('WORKSPACE_LOCK_OWNER_CHANGED');fs.writeFileSync(owner,JSON.stringify({...record,state:'uncertain'}),{mode:0o600});finished=true;}
 };
}
module.exports={acquire};
