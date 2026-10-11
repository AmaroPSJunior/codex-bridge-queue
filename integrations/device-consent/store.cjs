'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function dir(home){if(!path.isAbsolute(home||''))throw Error('private_storage_required');return path.join(home,'.config/codex-bridge/device-consent');}
function checkDirectory(root){const st=fs.lstatSync(root);if(st.isSymbolicLink()||!st.isDirectory()||st.uid!==process.getuid()||(st.mode&511)!==448)throw Error('private_storage_required');}
function read(file){const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const s=fs.fstatSync(fd);if(!s.isFile()||s.nlink!==1||s.uid!==process.getuid()||(s.mode&511)!==384||s.size>8192)throw Error('unsafe_private_record');return JSON.parse(fs.readFileSync(fd,'utf8'));}finally{fs.closeSync(fd);}}
function create(file,value){const fd=fs.openSync(file,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}const parent=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(parent);}finally{fs.closeSync(parent);}}
function reserve(root,taskId,record){if(!UUID.test(taskId||''))throw Error('invalid_task');checkDirectory(root);const file=path.join(root,crypto.createHash('sha256').update(taskId).digest('hex')+'.json');create(file,record);return file;}
function config(home){const root=dir(home);checkDirectory(root);const c=read(path.join(root,'config.json'));if(c.version!==1||!/^[a-f0-9]{64}$/.test(c.signing_key||'')||!/^[a-f0-9]{32}$/.test(c.salt||'')||!/^[a-f0-9]{128}$/.test(c.password_hash||''))throw Error('invalid_config');return c;}
function setup(home,password){if(typeof password!=='string'||password.length<16||password.length>256)throw Error('Use senha exclusiva de 16 a 256 caracteres.');const root=dir(home);fs.mkdirSync(root,{recursive:true,mode:0o700});checkDirectory(root);const salt=crypto.randomBytes(16).toString('hex');create(path.join(root,'config.json'),{version:1,salt,password_hash:crypto.scryptSync(password,salt,64).toString('hex'),signing_key:crypto.randomBytes(32).toString('hex')});}
function authenticated(home,password){if(typeof password!=='string'||password.length>256)return false;const c=config(home);return crypto.timingSafeEqual(crypto.scryptSync(password,c.salt,64),Buffer.from(c.password_hash,'hex'));}
function issue(home,input,now=Date.now()){
 const {APK,validate}=require('../../executors/device-actions');
 if(!input||Object.keys(input).some(k=>!['task_id','action','target','ttl_seconds','confirmation'].includes(k))||!UUID.test(input.task_id||'')||!['apk103.install','app.uninstall'].includes(input.action)||!Number.isInteger(input.ttl_seconds)||input.ttl_seconds<30||input.ttl_seconds>300)throw Error('invalid_request');
 const expected=['stationary','park','parking_brake','clear_area','specific_action','data_loss'];const c=input.confirmation;
 if(!c||Object.keys(c).length!==expected.length||expected.some(k=>c[k]!==true))throw Error('confirmation_required');
 validate({action:input.action,target:input.target});const root=dir(home),secret=config(home).signing_key;
 const expires_at=now+input.ttl_seconds*1000;
 const message=JSON.stringify([input.task_id,input.action,input.target,APK.sha256,expires_at,'stationary-P-brake-clear-area','data-loss-consented']);
 const authorization={expires_at,signature:crypto.createHmac('sha256',secret).update(message).digest('hex')};
 // Exclusive durable record prevents reissuing a task, even after expiration.
 create(path.join(root,input.task_id+'.json'),{version:1,task_id:input.task_id,action:input.action,target:input.target,apk_sha256:APK.sha256,issued_at:new Date(now).toISOString(),authorization,owner:'local-password',confirmation:c});
 return {task_id:input.task_id,action:input.action,target:input.target,expires_at,package:APK.package,apk_sha256:APK.sha256};
}
function grant(home,taskId){if(!UUID.test(taskId||''))throw Error('authorization_required');const c=config(home),r=read(path.join(dir(home),taskId+'.json'));if(r.task_id!==taskId)throw Error('authorization_required');return {key:c.signing_key,authorization:r.authorization};}
module.exports={reserve,dir,config,setup,authenticated,issue,grant,UUID};
