'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {FIELDS,observation,identifier}=require('../executors/task-metadata');
const {selectProvider}=require('../executors/provider-config'),{harness}=require('./harness.cjs');
const task={id:'task',...Object.fromEntries(FIELDS.map(k=>[k,null]))};
function run(provider='groq',code=0,error){return {code,providerSelection:{provider},providerErrorCode:error,stdout:JSON.stringify({status:code?'failed':'completed',threadId:'session-123'})};}
test('legacy schema emits no metadata; new schema stores only allowlisted observations',()=>{
 assert.equal(observation({id:'old'},run()),null);
 const value=observation(task,run(),{});assert.equal(value.p_actual,'groq');assert.equal(value.p_state,'ready');assert.equal(value.p_model,'openai/gpt-oss-120b');
 assert.equal(value.p_session,'session-123');assert.equal(value.p_fallback_from,undefined);
});
test('operational states have no raw errors and reject known credentials',()=>{
 for(const [code,state] of [['quota','quota_exceeded'],['rate_limit','quota_exceeded'],['authentication','auth_error'],['permission','auth_error'],['network','unavailable']])assert.equal(observation(task,run('groq',1,code)).p_state,state);
 assert.equal(identifier('privateValue',128,{GROQ_API_KEY:'privateValue'}),null);assert.equal(identifier('gsk_test',128,{}),null);
 assert.equal(observation(task,run('local'),{LOCAL_AI_MODEL:'password=abc'}).p_model,null);
});
test('requested_provider has priority, old ai_provider remains compatible',()=>{
 assert.equal(selectProvider({task:{requested_provider:'groq',ai_provider:'codex'},env:{}}).provider,'groq');
 assert.equal(selectProvider({task:{requested_provider:null,ai_provider:'codex'},env:{}}).provider,'codex');
 assert.throws(()=>selectProvider({task:{requested_provider:'invalid'},env:{AI_PROVIDER:'codex'}}));
});
test('worker writes observations before final state, skips old schema and retains receipt on telemetry failure',async t=>{
 for(const available of [true,false]){
  const calls=[];const h=harness(t,'supabase-worker.js',{fetch:async(url,opts)=>{calls.push({url,body:JSON.parse(opts.body)});if(url.includes('/rpc/')){if(!available)throw Error('sensitive');return {ok:true,text:async()=> 'true'};}return {ok:true,text:async()=>''};}});
  h.set('t',task);h.set('r',run());if(available){await h.run('finish(t,r)');assert.equal(calls[1].body.status,'succeeded');}else{await assert.rejects(h.run('finish(t,r)'));assert.equal(calls.length,1);}assert.ok(calls[0].url.includes('rpc/bridge_record_multi_ai'));
  assert.ok(!JSON.stringify(h.logs).includes('sensitive'));
 }
});
