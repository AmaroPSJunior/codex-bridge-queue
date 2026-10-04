// Optional disposable SQL validation: no live database or credentials.
const {PGlite}=require('@electric-sql/pglite'),fs=require('node:fs'),assert=require('node:assert/strict');
(async()=>{const db=new PGlite();try{
 await db.exec(`create table public.bridge_tasks(id int primary key,status text not null check(status in ('queued','running','succeeded','failed','cancelled')),instruction text);alter table public.bridge_tasks enable row level security;insert into public.bridge_tasks values(1,'queued','legacy');`);
 const sql=fs.readFileSync('database/task-execution-mode.sql','utf8');await db.exec(sql);await db.exec(sql);
 const r=(await db.query('select * from bridge_tasks')).rows[0];assert.equal(r.execution_mode,'agent');assert.equal(r.status,'queued');assert.equal(r.command_payload,null);
 await db.exec(`insert into bridge_tasks(id,status,instruction,execution_mode,command_payload) values(2,'queued','diagnostic','command','{"command":"pwd"}');update bridge_tasks set status='running' where id=2;update bridge_tasks set status='succeeded',command_result='{"exit_code":0,"stdout":"ok"}' where id=2;`);
 for(const values of ["'command',NULL","'shell','{}'","'agent','{}'","NULL,NULL","'command','[]'"]){await assert.rejects(db.exec(`insert into bridge_tasks(id,status,execution_mode,command_payload) values(3,'queued',${values})`));}
 assert.equal((await db.query("select relrowsecurity from pg_class where relname='bridge_tasks'")).rows[0].relrowsecurity,true);
 console.log('Command SQL: idempotence, legacy rows, constraints, lifecycle and RLS passed');
}finally{await db.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
