'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

test('Termux supervisor must not force deterministic-only queue mode',()=>{
  const source=fs.readFileSync(path.join(__dirname,'..','autostart','supabase-launcher.py'),'utf8');
  assert.equal(source.includes("CODEX_BRIDGE_DETERMINISTIC_ONLY'] = '1'"),false);
  assert.equal(source.includes("env.pop('CODEX_BRIDGE_DETERMINISTIC_ONLY', None)"),true);
});
