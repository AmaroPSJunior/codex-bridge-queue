'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process');
const inspect=path.resolve(__dirname,'../scripts/inspect-workspace-lock.cjs');
test('diagnostics never mutates uncertain lock or discloses token',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'lock-observe-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const dir=path.join(root,'.bridge-workspace-lock');fs.mkdirSync(dir,{mode:0o700});
 const owner=path.join(dir,'owner.json'),secret='test-private-token-never-print';
 fs.writeFileSync(owner,JSON.stringify({version:1,token:secret,pid:99999999,state:'uncertain'}),{mode:0o600});
 const before=fs.readFileSync(owner,'utf8');
 const result=cp.spawnSync(process.execPath,[inspect,root],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
 assert.equal(fs.readFileSync(owner,'utf8'),before);
 assert.doesNotMatch(result.stdout, /test-private-token/);
 assert.match(result.stdout,/"state": "uncertain"/);
 assert.ok(fs.existsSync(dir));
});
test('missing lock returns observation only',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'lock-observe-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const result=cp.spawnSync(process.execPath,[inspect,root],{encoding:'utf8'});
 assert.equal(result.status,0);
 assert.match(result.stdout,/"state": "absent"/);
});
