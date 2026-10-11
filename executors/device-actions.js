'use strict';
// Fixed artifact and typed argv only. Signed, task-bound consent is mandatory for mutations.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),net=require('node:net');
const APK={repo:'AmaroPSJunior/Byd-dilink',run:'38040436925',name:'byd-car-control-v1.0.103.apk',sha256:'270bfca86f8cb46f430eb8c060b0935efc78a6e1a7fc6f60fa9c5014d875a582',package:'com.byd.carcontrol'};
const actions=['adb.connect','adb.inspect','apk103.download','apk103.validate','apk103.install','app.uninstall','app.verify'];
function validate(p){
 if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).some(k=>!['action','target'].includes(k))||!actions.includes(p.action))throw Error('invalid_input');
 if(typeof p.target!=='string'||!p.target.endsWith(':5555'))throw Error('invalid_target');
 const ip=p.target.slice(0,-5);if(net.isIP(ip)!==4||!(ip.startsWith('10.')||ip.startsWith('192.168.')||/^172\.(1[6-9]|2\d|3[01])\./.test(ip)))throw Error('invalid_target');
 return p;
}
function consent(p,taskId,key,now=Date.now()){
 const a=p.authorization;
 if(!/^[a-f0-9-]{36}$/i.test(taskId||'')||typeof key!=='string'||key.length<32||!a||!Number.isSafeInteger(a.expires_at)||a.expires_at<=now||a.expires_at>now+300000||typeof a.signature!=='string'||!/^[a-f0-9]{64}$/.test(a.signature))throw Error('authorization_required');
 const message=JSON.stringify([taskId,p.action,p.target,APK.sha256,a.expires_at,'stationary-P-brake-clear-area','data-loss-consented']);
 const sig=crypto.createHmac('sha256',key).update(message).digest();
 if(!crypto.timingSafeEqual(sig,Buffer.from(a.signature,'hex')))throw Error('authorization_required');
}
function privateDir(dir){fs.mkdirSync(dir,{recursive:true,mode:0o700});const s=fs.lstatSync(dir);if(s.isSymbolicLink()||!s.isDirectory()||s.uid!==process.getuid()||(s.mode&0o777)!==0o700)throw Error('private_storage_required');}
function verify(file){const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const s=fs.fstatSync(fd);if(!s.isFile()||s.size>32*1024*1024||s.uid!==process.getuid())throw Error('invalid_artifact');if(crypto.createHash('sha256').update(fs.readFileSync(fd)).digest('hex')!==APK.sha256)throw Error('invalid_artifact');}finally{fs.closeSync(fd);}}
async function execute(payload,options,run){
 const {env=process.env,taskId,signal}=options;let dir,record,released=true;
 try{
  let p=validate(payload);if(signal?.aborted)throw Error('cancelled');
  const mutation=['apk103.install','app.uninstall'].includes(p.action);
  if(mutation){const grant=require('../integrations/device-consent/store.cjs').grant(env.HOME,taskId);p={...p,authorization:grant.authorization};consent(p,taskId,grant.key);}
  if(!env.HOME||!path.isAbsolute(env.HOME))throw Error('private_storage_required');
  dir=path.join(env.HOME,'.config/codex-bridge/device-actions');privateDir(dir);
  const file=path.join(dir,APK.name);
  // A one-use durable receipt prevents retry after an uncertain install/uninstall.
  if(mutation){verify(file);record=require('../integrations/device-consent/store.cjs').reserve(dir,taskId,{action:p.action,target:p.target,status:'reserved',at:new Date().toISOString()});}
  const steps=[];
  if(p.action==='adb.connect')steps.push(['adb',['connect',p.target]]);
  if(p.action==='adb.inspect')steps.push(['adb',['-s',p.target,'get-state']],...['ro.build.version.release','ro.product.model'].map(k=>['adb',['-s',p.target,'shell','getprop',k]]));
  if(['app.verify','apk103.install','app.uninstall'].includes(p.action))steps.push(['adb',['-s',p.target,'get-state']]);
  if(p.action==='apk103.download'){
   if(fs.existsSync(file)){verify(file);}else{
    // Download to a new private directory; a partial download is never an install candidate.
    const tmp=fs.mkdtempSync(path.join(dir,'download-'));
    steps.push(['gh',['run','download',APK.run,'--repo',APK.repo,'--name',APK.name,'--dir',tmp],()=>{verify(path.join(tmp,APK.name));fs.renameSync(path.join(tmp,APK.name),file);fs.chmodSync(file,0o600);}]);
   }
  }
  if(p.action==='apk103.validate')verify(file);
  if(p.action==='apk103.install')steps.push(['adb',['-s',p.target,'install','--user','0','-r',file]]);
  if(p.action==='app.uninstall')steps.push(['adb',['-s',p.target,'shell','pm','uninstall','--user','0',APK.package]]);
  if(['app.verify','apk103.install'].includes(p.action))steps.push(['adb',['-s',p.target,'shell','pm','path',APK.package]]);
  const results=[];let result;
  for(const [command,args,after] of steps){
   if(signal?.aborted)throw Error('cancelled');
   if(mutation){const grant=require('../integrations/device-consent/store.cjs').grant(env.HOME,taskId);p={...p,authorization:grant.authorization};consent(p,taskId,grant.key);}
   released=false;
   result=await run({command,args,cwd:'.',timeout_ms:60000},options);
   released=JSON.parse(result.stdout).workspaceReleased===true;
   results.push(result.commandResult);
   if(result.code!==0)break;
   if(p.action==='adb.connect'&&!/^(connected to|already connected to) /m.test(result.commandResult.stdout))throw Error('device_unavailable');
   if(command==='adb'&&args.includes('get-state')&&result.commandResult.stdout.trim()!=='device')throw Error('device_unavailable');
   if(command==='adb'&&(args.includes('install')||args.includes('uninstall'))&&!/^Success$/m.test(result.commandResult.stdout))throw Error('device_operation_failed');
   after?.();
  }
  if(!result)result={code:0,executionMode:'command',commandResult:{exit_code:0,stdout:'APK 103 validado pelo hash fixado.',stderr:'',error_code:null},stdout:JSON.stringify({status:'completed',answer:'APK 103 validado pelo hash fixado.',error:null,workspaceReleased:true}),stderr:''};
  const audit={action:p.action,target:p.target,at:new Date().toISOString(),status:result.code===0?'completed':'failed',steps:results.map(r=>({exit_code:r.exit_code,error_code:r.error_code,started_at:r.started_at,completed_at:r.completed_at}))};
  const auditFile=record||path.join(dir,crypto.randomUUID()+'.json');fs.writeFileSync(auditFile,JSON.stringify(audit),{mode:0o600,flag:record?'w':'wx'});
  result.commandResult={...result.commandResult,action:p.action,steps:results};return result;
 }catch(e){return {code:1,executionMode:'command',commandResult:{error_code:'device_action_refused'},stdout:JSON.stringify({status:'failed',answer:'',error:'Ação de dispositivo recusada; valide artefato, conexão e autorização específica.',workspaceReleased:released}),stderr:''};}
}
module.exports={APK,actions,validate,consent,verify,execute};
