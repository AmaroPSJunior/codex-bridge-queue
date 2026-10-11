'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const store=require('../integrations/device-consent/store.cjs'),device=require('../executors/device-actions');
const password='offline-owner-password-not-real',task_id='00000000-0000-4000-8000-000000000055';
function input(){return {task_id,action:'apk103.install',target:'10.23.201.181:5555',ttl_seconds:120,confirmation:{stationary:true,park:true,parking_brake:true,clear_area:true,specific_action:true,data_loss:true}};}
function fixture(t){const home=fs.mkdtempSync(path.join(os.tmpdir(),'consent-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));store.setup(home,password);return home;}
test('private setup cannot overwrite config and authentication rejects wrong owner',t=>{
 const home=fixture(t);assert.equal(store.authenticated(home,password),true);assert.equal(store.authenticated(home,'wrong'),false);assert.throws(()=>store.setup(home,password));
 assert.equal(fs.statSync(path.join(store.dir(home),'config.json')).mode&511,384);
});
test('owner consent is durable, exact-scope, expiring and cannot be reissued',t=>{
 const home=fixture(t),i=input(),now=1000;const receipt=store.issue(home,i,now);assert.equal(receipt.authorization,undefined);assert.equal(receipt.signing_key,undefined);
 const g=store.grant(home,task_id),p={action:i.action,target:i.target,authorization:g.authorization};device.consent(p,task_id,g.key,now);
 assert.throws(()=>device.consent({...p,action:'app.uninstall'},task_id,g.key,now));
 assert.throws(()=>device.consent(p,task_id,g.key,now+120001));assert.throws(()=>store.issue(home,i,now));
 const record=JSON.parse(fs.readFileSync(path.join(store.dir(home),task_id+'.json')));assert.equal(record.owner,'local-password');assert.deepEqual(record.confirmation,i.confirmation);
});
test('missing conditions, arbitrary actions, excessive deadline and malformed task rejected',t=>{
 const home=fixture(t);
 for(const patch of [{confirmation:{}},{action:'adb.shell'},{ttl_seconds:301},{task_id:'../escape'},{target:'example.com:5555'}])assert.throws(()=>store.issue(home,{...input(),...patch}));
 for(const key of Object.keys(input().confirmation)){const i=input();i.confirmation[key]=false;assert.throws(()=>store.issue(home,i));}
});
test('unsafe credentials and grants fail closed',t=>{
 const home=fixture(t),c=path.join(store.dir(home),'config.json');fs.chmodSync(c,0o644);assert.throws(()=>store.config(home));fs.chmodSync(c,0o600);
 fs.symlinkSync(c,path.join(store.dir(home),task_id+'.json'));assert.throws(()=>store.grant(home,task_id));
});
test('HTTP requires authentication, exact Origin, explicit confirmation; never exposes signature',async t=>{
 const home=fixture(t),{createServer}=require('../integrations/device-consent/server.cjs');
 // Reserve an ephemeral loopback port, then enforce that exact Host/Origin.
 const net=require('node:net'),probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 const server=createServer({home,port});await new Promise(r=>server.listen(port,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});
 const url='http://127.0.0.1:'+port,headers={Authorization:'Basic '+Buffer.from('owner:'+password).toString('base64'),'Content-Type':'application/json',Origin:url};
 assert.equal((await fetch(url)).status,401);
 assert.equal((await fetch(url+'/consent',{method:'POST',headers:{...headers,Origin:'https://evil.invalid'},body:JSON.stringify(input())})).status,403);
 const response=await fetch(url+'/consent',{method:'POST',headers,body:JSON.stringify(input())});assert.equal(response.status,201);const body=await response.text();assert.ok(!body.includes('signature'));assert.ok(!body.includes(password));
 assert.equal((await fetch(url+'/consent',{method:'POST',headers,body:JSON.stringify(input())})).status,400);
});
test('exclusive consumption reservation survives re-read and concurrent attempts',async t=>{
 const home=fixture(t),root=store.dir(home);
 const results=await Promise.allSettled([1,2,3].map(()=>Promise.resolve().then(()=>store.reserve(root,task_id,{status:'reserved'}))));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.throws(()=>store.reserve(root,task_id,{status:'retry'}));
});
test('typed client payload is accepted but supplied authorization and commands cannot substitute owner consent',()=>{
 const {validate}=require('../executors/command');assert.deepEqual(validate({action:'apk103.install',target:'10.23.201.181:5555'}),{action:'apk103.install',target:'10.23.201.181:5555'});
 assert.throws(()=>validate({action:'apk103.install',target:'10.23.201.181:5555',authorization:{confirmed:true}}));
});
