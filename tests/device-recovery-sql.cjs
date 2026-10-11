'use strict';
// Disposable in-process PostgreSQL only. Never reads service configuration.
const {PGlite}=require('@electric-sql/pglite');
const fs=require('node:fs'),assert=require('node:assert/strict'),crypto=require('node:crypto');
(async()=>{
 const db=new PGlite();const id='10000000-0000-4000-8000-000000000001',token='A'.repeat(64);
 const q=async(sql,args)=>(await db.query(sql,args)).rows;
 const claim=()=>q('select * from bridge_device_claim($1,$2)',[id,token]);
 const recover=(t,retry,reason='reviewed')=>q('select bridge_device_recover($1,$2,$3,$4) as ok',[t.task_id,t.claim_nonce,retry,reason]).then(r=>r[0].ok);
 const complete=(t,result='ok',credential=token)=>q('select bridge_device_complete($1,$2,$3,$4,true,$5) as ok',[id,credential,t.task_id,t.claim_nonce,result]).then(r=>r[0].ok);
 const expire=t=>q("update bridge_tasks set device_lease_expires_at=now()-interval '1 second' where id=$1",[t.task_id]);
 const enqueue=async(payload={command:'pwd',args:[],cwd:'.'})=>q("insert into bridge_tasks(id,instruction,status,executor_device_id,command_payload) values(gen_random_uuid(),'test','queued',$1,$2)",[id,JSON.stringify(payload)]);
 try{
  await db.exec("create role anon;create role authenticated;create role service_role;create table bridge_tasks(id uuid primary key,task_number bigint,instruction text,status text,execution_mode text default 'command',command_payload jsonb,executor_device_id uuid,created_at timestamptz default now(),claimed_at timestamptz,updated_at timestamptz,completed_at timestamptz,result text,error text)");
  for(const f of ['phase1','phase2-draft','phase3-recovery-proposal'])await db.exec(fs.readFileSync('database/multi-device-'+f+'.sql','utf8'));
  await db.exec(fs.readFileSync('database/multi-device-phase3-recovery-proposal.sql','utf8'));
  await q("insert into bridge_devices(id,display_name,device_kind,enabled,token_sha256) values($1,'test','android_head_unit',true,$2)",[id,crypto.createHash('sha256').update(token).digest('hex')]);
  for(const role of ['anon','authenticated','service_role']){
   await db.exec('begin;set local role '+role);
   await assert.rejects(q('select bridge_device_recover(gen_random_uuid(),gen_random_uuid(),true,\'test\')'));
   await db.exec('rollback');
  }
  await enqueue();const [first]=await claim();
  const deadline=(await q('select extract(epoch from(device_lease_expires_at-claimed_at)) as seconds from bridge_tasks where id=$1',[first.task_id]))[0];
  assert.equal(Number(deadline.seconds),300);
  assert.equal(await recover(first,true),false,'no early recovery');
  assert.equal(await complete(first,'ok','wrong'),false);
  await expire(first);
  assert.equal(await recover(first,true),true);
  assert.equal(await recover(first,true),true,'same authorization is idempotent');
  assert.equal(await recover(first,true,'conflicting reason'),false,'conflicting authorization rejected');
  assert.equal(await complete(first),false,'old completion fenced before new claim');
  const [second]=await claim();assert.equal(second.task_id,first.task_id);assert.notEqual(second.claim_nonce,first.claim_nonce);
  assert.equal(await complete(first),false,'old completion fenced after new claim');
  assert.equal(await complete(second),true);
  assert.equal(await complete(second),true,'lost response reconciles');
  assert.equal(await complete(second,'different'),false,'conflicting duplicate rejected');
  await q("delete from bridge_tasks where id=$1",[second.task_id]);
  assert.equal(await complete(second),true,'receipt survives task retention');
  await q('update bridge_devices set revoked_at=now() where id=$1',[id]);
  assert.equal(await complete(second),false,'revoked token cannot reconcile');
  assert.equal((await claim()).length,0);
  await q('update bridge_devices set revoked_at=null,enabled=false where id=$1',[id]);
  assert.equal((await claim()).length,0);
  await q('update bridge_devices set enabled=true where id=$1',[id]);
  await enqueue({command:'sh',args:['-c','touch x'],cwd:'.'});const [unsafe]=await claim();await expire(unsafe);
  assert.equal(await recover(unsafe,true),false,'effects never retried');
  assert.equal(await recover(unsafe,false),true,'uncertainty recorded without requeue');
  assert.equal((await q('select status from bridge_tasks where id=$1',[unsafe.task_id]))[0].status,'running');
  assert.equal((await claim()).length,0,'no automatic retry');
  await enqueue();const [edited]=await claim();await expire(edited);
  await q('update bridge_tasks set command_payload=$2 where id=$1',[edited.task_id,JSON.stringify({command:'rm',args:[]})]);
  assert.equal(await recover(edited,true),false,'payload edit fails closed');
  await enqueue();const [legacy]=await claim();await q('update bridge_tasks set device_lease_expires_at=null where id=$1',[legacy.task_id]);
  assert.equal(await recover(legacy,true),false,'old claim needs explicit investigation');
  await assert.rejects(q('update bridge_device_recovery_config set lease_seconds=0'));
  await q('update bridge_device_recovery_config set lease_seconds=60');
  await enqueue();const [configured]=await claim();
  assert.equal(Number((await q('select extract(epoch from(device_lease_expires_at-claimed_at)) as seconds from bridge_tasks where id=$1',[configured.task_id]))[0].seconds),60);
  console.log('PASS recovery: lease, authorization, fencing, no effect replay, receipts, revocation and compatibility');
 }finally{await db.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
