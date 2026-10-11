'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {loadPrivate}=require('../executors/device-worker-start.cjs');
test('private credential file stays out of command arguments and code repository',()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'device-boot-'));
 try{
  const dir=path.join(home,'.config','codex-bridge');
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  fs.chmodSync(dir,0o700);
  const file=path.join(dir,'device-test.json');
  fs.writeFileSync(file,JSON.stringify({device_id:'10000000-0000-4000-8000-000000000001',token:'z'.repeat(64)}),{mode:0o600});
  const config=loadPrivate(file,{CODEX_SUPABASE_URL:'https://example.supabase.co',CODEX_SUPABASE_ANON_KEY:'public-key'},home);
  assert.equal(config.CODEX_DEVICE_ID,'10000000-0000-4000-8000-000000000001');
  assert.equal(config.CODEX_DEVICE_WORKER_ENABLED,'1');
  assert.equal(config.CODEX_DEVICE_TOKEN,'z'.repeat(64));
  fs.chmodSync(file,0o644);
  assert.throws(()=>loadPrivate(file,{CODEX_SUPABASE_URL:'https://example.supabase.co',CODEX_SUPABASE_ANON_KEY:'public-key'},home));
  fs.chmodSync(file,0o600);
  fs.chmodSync(dir,0o755);
  assert.throws(()=>loadPrivate(file,{CODEX_SUPABASE_URL:'https://example.supabase.co',CODEX_SUPABASE_ANON_KEY:'public-key'},home));
 }finally{fs.rmSync(home,{recursive:true,force:true})}
});
