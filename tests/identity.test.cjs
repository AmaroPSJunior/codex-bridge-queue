const {test}=require('node:test'),assert=require('node:assert/strict');
const {displayTask,shortTitle,taskNumber,markdownLabel,taskSummary,statusLabel,inferTitle}=require('../task-display');
const {payload,lookupRoute}=require('../scripts/tasks.cjs');
const {harness}=require('./harness.cjs');
test('Friendly label keeps UUID out of presentation',()=>{assert.deepEqual(displayTask({id:'technical-uuid',task_number:1,title:'Revisar ponte'}),{number:'1',title:'Revisar ponte',label:'Tarefa 1 — Revisar ponte'});});
test('Legacy row does not invent a sequence number or expose prompt',()=>{assert.equal(displayTask({id:'uuid',instruction:'private instruction'}).label,'Tarefa legada — Tarefa sem título');});
test('GitHub uses existing issue sequence',()=>{assert.equal(displayTask({number:42,title:'Analisar testes'},'github').label,'Tarefa 42 — Analisar testes');});
test('Title normalizes whitespace and truncates Unicode characters',()=>{assert.equal(shortTitle('  Olá\n mundo\0 '),'Olá mundo');assert.equal(Array.from(shortTitle('😀'.repeat(90))).length,80);assert.equal(shortTitle(null),'Tarefa sem título');});
test('Task number preserves bigint string without rounding',()=>{assert.equal(taskNumber('9223372036854775807'),'9223372036854775807');assert.equal(taskNumber(Number.MAX_SAFE_INTEGER+1),null);for(const v of [0,-1,'1;drop','01',1.5])assert.equal(taskNumber(v),null);});
test('Markdown title cannot inject formatting into comments',()=>{assert.match(markdownLabel({number:1,title:'[fake](url) <tag>'},'github'),/\\\[fake\\\]/);});
test('Create helper preserves supplied UUID and ignores client numbering',()=>{const id='12345678-1234-1234-1234-123456789abc';const p=payload({id,prompt:'literal $(id)',title:'Teste',task_number:99},'supabase');assert.equal(p.id,id);assert.equal(p.instruction,'literal $(id)');assert.equal(p.task_number,undefined);assert.equal(p.status,'queued');});
test('Legacy GitHub protocol remains accepted without title',()=>{const p=payload({task_id:'legacy-001',prompt:'hello'},'github');assert.equal(JSON.parse(p.body).protocol,'codex-bridge/v1');assert.equal(JSON.parse(p.body).task_id,'legacy-001');assert.equal(p.title,'Tarefa sem título');});
test('Creation rejects empty NUL oversized input and invalid IDs',()=>{for(const prompt of ['', 'a\0b','x'.repeat(24001)])assert.throws(()=>payload({prompt},'supabase'));assert.throws(()=>payload({id:'bad',prompt:'ok'},'supabase'));});
test('GitHub accepts optional title and publishes friendly label',async t=>{const h=harness(t,'remote-worker.js');h.set('comments',async()=>[]);h.set('execute',async()=>{});h.set('issue',{number:5,id:123,user:{login:'owner'},title:'Issue fallback',body:JSON.stringify({protocol:'codex-bridge/v1',task_id:'task-005',title:'Título humano',prompt:'hi'})});await h.run('accept(issue)');assert.equal(h.run('records()[0].title'),'Título humano');h.set('commentOnce',async(s,m,b)=>{h.context.published=b;});h.set('setStatus',async()=>{});await h.run("publish({...records()[0],outcome:'done',result:'OK'})");assert.match(h.context.published,/Tarefa 5 — Título humano/);});
test('Supabase finish returns friendly metadata without changing stored result contract',async t=>{let b;const h=harness(t,'supabase-worker.js',{fetch:async(u,o)=>{b=JSON.parse(o.body);return {ok:true,text:async()=>''};}});const r=await h.run("finish({id:'uuid',task_number:2,title:'Resumo'},{code:0,stdout:JSON.stringify({status:'completed',answer:'OK'}),stderr:''})");assert.equal(r.label,'Tarefa 2 — Resumo');assert.equal(b.result,'OK');assert.equal(b.task_number,undefined);assert.ok(!h.logs.join('').includes('Resumo'));});

test('Supabase can query by human number or original UUID',()=>{assert.equal(lookupRoute('supabase','7'),'bridge_tasks?task_number=eq.7&select=*');assert.match(lookupRoute('supabase','12345678-1234-1234-1234-123456789abc'),/id=eq.12345678/);assert.throws(()=>lookupRoute('supabase','7&status=eq.queued'));assert.equal(lookupRoute('github','7'),'7');});

for(const [internal,pt] of Object.entries({queued:'na fila',running:'em execução',succeeded:'concluída',failed:'falhou',cancelled:'cancelada'}))test('Portuguese status '+internal,()=>{
 const result=taskSummary({id:'private-uuid',task_number:12,title:'Diagnóstico ADB do BYD',status:internal});
 assert.equal(result.status,internal);assert.equal(result.status_label,pt);assert.equal(result.summary,'Tarefa 12 — Diagnóstico ADB do BYD — '+pt);assert.equal(result.task_name,result.title);assert.ok(!result.summary.includes('private-uuid'));
});
test('Task name alias and safe unknown status presentation',()=>{const r=taskSummary({task_number:13,task_name:'Ajustar progresso',status:'unexpected'});assert.equal(r.task_name,'Ajustar progresso');assert.equal(statusLabel('unexpected'),'estado desconhecido');assert.equal(statusLabel('__proto__'),'estado desconhecido');});
test('Name inference returns only fixed safe categories or generic names',()=>{assert.equal(inferTitle('Execute ADB diagnostic with private password'),'Diagnóstico ADB do BYD');assert.equal(inferTitle('private arbitrary content',7),'Tarefa 7');assert.equal(inferTitle('private arbitrary content'),'Nova tarefa');const body=payload({instruction:'private arbitrary content',task_name:'Nome escolhido'},'supabase');assert.equal(body.title,'Nome escolhido');assert.equal(body.task_name,undefined);assert.equal(body.status,'queued');});

test('Normal summary strips UUID embedded in title and keeps canonical ID external',()=>{
 const id='12345678-1234-1234-1234-123456789abc';const r=taskSummary({id,task_number:2,title:'Consultar '+id,status:'queued'});assert.equal(r.summary,'Tarefa 2 — Consultar — na fila');
});
test('GitHub rendered result uses Portuguese status without visible technical receipt',async t=>{
 const h=harness(t,'remote-worker.js');let body;h.set('commentOnce',async(s,m,b)=>{body=b;assert.match(m,/codex-bridge:result/);});h.set('setStatus',async()=>{});
 await h.run("publish({issue:3,taskId:'private-technical-id',title:'Consultar',outcome:'done',result:'OK'})");assert.match(body,/Tarefa 3 — Consultar — concluída/);assert.ok(!body.includes('private-technical-id'));
});
