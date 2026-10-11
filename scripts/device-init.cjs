'use strict';
// Generate a fresh per-device identity exclusively on the Termux target.
// No database access, no token in logs, no secret material in the repository.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),os=require('node:os');
function init({home=os.homedir(),name='Central BYD Dolphin Plus',kind='android_head_unit'}={}){
 if(!['android_head_unit','android_phone'].includes(kind)||name.length<1||name.length>80)throw Error('Invalid device metadata');
 const root=path.join(home,'.config','codex-bridge');
 fs.mkdirSync(root,{recursive:true,mode:0o700});
 const st=fs.lstatSync(root);
 if(!st.isDirectory()||(st.mode&0o077)!==0)throw Error('Private directory permissions unsafe');
 const entries=fs.readdirSync(root).filter(n=>/^device-[a-f0-9-]+\.json$/.test(n));
 if(entries.length)throw Error('Device identity already exists; refusing to rotate automatically');
 const id=crypto.randomUUID();
 const token=crypto.randomBytes(48).toString('base64url');
 const hash=crypto.createHash('sha256').update(token).digest('hex');
 const file=path.join(root,'device-'+id+'.json');
 const fd=fs.openSync(file,'wx',0o600);
 try{fs.writeFileSync(fd,JSON.stringify({device_id:id,token})+'\n');fs.fsyncSync(fd);}
 finally{fs.closeSync(fd)}
 return {device_id:id,display_name:name,device_kind:kind,token_sha256:hash,credential_file:file,enabled:false};
}
if(require.main===module){
 try{console.log(JSON.stringify(init()));}
 catch(e){console.error('Identity initialization refused: '+e.message);process.exitCode=1;}
}
module.exports={init};
