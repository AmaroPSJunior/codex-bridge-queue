'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.resolve(__dirname,'..');

test('bridge resolves the workspace from the checkout containing bridge.js',()=>{
  const source=fs.readFileSync(path.join(root,'bridge.js'),'utf8');
  assert.match(source,/const DIR = fs\.realpathSync\(__dirname\)/);
  assert.doesNotMatch(source,/const DIR = path\.join\(process\.env\.HOME,\s*['"]codex-bridge['"]\)/);
});

test('Supabase worker launches its own checkout bridge, not a global stale shim',()=>{
  const source=fs.readFileSync(path.join(root,'supabase-worker.js'),'utf8');
  assert.match(source,/spawn\(process\.execPath,\[path\.join\(DIR,'bridge\.js'\),prompt\]/);
  assert.doesNotMatch(source,/bin\/codex-bridge['"]\),\[prompt\]/);
});

test('the checkout path is stable even when the shell HOME differs',()=>{
  const expected=fs.realpathSync(root);
  const actual=fs.realpathSync(path.join(root,'tests','..'));
  assert.equal(actual,expected);
});
