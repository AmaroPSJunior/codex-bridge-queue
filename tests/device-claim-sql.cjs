'use strict';
const {PGlite}=require('@electric-sql/pglite');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const crypto=require('node:crypto');
(async()=>{
 const db=new PGlite();
 const a='10000000-0000-4000-8000-000000000001',b='20000000-0000-4000-8000-000000000002';
 const ta='30000000-0000-4000-8000-000000000003',tb='40000000-0000-4000-8000-000000000004';
 const tokenA='A'.repeat(48),tokenB='B'.repeat(48);
 const sha=t=>crypto.createHash('sha256').update(t).digest('hex');
 const rows=async(q,params)=>(await db.query(q,params)).rows;
 try{
  await db.exec("create role anon nologin; create role authenticated nologin;");
  await db.exec("create table bridge_tasks(id uuid primary key,task_number bigint,instruction text,status text,execution_mode text default 'command',command_payload jsonb,executor_device_id uuid,created_at timestamptz default now(),claimed_at timestamptz,updated_at timestamptz,completed_at timestamptz,result text,error text)");
  await db.exec(fs.readFileSync('database/multi-device-phase1.sql','utf8'));
  await db.exec(fs.readFileSync('database/multi-device-phase2-draft.sql','utf8'));
  await db.exec(fs.readFileSync('database/multi-device-phase2-draft.sql','utf8'));
  await rows("insert into bridge_devices(id,display_name,device_kind,enabled,token_sha256) values ($1,'phone','android_phone',true,$2),($3,'BYD','android_head_unit',true,$4)",[a,sha(tokenA),b,sha(tokenB)]);
  await rows("insert into bridge_tasks(id,task_number,instruction,status,executor_device_id,command_payload) values ($1,1,'phone','queued',$2,'{\"command\":\"pwd\"}'),($3,2,'BYD','queued',$4,'{\"command\":\"pwd\"}')",[ta,a,tb,b]);
  // Use the actual low-privilege anon role: it must not inspect or mutate
  // task rows directly, but can invoke the authenticated claim RPC.
  for(const forbidden of ['select * from public.bridge_tasks',"update public.bridge_tasks set status='running'"]){
   await db.exec("begin; set local role anon;");
   await assert.rejects(rows(forbidden));
   await db.exec("rollback"); // PostgreSQL aborts the current transaction on permission errors.
  }
  await db.exec("begin; set local role anon;");
  assert.equal((await rows("select count(*)::int as count from public.bridge_device_claim($1,$2)",[a,tokenB]))[0].count,0);
  await db.exec("rollback");
  const claim=(id,token)=>rows('select * from bridge_device_claim($1,$2)',[id,token]);
  assert.equal((await claim(a,tokenB)).length,0);
  const [first]=await claim(a,tokenA);
  assert.equal(first.task_id,ta);
  assert.equal((await claim(a,tokenA)).length,0);
  const [second]=await claim(b,tokenB);
  assert.equal(second.task_id,tb);
  const complete=(id,token,task,nonce,output)=>rows("select bridge_device_complete($1,$2,$3,$4,true,$5) as ok",[id,token,task,nonce,output]);
  assert.equal((await complete(b,tokenB,ta,first.claim_nonce,'spoof'))[0].ok,false);
  assert.equal((await complete(a,tokenA,ta,second.claim_nonce,'stale'))[0].ok,false);
  assert.equal((await complete(a,tokenA,ta,first.claim_nonce,'ok'))[0].ok,true);
  assert.equal((await complete(a,tokenA,ta,first.claim_nonce,'duplicate'))[0].ok,false);
  await rows('update bridge_devices set revoked_at=now() where id=$1',[b]);
  assert.equal((await complete(b,tokenB,tb,second.claim_nonce,'revoked'))[0].ok,false);
  assert.equal((await rows('select status from bridge_tasks where id=$1',[tb]))[0].status,'running');
  console.log('DEVICE SQL PASS: isolated claims, fencing, revocation, idempotency');
 }finally{await db.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
