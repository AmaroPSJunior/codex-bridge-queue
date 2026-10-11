'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {harness}=require('./harness.cjs');
test('runtime publication ACK requires exact remote status result and error',async t=>{
 let row={status:'running',result:null,error:null};const h=harness(t,'supabase-worker.js',{fetch:async()=>({ok:true,text:async()=>JSON.stringify([row])})});
 h.set('task',{id:'task'});h.set('run',{code:0,executionMode:'command',stdout:JSON.stringify({status:'completed',answer:'verified',error:null,workspaceReleased:true})});
 assert.equal(await h.run('verifyPublished(task,run)'),false);
 row={status:'succeeded',result:'different',error:null};assert.equal(await h.run('verifyPublished(task,run)'),false);
 row={status:'succeeded',result:'verified',error:null};assert.equal(await h.run('verifyPublished(task,run)'),true);
});
test('runtime library import does not start queue and state remains isolated',async t=>{
 const h=harness(t,'supabase-worker.js',{env:{CODEX_BRIDGE_LIBRARY_ONLY:'1'}});
 assert.equal(h.calls.length,0);assert.equal(h.logs.some(s=>s.includes('started')),false);
 assert.equal(typeof h.context.module.exports.execute,'function');
});
