const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {harness,flush}=require('./harness.cjs');
const task=(extra={})=>JSON.stringify({protocol:'codex-bridge/v1',task_id:'task-001',prompt:'hello',...extra});
for(const [name,body] of Object.entries({json:'{',protocol:task({protocol:'v2'}),short:task({task_id:'a'}),unsafeId:task({task_id:'../bad-id'}),blank:task({prompt:' '}),nul:task({prompt:'a\0b'}),type:task({prompt:42}),bytes:task({prompt:'é'.repeat(13)})})){
 test('GitHub rejects '+name,t=>{const h=harness(t,'remote-worker.js');h.set('body',body);assert.throws(()=>h.run('parseTask(body)'));});
}
test('GitHub accepts literal prompt and exact byte boundary',t=>{const h=harness(t,'remote-worker.js');h.set('body',task({prompt:'é'.repeat(12)}));assert.equal(h.run('parseTask(body).prompt'),'é'.repeat(12));});
test('GitHub pagination fetches all pages',async t=>{const h=harness(t,'remote-worker.js');let n=0;h.set('api',async()=>++n===1?Array(100).fill({}):[{}]);assert.equal((await h.run("pages('issues?state=open')")).length,101);assert.equal(n,2);});
test('GitHub process timeout terminates command and rejects',async t=>{const h=harness(t,'remote-worker.js');const p=h.run("run('gh',['api'])");assert.equal(h.timers[0].ms,30000);h.timers[0].fn();await assert.rejects(p);assert.equal(h.calls[0].child.killed,'SIGTERM');});
test('GitHub process spawn error rejects without hanging',async t=>{const h=harness(t,'remote-worker.js');const p=h.run("run('gh',[])");h.calls[0].child.emit('error',Error('missing'));await assert.rejects(p,/missing/);assert.equal(h.timers[0].cleared,true);});
test('GitHub ignores PRs and unauthorized authors',async t=>{const h=harness(t,'remote-worker.js');await h.run("accept({pull_request:{}})");await h.run("accept({number:1,user:{login:'stranger'}})");assert.equal(h.calls.length,0);assert.equal(h.run('records().length'),0);});
test('GitHub status preserves unrelated labels',async t=>{const h=harness(t,'remote-worker.js');let body;h.set('api',async(_,method,b)=>{if(method==='PATCH')body=b;return {labels:[{name:'codex:queued'},{name:'keep'}]};});await h.run("setStatus({issue:1},'done',true)");assert.deepEqual(Array.from(body.labels),['keep','codex:done']);assert.equal(body.state,'closed');});
test('GitHub comment marker dedup requires trusted author',async t=>{const h=harness(t,'remote-worker.js');let writes=0;h.set('comments',async()=>[{user:{login:'OWNER'},body:'marker'}]);h.set('api',async()=>writes++);await h.run("commentOnce({issue:1},'marker','body')");assert.equal(writes,0);h.set('comments',async()=>[{user:{login:'other'},body:'marker'}]);await h.run("commentOnce({issue:1},'marker','body')");assert.equal(writes,1);});
test('GitHub durable save uses private file and ignores incomplete temporary records',t=>{const h=harness(t,'remote-worker.js');h.run("save({issue:1,status:'executing'})");const p=path.join(h.dir,'remote-state/1.json');assert.equal(fs.statSync(p).mode&0o777,0o600);fs.writeFileSync(p+'.tmp','{');assert.equal(h.run('records().length'),1);assert.equal(h.run('records()[0].status'),'executing');});
test('GitHub remote claim without local state becomes uncertain without execution',async t=>{const h=harness(t,'remote-worker.js');h.set('comments',async()=>[{body:'<!-- codex-bridge:claim:old -->'}]);h.set('publish',async()=>{});h.set('issue',{number:1,id:1,user:{login:'OWNER'},body:task()});await h.run('accept(issue)');assert.equal(h.run('records()[0].outcome'),'uncertain');assert.equal(h.calls.length,0);});
test('GitHub publishes multiple chunks and retains publishing on network failure',async t=>{const h=harness(t,'remote-worker.js');const chunks=[];h.set('commentOnce',async(s,m,b)=>chunks.push({m,b}));h.set('setStatus',async()=>{});h.set('s',{issue:1,taskId:'task-001',result:'x'.repeat(32001),outcome:'done',status:'publishing'});await h.run('publish(s)');assert.equal(chunks.length,3);assert.match(chunks[2].m,/:3\/3/);assert.equal(h.run('s.status'),'done');h.run("s.status='publishing'");h.set('commentOnce',async()=>{throw Error('offline');});await assert.rejects(h.run('publish(s)'),/offline/);assert.equal(h.run('s.status'),'publishing');});
for(const outcome of ['done','uncertain'])test('GitHub execute persists fence and '+outcome,async t=>{
 const h=harness(t,'remote-worker.js');h.set('commentOnce',async()=>{});h.set('setStatus',async()=>{});h.set('s',{issue:1,taskId:'task-001',prompt:'$(touch never); `id`',status:'claimed'});
 const p=h.run('execute(s)');await flush();const c=h.calls[0];assert.equal(h.run('records()[0].status'),'executing');assert.equal(c.opts.shell,false);assert.deepEqual(Array.from(c.args),['$(touch never); `id`']);assert.equal(c.opts.env.CODEX_BRIDGE_TASK_NUMBER,'1');assert.equal(c.opts.env.CODEX_BRIDGE_TASK_TRANSPORT,'github');
 fs.writeFileSync(path.join(h.dir,'remote-state/1.stdout'),JSON.stringify({status:outcome==='done'?'completed':'failed',answer:'answer',error:outcome==='done'?null:'timeout'}));c.child.emit('close',outcome==='done'?0:1);await p;assert.equal(h.run('records()[0].outcome'),outcome);assert.equal(h.run('records()[0].status'),'publishing');
});
function sb(t,fetch){return harness(t,'supabase-worker.js',{fetch});}
function response(value,status=200){return {ok:status<400,status,text:async()=>value===null?'':JSON.stringify(value)};}
test('Supabase request builds auth, parses JSON and accepts empty response',async t=>{let call;const h=sb(t,async(u,o)=>{call={u,o};return response(null);});assert.equal(await h.run("request('bridge_tasks')"),null);assert.equal(call.o.headers.apikey,'synthetic-only');assert.equal(call.o.headers.Authorization,'Bearer synthetic-only');assert.equal(h.logs.length,0);});
for(const status of [401,403,429,500])test('Supabase HTTP '+status+' rejects',async t=>{const h=sb(t,async()=>response({message:'test'},status));await assert.rejects(h.run("request('bridge_tasks')"),new RegExp('Supabase '+status));});
test('Supabase network and malformed JSON propagate failure',async t=>{const h=sb(t,async()=>{throw Error('offline');});await assert.rejects(h.run('next()'),/offline/);h.set('fetch',async()=>({ok:true,text:async()=>'{'}));await assert.rejects(h.run('next()'));});
test('Supabase next selects oldest queued row and handles empty queue',async t=>{let route;const h=sb(t,async u=>{route=u;return response([]);});assert.equal(await h.run('next()'),null);assert.match(route,/status=eq.queued/);assert.match(route,/order=created_at.asc&limit=1/);});
test('Supabase conditional claim allows one winner and encodes ID',async t=>{let claimed=false;const calls=[];const h=sb(t,async(u,o)=>{calls.push({u,o});if(claimed)return response([]);claimed=true;return response([{id:'x&y'}]);});h.set('task',{id:'x&y'});const results=await Promise.all([h.run('claim(task)'),h.run('claim(task)')]);assert.equal(results.filter(Boolean).length,1);assert.match(calls[0].u,/id=eq.x%26y&status=eq.queued/);assert.equal(JSON.parse(calls[0].o.body).status,'running');});
test('Supabase executor sends a single literal argv and isolates thread',async t=>{const h=sb(t);h.set('prompt','$(touch never); `id`\n"quote"');const p=h.run('execute(prompt)');const c=h.calls[0];assert.equal(c.opts.shell,false);assert.deepEqual(Array.from(c.args),[h.context.prompt]);assert.match(c.opts.env.CODEX_BRIDGE_THREAD_FILE,/supabase-thread-id$/);c.child.stdout.emit('data','answer');c.child.stderr.emit('data','warning');c.child.emit('close',0);const result=await p;assert.equal(result.stdout,'answer');assert.equal(result.stderr,'warning');});
test('Supabase executor spawn error becomes failed result',async t=>{const h=sb(t);const p=h.run("execute('hello')");h.calls[0].child.emit('error',Error('missing executable'));assert.equal((await p).code,1);});
for(const [name,run,expected] of [
 ['completed',{code:0,stdout:JSON.stringify({status:'completed',answer:'OK'}),stderr:''},'succeeded'],
 ['failed',{code:1,stdout:JSON.stringify({status:'failed',error:'timeout'}),stderr:''},'failed'],
 ['malformed',{code:0,stdout:'raw',stderr:''},'failed'],
 ['empty',{code:1,stdout:'',stderr:'oops'},'failed'],
 ['exit mismatch',{code:1,stdout:JSON.stringify({status:'completed',answer:'OK'}),stderr:''},'failed']])test('Supabase finish '+name,async t=>{
 let body;const h=sb(t,async(u,o)=>{body=JSON.parse(o.body);return response(null);});h.set('runResult',run);await h.run("finish({id:'task-1'},runResult)");assert.equal(body.status,expected);assert.ok(body.completed_at);assert.ok(body.updated_at);assert.equal(h.logs.length,1);
});
test('Supabase failed publication is surfaced; current worker has no durable outbox',async t=>{const h=sb(t,async()=>{throw Error('offline');});await assert.rejects(h.run("finish({id:'1'},{code:0,stdout:'{}',stderr:''})"),/offline/);assert.equal(fs.readdirSync(path.join(h.dir,'supabase-state')).length,0);});
test('Supabase restart ignores running tasks instead of executing them twice',async t=>{const h=sb(t,async()=>response([]));const p=h.run('main()');await flush();h.proc.emit('SIGTERM');await p;assert.equal(h.calls.length,0);assert.match(h.logs.at(-1),/stopped/);});
test('Supabase poll retries after network error and stops gracefully',async t=>{let count=0;const h=sb(t,async()=>{count++;throw Error('offline');});const p=h.run('main()');await flush();assert.match(h.logs.join('\n'),/poll_error/);h.timers.at(-1).fn();await flush();assert.equal(count,2);h.proc.emit('SIGTERM');await p;});
test('Supabase missing credential fails before network',async t=>{const h=harness(t,'supabase-worker.js',{env:{CODEX_SUPABASE_SERVICE_ROLE_KEY:''}});await assert.rejects(h.run('main()'),/Defina/);assert.equal(h.calls.length,0);});
test('Supabase current request has no transport deadline (documented limitation)',async t=>{let opts;const h=sb(t,async(u,o)=>{opts=o;return response([]);});await h.run('next()');assert.equal(opts.signal,undefined);});
test('Supabase current executor delegates instruction validation to bridge (documented limitation)',async t=>{const h=sb(t);const p=h.run("execute('')");assert.equal(h.calls[0].args[0],'');h.calls[0].child.emit('close',1);assert.equal((await p).code,1);});
test('Supabase simulated full loop returns result and never reruns a finished row',async t=>{
 let row={id:'task-1',instruction:'hello',status:'queued'}, executions=0;
 const h=sb(t,async(u,o)=>{
  if(!o.method){if(row.status==='succeeded'){h.proc.emit('SIGTERM');return response([]);}return response(row.status==='queued'?[row]:[]);}
  const b=JSON.parse(o.body);row={...row,...b};return response(o.headers.Prefer==='return=representation'?[row]:null);
 });
 h.set('execute',async prompt=>{executions++;assert.equal(prompt,'hello');return {code:0,stdout:JSON.stringify({status:'completed',answer:'result'}),stderr:''};});
 const p=h.run('main()');await flush();h.proc.emit('SIGTERM');await p;
 assert.equal(row.status,'succeeded');assert.equal(row.result,'result');assert.equal(executions,1);
});
test('Supabase ambiguous claim response leaves running row and does not execute',async t=>{
 let status='queued';const h=sb(t,async(u,o)=>{if(o.method){status='running';throw Error('reply lost');}return response(status==='queued'?[{id:'1',instruction:'hello'}]:[]);});
 const p=h.run('main()');await flush();assert.equal(status,'running');assert.equal(h.calls.length,0);h.timers.at(-1).fn();await flush();assert.equal(h.calls.length,0);h.proc.emit('SIGTERM');await p;
});
