'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createGate}=require('../executors/auto-continue');
function fixture(fn){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-gate-'));try{fn(dir);}finally{fs.rmSync(dir,{recursive:true,force:true});}}
test('disabled by default, does not write state',()=>fixture(dir=>{
 const gate=createGate({dir,env:{}});gate.record('a','failed');assert.equal(gate.canClaim(),true);assert.deepEqual(fs.readdirSync(dir),[]);
}));
test('successful preauthorized tasks bounded and persisted',()=>fixture(dir=>{
 const env={CODEX_BRIDGE_AUTOCONTINUE:'1',CODEX_BRIDGE_AUTOCONTINUE_MAX:'2'};
 const gate=createGate({dir,env});gate.record('a','succeeded');gate.record('a','succeeded');
 assert.equal(gate.status().count,1);assert.equal(gate.canClaim(),true);
 const restarted=createGate({dir,env});restarted.record('b','succeeded');
 assert.equal(restarted.canClaim(),false);assert.equal(createGate({dir,env}).status().count,2);
}));
test('failure blocks future claims across restarts',()=>fixture(dir=>{
 const env={CODEX_BRIDGE_AUTOCONTINUE:'1'};
 createGate({dir,env}).record('a','failed');
 assert.equal(createGate({dir,env}).canClaim(),false);
}));
test('corrupt state fails closed',()=>fixture(dir=>{
 fs.writeFileSync(path.join(dir,'autocontinue-state.json'),'{broken');
 assert.equal(createGate({dir,env:{CODEX_BRIDGE_AUTOCONTINUE:'1'}}).canClaim(),false);
}));
