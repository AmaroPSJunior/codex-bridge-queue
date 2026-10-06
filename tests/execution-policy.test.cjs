'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

test('Termux queue keeps natural-language agent tasks enabled',()=>{
  const file=path.join(__dirname,'..','execution-policy.json');
  const policy=JSON.parse(fs.readFileSync(file,'utf8'));
  assert.equal(policy.version,1);
  assert.equal(policy.deterministic_only,false,
    'deterministic_only=true blocks normal queued tasks with "Modo agent desativado"');
});
