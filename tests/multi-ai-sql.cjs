// Disposable PostgreSQL/WASM only; never connects to a server.
const {PGlite}=require('@electric-sql/pglite'),fs=require('node:fs'),assert=require('node:assert/strict');
(async()=>{const db=new PGlite();const id='00000000-0000-0000-0000-000000000001';
try{
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 create table public.bridge_tasks(id uuid primary key,instruction text,status text check(status in ('queued','running','succeeded','failed','cancelled','paused')),created_at timestamptz default now(),claimed_at timestamptz);
 alter table public.bridge_tasks enable row level security;grant select,update on public.bridge_tasks to service_role;
 insert into public.bridge_tasks values('${id}','private','paused',now(),now());`);
 const sql=fs.readFileSync('database/task-multi-ai.sql','utf8');
 const old=sql.split('$old$')[1];
 await db.exec(`create schema bridge_dashboard_private;create function bridge_dashboard_private.bridge_dashboard_safe(text,integer) returns text language sql as $$select left($1,$2)$$;create function bridge_dashboard_private.bridge_dashboard_projection(p_row jsonb) returns jsonb language sql as $body$${old}$body$;`);
 await db.exec(sql);await db.exec(sql);
 const projected=(await db.query(`select bridge_dashboard_private.bridge_dashboard_projection('{"actual_provider":"groq","provider_session_id":"private"}'::jsonb) as p`)).rows[0].p;
 assert.equal(projected.actual_provider,'groq');assert.equal(projected.provider_session_id,undefined);
 let row=(await db.query(`select * from public.bridge_tasks`)).rows[0];assert.equal(row.status,'paused');assert.equal(row.actual_provider,null);
 for(const value of ["requested_provider='wrong'","actual_provider='auto'","provider_session_id='gsk_private'","fallback_from='codex'","actual_provider='groq',fallback_from='groq',fallback_reason='manual'"])
  await assert.rejects(db.exec(`update public.bridge_tasks set ${value}`));
 await db.exec(`set role anon`);await assert.rejects(db.query('select * from public.bridge_provider_state'));await assert.rejects(db.query(`select public.bridge_record_multi_ai('${id}','codex','codex',null,null,'ready')`));await db.exec('reset role');
 await db.exec('set role authenticated');await assert.rejects(db.query('select public.bridge_dashboard_multi_ai()'));await db.exec('reset role');
 await db.exec(`create function bridge_dashboard_private.bridge_dashboard_allowed(p_logs boolean default false) returns boolean language sql as $$select current_setting('bridge.test_allowed',true)='yes'$$;`);
 await db.exec(`update public.bridge_tasks set status='running';set role service_role`);
 await db.query(`select public.bridge_record_multi_ai('${id}','groq','groq','openai/gpt-oss-120b','session-private','ready')`);
 await db.exec('reset role');assert.equal((await db.query('select count(*)::int n from public.bridge_provider_state')).rows[0].n,1);
 await db.exec(`set role authenticated;set bridge.test_allowed='no'`);await assert.rejects(db.query('select public.bridge_dashboard_multi_ai()'));
 await db.exec(`set bridge.test_allowed='yes'`);row=(await db.query(`select public.bridge_dashboard_multi_ai('${id}') as data`)).rows[0].data;
 assert.equal(row.task.actual_provider,'groq');assert.equal(row.providers[0].state,'ready');assert.ok(!JSON.stringify(row).includes('session-private'));assert.ok(!JSON.stringify(row).includes('instruction'));
 await assert.rejects(db.query('select * from public.bridge_provider_state'));await db.exec('reset role');
 // Older task completion cannot overwrite observation from a newer task.
 await db.exec(`update public.bridge_provider_state set observed_since=now()+interval '1 day',state='auth_error';set role service_role`);
 await db.query(`select public.bridge_record_multi_ai('${id}','groq','groq',null,null,'ready')`);await db.exec('reset role');
 assert.equal((await db.query('select state from public.bridge_provider_state')).rows[0].state,'auth_error');
 await db.exec(`update public.bridge_tasks set status='succeeded';set role service_role`);
 assert.equal((await db.query(`select public.bridge_record_multi_ai('${id}','groq','groq',null,null,'ready') as ok`)).rows[0].ok,false);await db.exec('reset role');
 assert.equal((await db.query("select relrowsecurity from pg_class where oid='public.bridge_tasks'::regclass")).rows[0].relrowsecurity,true);
 console.log('PASS: migration twice, legacy paused row, constraints, private session, roles/RLS, dashboard gate, latest observation, terminal task guard');
}finally{await db.close();}})().catch(()=>{console.error('Multi-IA SQL validation failed (details suppressed)');process.exitCode=1;});
