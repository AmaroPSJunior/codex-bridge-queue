'use strict';
const {PGlite}=require('@electric-sql/pglite');
const fs=require('node:fs');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
(async()=>{
 const db=new PGlite();
 try {
  await db.exec("create role anon nologin; create role authenticated nologin;");
  await db.exec("create table public.bridge_tasks(id uuid primary key,task_number bigint,instruction text not null,title text not null default 'Tarefa',status text not null,execution_mode text default 'command',command_payload jsonb,executor_device_id uuid,created_at timestamptz default now(),claimed_at timestamptz,updated_at timestamptz,completed_at timestamptz,result text,error text,progress_seq bigint not null default 0,recent_output text,progress_message text,last_progress_at timestamptz,last_flush_reason text,last_flush_line_count int)");
  for (const [file,func,trigger] of [
   ['database/task-identity.sql','bridge_tasks_human_identity',"create trigger bridge_tasks_human_identity before insert or update on bridge_tasks for each row execute function public.bridge_tasks_human_identity()"],
   ['database/task-progress.sql','bridge_progress_guard',"create trigger bridge_progress_guard before insert or update of progress_seq,recent_output,progress_message,last_progress_at,last_flush_reason,last_flush_line_count on bridge_tasks for each row execute function public.bridge_progress_guard()"]
  ]) {
   const source=fs.readFileSync(file,'utf8');
   const start=source.indexOf('CREATE OR REPLACE FUNCTION public.'+func+'()');
   const end=source.indexOf('END; $$;',start);
   assert.ok(start>=0&&end>=0,func+' source not found');
   await db.exec(source.slice(start,end+'END; $$;'.length));
   await db.exec(trigger);
  }
  await db.exec("create schema bridge_dashboard_private; create table bridge_dashboard_private.events(event text);");
  await db.exec("create function bridge_dashboard_private.notify() returns trigger language plpgsql as $$ begin insert into bridge_dashboard_private.events values ('changed'); return new; end $$;");
  await db.exec("create function bridge_dashboard_private.retain() returns trigger language plpgsql as $ begin delete from public.bridge_tasks as target_task where target_task.task_number in (select candidate_task.task_number from public.bridge_tasks as candidate_task where candidate_task.task_number is not null and candidate_task.status in ('succeeded','failed','cancelled') and candidate_task.task_number not in (select recent_task.task_number from public.bridge_tasks as recent_task order by recent_task.task_number desc limit 100)); insert into bridge_dashboard_private.events values ('retain'); return null; end $;");
  await db.exec("create trigger bridge_dashboard_changed after insert or delete or update on bridge_tasks for each row execute function bridge_dashboard_private.notify()");
  await db.exec("create trigger bridge_tasks_retention_100_insert after insert on bridge_tasks for each statement execute function bridge_dashboard_private.retain()");
  await db.exec("create trigger bridge_tasks_retention_100_update after update on bridge_tasks for each statement execute function bridge_dashboard_private.retain()");
  await db.exec(fs.readFileSync('database/multi-device-phase1.sql','utf8'));
  await db.exec(fs.readFileSync('database/multi-device-phase2-draft.sql','utf8'));
  const token='z'.repeat(48),id='10000000-0000-4000-8000-000000000001',task='20000000-0000-4000-8000-000000000002';
  const hash=crypto.createHash('sha256').update(token).digest('hex');
  await db.query("insert into bridge_devices(id,display_name,device_kind,enabled,token_sha256) values($1,'BYD','android_head_unit',true,$2)",[id,hash]);
  await db.query("insert into bridge_tasks(id,task_number,instruction,title,status,executor_device_id,command_payload) values($1,1,'diagnostic','Test','queued',$2,'{\"command\":\"pwd\"}')",[task,id]);
  const claims=(await db.query('select * from bridge_device_claim($1,$2)',[id,token])).rows;
  assert.equal(claims.length,1);
  const response=(await db.query("select bridge_device_complete($1,$2,$3,$4,true,'ok') as done",[id,token,task,claims[0].claim_nonce])).rows;
  assert.equal(response[0].done,true);
  const state=(await db.query('select status,progress_seq,title from bridge_tasks where id=$1',[task])).rows[0];
  assert.equal(state.status,'succeeded');
  assert.equal(Number(state.progress_seq),0);
  const events=(await db.query('select event,count(*)::int as n from bridge_dashboard_private.events group by event')).rows;
  assert.ok(events.some(e=>e.event==='changed'&&e.n>=3));
  assert.ok(events.some(e=>e.event==='retain'&&e.n>=3));
  console.log('PASS: actual identity/progress triggers; mocked dashboard notification and retention hooks');
 } finally {await db.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
