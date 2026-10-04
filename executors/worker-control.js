'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function folder(state){const dir=path.join(state,'control');fs.mkdirSync(dir,{mode:0o700,recursive:true});const s=fs.lstatSync(dir);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&511)!==448)throw Error('Controle privado indisponível');return dir;}
function read(file){const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const s=fs.fstatSync(fd);if(!s.isFile()||s.uid!==process.getuid()||(s.mode&511)!==384||s.size>8192)throw Error('Controle inválido');return JSON.parse(fs.readFileSync(fd,'utf8'));}finally{fs.closeSync(fd);}}
function save(file,value){const tmp=file+'.'+crypto.randomBytes(8).toString('hex');let fd;try{fd=fs.openSync(tmp,'wx',0o600);fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(tmp,file);const d=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(d);}finally{fs.closeSync(d);}}finally{if(fd!==undefined)fs.closeSync(fd);if(fs.existsSync(tmp))fs.unlinkSync(tmp);}}
function control(state,instruction,task){let input;try{input=JSON.parse(instruction);}catch{return null;}if(!input||typeof input!=='object'||!Object.hasOwn(input,'bridge_control'))return null;
 try{if(Object.keys(input).length!==1||!['restart','status'].includes(input.bridge_control))throw Error('Comando de controle inválido ou ainda não implementado');
 const dir=folder(state);let answer;
 if(input.bridge_control==='restart'){
  if(!uuid.test(task.id))throw Error('Identificador de controle inválido');const file=path.join(dir,task.id+'.json');let r;
  if(fs.existsSync(file))r=read(file);else {r={version:1,id:task.id,command:'restart',status:'requested',created_at:new Date().toISOString()};save(file,r);}
  answer='Restart solicitado; o supervisor aguardará publicação confirmada e estado ocioso. Estado: '+r.status;
 }else{answer=JSON.stringify(fs.readdirSync(dir).filter(n=>uuid.test(n.slice(0,-5))&&n.endsWith('.json')).sort().slice(-20).map(n=>{const r=read(path.join(dir,n));return {id:r.id,request_ref:crypto.createHash('sha256').update(r.id).digest('hex').slice(0,12),command:r.command,status:r.status,ack_at:r.ack_at||null};}));}
 return {code:0,stdout:JSON.stringify({status:'completed',answer,workspaceReleased:true}),stderr:''};
 }catch{return {code:1,stdout:JSON.stringify({status:'failed',answer:'',error:'Controle recusado ou indisponível.',workspaceReleased:true}),stderr:''};}
}
function confirm(state,id){if(!uuid.test(id))return;const dir=folder(state),file=path.join(dir,id+'.json');if(fs.existsSync(file)){read(file);save(path.join(dir,'published-'+id+'.json'),{id});}}
function checkpoint(state,workspace,pid){const dir=folder(state),file=path.join(dir,'drain.json');if(!fs.existsSync(file))return false;const r=read(file);if(r.pid!==pid||!uuid.test(r.id)||typeof r.nonce!=='string')return false;
 // Called only between tasks, after receipt reconciliation. Never signal readiness
 // while any publication is pending or an executor has retained its workspace lock.
 const publication=path.join(dir,'published-'+r.id+'.json');if(!fs.existsSync(publication)||read(publication).id!==r.id)return true;
 const pending=path.join(state,'pending-results');if(fs.existsSync(path.join(workspace,'.bridge-workspace-lock'))||fs.existsSync(pending)&&fs.readdirSync(pending).some(n=>/^[a-f0-9]{64}\.json$/.test(n)))return true;
 save(path.join(dir,'ready.json'),{id:r.id,pid,nonce:r.nonce});return true;
}
module.exports={control,confirm,checkpoint,read,save};
