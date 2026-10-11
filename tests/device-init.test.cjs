'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {init,registration}=require('../scripts/device-init.cjs');
test('local enrollment stores only token file while public output contains only hash',()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'device-init-'));
 try{
  const result=init({home});
  const secret=JSON.parse(fs.readFileSync(result.credential_file,'utf8'));
  assert.equal(secret.device_id,result.device_id);
  assert.equal(crypto.createHash('sha256').update(secret.token).digest('hex'),result.token_sha256);
  assert.ok(secret.token.length>=43);
  assert.ok(!JSON.stringify(result).includes(secret.token));
  assert.equal(fs.statSync(result.credential_file).mode & 0o077,0);
  assert.equal(fs.statSync(path.dirname(result.credential_file)).mode & 0o077,0);
  assert.deepEqual(registration(home).device_id,result.device_id);
  assert.equal(registration(home).token_sha256,result.token_sha256);
  assert.throws(()=>init({home}),/already exists/);
 }finally{fs.rmSync(home,{recursive:true,force:true})}
});
