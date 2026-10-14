'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto'),{createRequire}=require('node:module');
const real=require('../executors/device-actions');
function fixture(t){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'pinned-install-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 const dir=path.join(home,'.config/codex-bridge/device-actions');fs.mkdirSync(dir,{recursive:true,mode:0o700});
 const bytes=Buffer.from('OFFLINE FIXTURE: NOT AN APK');fs.writeFileSync(path.join(dir,real.APK.name),bytes,{mode:0o600});
 const filename=require.resolve('../executors/device-actions'),requireReal=createRequire(filename),module={exports:{}};
 // Test-only crypto double makes a synthetic file represent the pinned artifact.
 // No verification override or alternate hash is exposed by production code.
 const fakeCrypto={...crypto,createHash:algorithm=>{const h=crypto.createHash(algorithm);let pinned=false;return {update(data){pinned=Buffer.isBuffer(data)&&data.equals(bytes);h.update(data);return this;},digest(encoding){return pinned?real.APK.sha256:h.digest(encoding);}};}};
 vm.runInNewContext(fs.readFileSync(filename,'utf8'),{require:name=>name==='node:crypto'?fakeCrypto:requireReal(name),module,Buffer,process},{filename});
 const calls=[];let model='BYD AUTO',sdk='29',installedHash=real.APK.sha256,installCode=0;
 const runner=async spec=>{calls.push(spec);const a=spec.args;let stdout=a.includes('get-state')?'device\n':a.includes('ro.product.model')?model+'\n':a.includes('ro.build.version.sdk')?sdk+'\n':a.includes('install')?'Success\n':a.includes('sha256sum')?installedHash+'  /data/app/example/base.apk\n':'package:/data/app/example/base.apk\n';const code=a.includes('install')?installCode:0;return {code,stdout:JSON.stringify({status:code?'failed':'completed',workspaceReleased:true}),commandResult:{exit_code:code,stdout,stderr:'',error_code:code?'execution':null}};};
 return {home,dir,api:module.exports,runner,calls,options:{env:{HOME:home},taskId:'00000000-0000-4000-8000-000000000091'},setModel:v=>model=v,setSdk:v=>sdk=v,setHash:v=>installedHash=v,setInstallCode:v=>installCode=v};
}
const request={action:'apk103.install',target:'10.42.0.25:5555'};
test('install policy is independent of DHCP address; uninstall still requires consent',()=>{
 assert.equal(real.requiresConsent(request),false);
 assert.equal(real.requiresConsent({...request,target:'192.168.50.77:5555'}),false);
 assert.equal(real.requiresConsent({action:'app.uninstall',target:request.target}),true);
 for(const extra of [{apk:'/tmp/other.apk'},{package:'other'},{args:['uninstall']},{authorization:{}}])assert.throws(()=>real.validate({...request,...extra}));
});
test('offline install pipeline has no consent setup, preserves data, verifies installed hash and prevents replay',async t=>{
 const f=fixture(t);const r=await f.api.execute(request,f.options,f.runner);assert.equal(r.code,0);
 const install=f.calls.find(c=>c.args.includes('install'));assert.deepEqual(Array.from(install.args),['-s',request.target,'install','--user','0','-r',path.join(f.dir,real.APK.name)]);
 assert.equal(f.calls.some(c=>c.args.includes('uninstall')),false);assert.ok(f.calls.some(c=>c.args.includes('sha256sum')));
 const n=f.calls.length;assert.equal((await f.api.execute(request,f.options,f.runner)).code,1);assert.equal(f.calls.length,n);
 const receipt=JSON.parse(fs.readFileSync(path.join(f.dir,crypto.createHash('sha256').update(f.options.taskId).digest('hex')+'.json')));
 assert.equal(receipt.status,'completed');assert.equal(receipt.authorization_policy,'owner-approved-pinned-install-or-read');
});
test('a different private DHCP address is allowed; uninstall still requires signed consent',async t=>{
 const f=fixture(t),other={...request,target:'192.168.50.77:5555'};assert.equal((await f.api.execute(other,f.options,f.runner)).code,0);
 const g=fixture(t);assert.equal((await g.api.execute({...request,action:'app.uninstall'},g.options,g.runner)).code,1);assert.equal(g.calls.length,0);
});
test('wrong identity and incompatible Android block install',async t=>{
 for(const kind of ['model','sdk']){const f=fixture(t);if(kind==='model')f.setModel('OTHER DEVICE');else f.setSdk('23');assert.equal((await f.api.execute(request,f.options,f.runner)).code,1);assert.equal(f.calls.some(c=>c.args.includes('install')),false);}
});
test('corrupted artifact blocks before ADB and symlink remains refused',async t=>{
 const f=fixture(t),file=path.join(f.dir,real.APK.name);fs.writeFileSync(file,'corrupt');assert.equal((await f.api.execute(request,f.options,f.runner)).code,1);assert.equal(f.calls.length,0);
 fs.unlinkSync(file);fs.symlinkSync('/dev/null',file);assert.equal((await f.api.execute(request,f.options,f.runner)).code,1);assert.equal(f.calls.length,0);
});
test('signature/install rejection never triggers uninstall or false success',async t=>{
 const f=fixture(t);f.setInstallCode(1);assert.equal((await f.api.execute(request,f.options,f.runner)).code,1);assert.equal(f.calls.some(c=>c.args.includes('uninstall')),false);assert.equal(f.calls.some(c=>c.args.includes('sha256sum')),false);
});
test('installed hash mismatch fails, cancellation before start does nothing',async t=>{
 const f=fixture(t);f.setHash('0'.repeat(64));const r=await f.api.execute(request,f.options,f.runner);assert.equal(r.code,1);assert.equal(r.commandResult.error_code,'installed_hash_mismatch');
 const g=fixture(t),controller=new AbortController();controller.abort();assert.equal((await g.api.execute(request,{...g.options,signal:controller.signal},g.runner)).code,1);assert.equal(g.calls.length,0);
});
