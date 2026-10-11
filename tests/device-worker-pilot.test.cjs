'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {config,isAllowed,one}=require('../executors/device-worker-pilot.cjs');
const env={CODEX_SUPABASE_URL:'https://example.supabase.co',CODEX_SUPABASE_ANON_KEY:'public-anon-test',CODEX_DEVICE_TOKEN:'x'.repeat(48),CODEX_DEVICE_ID:'10000000-0000-4000-8000-000000000001'};
test('HTTPS, identity and per-device token are required',()=>{
 assert.equal(config(env).id,env.CODEX_DEVICE_ID);
 assert.throws(()=>config({...env,CODEX_SUPABASE_URL:'http://example.supabase.co'}));
 assert.throws(()=>config({...env,CODEX_DEVICE_TOKEN:'short'}));
});
test('pilot accepts only pwd, no arbitrary commands',()=>{
 assert.equal(isAllowed({execution_mode:'command',command_payload:{command:'pwd',args:[],cwd:'.'}}),true);
 for(const command of ['sh','id','ls','adb','rm','curl']){
  assert.equal(isAllowed({execution_mode:'command',command_payload:{command,args:[]}}),false);
 }
 assert.equal(isAllowed({execution_mode:'command',command_payload:{command:'pwd',args:[],cwd:'..'}}),false);
});
test('device pilot claims and completes only its task',async()=>{
 const calls=[];
 const fake=async(url,options)=>{
  const body=JSON.parse(options.body);
  calls.push({url,body});
  return {ok:true,json:async()=>url.endsWith('bridge_device_claim')
   ?[{task_id:'30000000-0000-4000-8000-000000000003',execution_mode:'command',
      claim_nonce:'a',command_payload:{command:'pwd',args:[],cwd:'.'}}]
   :true};
 };
 assert.equal(await one(config(env),{fetcher:fake,cwd:'/app'}),'completed');
 assert.equal(calls.length,2);
 assert.equal(calls[1].body.p_success,true);
 assert.equal(calls[1].body.p_claim_nonce,'a');
});
test('unsupported task is completed as failed without running',async()=>{
 const calls=[];
 const fake=async(url,options)=>{
  calls.push(JSON.parse(options.body));
  return {ok:true,json:async()=>url.endsWith('bridge_device_claim')
   ?[{task_id:'30000000-0000-4000-8000-000000000003',execution_mode:'command',claim_nonce:'a',command_payload:{command:'sh',args:['-c','echo hi']}}]
   :true};
 };
 assert.equal(await one(config(env),{fetcher:fake}),'rejected');
 assert.equal(calls[1].p_success,false);
});
