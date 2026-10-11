const {PGlite}=require('@electric-sql/pglite');
const assert=require('node:assert/strict');
const fs=require('node:fs');
(async()=>{
 const db=new PGlite();
 try{
  await db.exec("create table public.bridge_tasks(id int primary key,status text not null,executor_device_id uuid); insert into public.bridge_tasks(id,status) values (1,'queued'),(2,'queued')");
  const sql=fs.readFileSync('database/multi-device-phase1.sql','utf8');
  await db.exec(sql);
  await db.exec(sql);
  const devices=await db.query("select relrowsecurity from pg_class where relname='bridge_devices'");
  assert.equal(devices.rows[0].relrowsecurity,true);
  await db.exec("update public.bridge_tasks set status='running' where id=1");
  assert.equal((await db.query('select status from bridge_tasks where id=1')).rows[0].status,'running');
  await db.exec("update public.bridge_tasks set executor_device_id='00000000-0000-4000-8000-000000000001' where id=2");
  await assert.rejects(db.exec("update public.bridge_tasks set status='running' where id=2"),/Targeted tasks require/);
  assert.equal((await db.query('select status from bridge_tasks where id=2')).rows[0].status,'queued');
  console.log('Multi-device phase 1: legacy claim preserved, targeted claim blocked, RLS enabled');
 }finally{await db.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
