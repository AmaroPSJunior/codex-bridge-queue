// Optional disposable SQL validation: no live database or credentials.
const {PGlite}=require('@electric-sql/pglite');
const fs=require('node:fs');
const assert=require('node:assert/strict');

(async()=>{
 const db=new PGlite();

 try{
  await db.exec(`
   create table public.bridge_tasks(
    id int primary key,
    status text not null check(
     status in ('queued','running','succeeded','failed','cancelled')
    ),
    instruction text
   );

   alter table public.bridge_tasks enable row level security;

   insert into public.bridge_tasks
   values(1,'queued','legacy');
  `);

  const sql=fs.readFileSync(
   'database/task-execution-mode.sql',
   'utf8'
  );

  // Must remain idempotent.
  await db.exec(sql);
  await db.exec(sql);

  const legacy=(
   await db.query(
    'select * from bridge_tasks where id=1'
   )
  ).rows[0];

  assert.equal(legacy.execution_mode,'agent');
  assert.equal(legacy.status,'queued');
  assert.equal(legacy.command_payload,null);
  assert.equal(legacy.plan_payload,null);

  await db.exec(`
   insert into bridge_tasks(
    id,status,instruction,
    execution_mode,command_payload
   )
   values(
    2,'queued','diagnostic',
    'command','{"command":"pwd"}'
   );

   update bridge_tasks
   set status='running'
   where id=2;

   update bridge_tasks
   set
    status='succeeded',
    command_result='{"exit_code":0,"stdout":"ok"}'
   where id=2;
  `);

  await db.exec(`
   insert into bridge_tasks(
    id,status,instruction,
    execution_mode,plan_payload
   )
   values(
    3,
    'queued',
    'deterministic plan',
    'plan',
    '{"version":1,"steps":[{"type":"write_file","path":"x.js","content":"ok"}]}'
   );

   update bridge_tasks
   set status='running'
   where id=3;

   update bridge_tasks
   set
    status='succeeded',
    plan_result='{"version":1,"status":"completed","steps":[]}'
   where id=3;
  `);

  // Invalid mode/payload combinations must fail closed.
  const invalid=[
   `insert into bridge_tasks(id,status,execution_mode)
    values(10,'queued','command')`,

   `insert into bridge_tasks(id,status,execution_mode)
    values(11,'queued','plan')`,

   `insert into bridge_tasks(
      id,status,execution_mode,
      command_payload,plan_payload
    )
    values(
      12,'queued','command',
      '{"command":"pwd"}',
      '{"version":1,"steps":[]}'
    )`,

   `insert into bridge_tasks(
      id,status,execution_mode,
      plan_payload
    )
    values(
      13,'queued','agent',
      '{"version":1,"steps":[]}'
    )`,

   `insert into bridge_tasks(
      id,status,execution_mode,
      command_payload
    )
    values(
      14,'queued','plan',
      '{"command":"pwd"}'
    )`,

   `insert into bridge_tasks(
      id,status,execution_mode,
      plan_payload
    )
    values(
      15,'queued','shell',
      '{"version":1,"steps":[]}'
    )`
  ];

  for(const query of invalid)
   await assert.rejects(db.exec(query));

  assert.equal(
   (
    await db.query(`
     select relrowsecurity
     from pg_class
     where relname='bridge_tasks'
    `)
   ).rows[0].relrowsecurity,
   true
  );

  console.log(
   'Execution SQL: agent, command and plan contracts passed'
  );
 }finally{
  await db.close();
 }
})().catch(e=>{
 console.error(e);
 process.exitCode=1;
});
