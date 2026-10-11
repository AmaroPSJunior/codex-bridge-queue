'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const d=require('../executors/device-actions');
test('typed actions accept current private IP but reject shell, public targets and arbitrary fields',()=>{
 assert.equal(d.validate({action:'adb.connect',target:'10.23.201.181:5555'}).action,'adb.connect');
 for(const target of ['8.8.8.8:5555','10.1.1.1;id:5555','10.1.1.1:22','127.0.0.1:5555'])assert.throws(()=>d.validate({action:'adb.connect',target}));
 assert.throws(()=>d.validate({action:'adb.shell',target:'10.23.201.181:5555'}));
 assert.throws(()=>d.validate({action:'adb.connect',target:'10.23.201.181:5555',args:['shell']}));
});
test('destructive consent binds task, action, target, artifact and five-minute expiry',()=>{
 const key='synthetic-authorization-key-for-offline-tests',id='00000000-0000-4000-8000-000000000001',now=1000;
 const p={action:'app.uninstall',target:'10.23.201.181:5555',authorization:{expires_at:2000}};
 p.authorization.signature=crypto.createHmac('sha256',key).update(JSON.stringify([id,p.action,p.target,d.APK.sha256,2000,'stationary-P-brake-clear-area','data-loss-consented'])).digest('hex');
 d.consent(p,id,key,now);
 for(const changed of [{...p,action:'apk103.install'},{...p,target:'10.23.201.182:5555'}])assert.throws(()=>d.consent(changed,id,key,now));
 assert.throws(()=>d.consent(p,id,key,2001));assert.throws(()=>d.consent(p,id,undefined,now));
});
test('mutations without authorization never spawn; arbitrary artifact and symlink refused',async t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'device-test-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 for(const action of ['app.uninstall','apk103.install']){
  const r=await d.execute({action,target:'10.23.201.181:5555'},{env:{HOME:home}},()=>assert.fail('must not spawn'));assert.equal(r.code,1);
 }
 const file=path.join(home,'bad.apk');fs.writeFileSync(file,'not an apk');assert.throws(()=>d.verify(file));
 const link=path.join(home,'link.apk');fs.symlinkSync(file,link);assert.throws(()=>d.verify(link));
});
test('connect uses only fixed argv and produces private audit without credentials',async t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'device-test-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));const calls=[];
 const r=await d.execute({action:'adb.connect',target:'10.23.201.181:5555'},{env:{HOME:home}},async spec=>{calls.push(spec);return {code:0,commandResult:{exit_code:0,stdout:'connected to 10.23.201.181:5555',error_code:null},stdout:JSON.stringify({workspaceReleased:true})};});
 assert.equal(r.code,0);assert.deepEqual(calls[0].args,['connect','10.23.201.181:5555']);
 const dir=path.join(home,'.config/codex-bridge/device-actions');assert.equal(fs.statSync(dir).mode&511,448);
 assert.equal(fs.statSync(path.join(dir,fs.readdirSync(dir)[0])).mode&511,384);
});
test('uncertain runner failure retains workspace fence',async t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'device-test-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 const r=await d.execute({action:'adb.connect',target:'10.23.201.181:5555'},{env:{HOME:home}},async()=>{throw Error('uncertain');});
 assert.equal(r.code,1);assert.equal(JSON.parse(r.stdout).workspaceReleased,false);
});
