'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const {resolve}=require('node:path');
test('bridge reboot shell syntax must parse before stopping workers',()=>{
 const file=resolve(__dirname,'../recovery/bridge-reboot');
 const result=spawnSync('bash',['-n',file],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
});
