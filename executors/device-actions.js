'use strict';
// Fixed artifact and typed argv only. Only the owner-approved pinned install is exempt from custom consent.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),net=require('node:net');
const APK={repo:'AmaroPSJunior/Byd-dilink',run:'38040436925',name:'byd-car-control-v1.0.103.apk',sha256:'270bfca86f8cb46f430eb8c060b0935efc78a6e1a7fc6f60fa9c5014d875a582',package:'com.byd.carcontrol'};
const INSTALL_TARGET='10.23.201.181:5555';
const actions=['adb.connect','adb.inspect','apk103.download','apk103.validate','apk103.install','app.uninstall','app.verify'];
function validate(p){
 if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).some(k=>!['action','target'].includes(k))||!actions.includes(p.action))throw Error('invalid_input');
 if(typeof p.target!=='string'||!p.target.endsWith(':5555'))throw Error('invalid_target');
 const ip=p.target.slice(0,-5);if(net.isIP(ip)!==4||!(ip.startsWith('10.')||ip.startsWith('192.168.')||/^172\.(1[6-9]|2\d|3[01])\./.test(ip)))throw Error('invalid_target');
 return p;
}
function requiresConsent(p){return ['apk103.install','app.uninstall'].includes(p.action)&&!(p.action==='apk103.install'&&p.target===INSTALL_TARGET);}
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
 const {env=process.env,taskId,signal}=options;let dir,record,released=true;const results=[];
 try{
  let p=validate(payload);if(signal?.aborted)throw Error('cancelled');
  const mutation=['apk103.install','app.uninstall'].includes(p.action);
  if(requiresConsent(p)){const grant=require('../integrations/device-consent/store.cjs').grant(env.HOME,taskId);p={...p,authorization:grant.authorization};consent(p,taskId,grant.key);}
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
  if(p.action==='apk103.install'){
   steps.push(['adb',['-s',p.target,'shell','getprop','ro.product.model'],result=>{if(result.commandResult.stdout.trim()!=='BYD AUTO')throw Error('device_identity_mismatch');}]);
   steps.push(['adb',['-s',p.target,'shell','getprop','ro.build.version.sdk'],result=>{const sdk=result.commandResult.stdout.trim();if(!/^\d+$/.test(sdk)||Number(sdk)<24)throw Error('android_incompatible');}]);
   steps.push(['adb',['-s',p.target,'install','--user','0','-r',file]]);
  }
  if(p.action==='app.uninstall')steps.push(['adb',['-s',p.target,'shell','pm','uninstall','--user','0',APK.package]]);
  if(['app.verify','apk103.install'].includes(p.action))steps.push(['adb',['-s',p.target,'shell','pm','path',APK.package],result=>{
   const lines=result.commandResult.stdout.trim().split('\n');
   const base=lines.find(line=>/^package:\/data\/app\/[A-Za-z0-9_+=./-]+\/base\.apk$/.test(line));
   if(!base||base.includes('..'))throw Error('installed_package_unverified');
   if(p.action==='apk103.install')steps.push(['adb',['-s',p.target,'shell','sha256sum',base.slice(8)],result=>{
    if(result.commandResult.stdout.trim().split(/\s+/)[0]!==APK.sha256)throw Error('installed_hash_mismatch');
   }]);
  }]);
  let result;
  for(const [command,args,after] of steps){
   if(signal?.aborted)throw Error('cancelled');
   if(requiresConsent(p)){const grant=require('../integrations/device-consent/store.cjs').grant(env.HOME,taskId);p={...p,authorization:grant.authorization};consent(p,taskId,grant.key);}
   if(p.action==='apk103.install'&&args.includes('install'))verify(file);
   released=false;
   result=await run({command,args,cwd:'.',timeout_ms:60000},{...options,nonInterruptible:command==='adb'&&(args.includes('install')||args.includes('uninstall'))});
   released=JSON.parse(result.stdout).workspaceReleased===true;
   results.push(result.commandResult);
   if(result.code!==0)break;
   if(p.action==='adb.connect'&&!/^(connected to|already connected to) /m.test(result.commandResult.stdout))throw Error('device_unavailable');
   if(command==='adb'&&args.includes('get-state')&&result.commandResult.stdout.trim()!=='device')throw Error('device_unavailable');
   if(command==='adb'&&(args.includes('install')||args.includes('uninstall'))&&!/^Success$/m.test(result.commandResult.stdout))throw Error('device_operation_failed');
   after?.(result);
  }
  if(!result)result={code:0,executionMode:'command',commandResult:{exit_code:0,stdout:'APK 103 validado pelo hash fixado.',stderr:'',error_code:null},stdout:JSON.stringify({status:'completed',answer:'APK 103 validado pelo hash fixado.',error:null,workspaceReleased:true}),stderr:''};
  const audit={action:p.action,target:p.target,at:new Date().toISOString(),status:result.code===0?'completed':'failed',authorization_policy:requiresConsent(p)?'signed-consent':'owner-approved-pinned-install-or-read',steps:results.map(r=>({exit_code:r.exit_code,error_code:r.error_code,started_at:r.started_at,completed_at:r.completed_at}))};
  const auditFile=record||path.join(dir,crypto.randomUUID()+'.json');fs.writeFileSync(auditFile,JSON.stringify(audit),{mode:0o600,flag:record?'w':'wx'});
  result.commandResult={...result.commandResult,action:p.action,steps:results};return result;
 }catch(e){
  const known=['cancelled','device_unavailable','device_operation_failed','device_identity_mismatch','android_incompatible','installed_package_unverified','installed_hash_mismatch','invalid_artifact'];
  const error_code=known.includes(e.message)?e.message:'device_action_refused';
  if(record){try{fs.writeFileSync(record,JSON.stringify({status:'failed_or_uncertain',error_code,at:new Date().toISOString(),steps:results.map(r=>({exit_code:r.exit_code,error_code:r.error_code}))}),{mode:0o600});}catch{}}
  return {code:1,executionMode:'command',commandResult:{error_code,steps:results},stdout:JSON.stringify({status:'failed',answer:'',error:'Ação de dispositivo recusada; valide artefato, conexão e autorização específica.',workspaceReleased:released}),stderr:''};}
}
module.exports={INSTALL_TARGET,requiresConsent,APK,actions,validate,consent,verify,execute};
