'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createProgress,sanitizer,localLog,MAX_BYTES,commandStream}=require('../task-progress');
const {harness,flush:tick}=require('./harness.cjs');
function fixture(opts={}){
 let time=0;const timers=new Set(),writes=[],local=[],errors=[];
 const p=createProgress({now:()=>time,date:()=>new Date(time).toISOString(),timer:(fn,ms)=>{const t={fn,at:time+ms};timers.add(t);return t;},cancel:t=>timers.delete(t),write:async b=>{writes.push(b);},append:s=>local.push(s),onError:e=>errors.push(e),...opts});
 async function advance(ms){time+=ms;for(const t of [...timers])if(t.at<=time){timers.delete(t);t.fn();}await tick();}
 return {p,writes,local,errors,timers,advance};
}
test('Progress flushes at 30 lines, not 29',async()=>{const f=fixture();for(let i=0;i<29;i++)f.p.line('line '+i);await f.advance(999);assert.equal(f.writes.length,0);f.p.line('thirty');await tick();assert.equal(f.writes.length,1);assert.equal(f.p.snapshot().pending,0);await f.p.close();});
test('Progress flushes one second after the last successful write',async()=>{
 const f=fixture();for(let i=0;i<30;i++)f.p.line('line');await tick();f.p.line('next');
 await f.advance(999);assert.equal(f.writes.length,1);await f.advance(1);
 assert.equal(f.writes.length,2);assert.equal(f.p.snapshot().lastSuccess,1000);await f.p.close();
});
test('Progress flushes fewer than thirty after one second and has no idle writes',async()=>{const f=fixture();f.p.line('one');await f.advance(999);assert.equal(f.writes.length,0);await f.advance(1);assert.equal(f.writes.length,1);await f.advance(120000);assert.equal(f.writes.length,1);await f.p.close();assert.equal(f.timers.size,0);});
test('Executor percentage advances by stages, never regresses, and is omitted for old schemas',async()=>{
 const writes=[],p=createProgress({includePercent:true,write:async body=>writes.push(body)});p.setStage('command');p.line('starting');await p.flush('lines');
 assert.equal(writes[0].progress_percent,60);p.setStage('running');p.line('more');await p.flush('lines');assert.equal(writes[1].progress_percent,60);
 p.line('finishing');await p.close('succeeded');assert.equal(writes.at(-1).progress_percent,95);
 const legacy=[];const old=createProgress({write:async body=>legacy.push(body)});old.line('legacy');await old.close();assert.equal('progress_percent' in legacy[0],false);
});
for(const stage of ['succeeded','failed','cancelled','shutdown'])test('Progress final flush '+stage,async()=>{const f=fixture();f.p.feed(Buffer.from('partial'));await f.p.close(stage);assert.equal(f.writes.length,1);assert.equal(f.writes[0].recent_output,'partial');assert.equal(f.timers.size,0);});
test('Progress 500-line cap evicts oldest first; local log retains all',async()=>{const f=fixture();for(let i=0;i<550;i++){f.p.line('line '+i);assert.ok(f.p.snapshot().lines.length<=500);}await f.p.close('succeeded');const lines=f.writes.at(-1).recent_output.split('\n');assert.equal(lines.length,500);assert.equal(lines[0],'line 50');assert.equal(lines.at(-1),'line 549');assert.equal(f.local.length,550);});
test('Progress cap measures serialized UTF8 with escaping, oldest first',async()=>{const f=fixture();for(let i=0;i<500;i++)f.p.line(String(i)+'😀\\"'.repeat(500));await f.p.close();const s=f.writes.at(-1).recent_output;assert.equal(MAX_BYTES,512*1024);for(const write of f.writes)assert.ok(Buffer.byteLength(JSON.stringify(write.recent_output))<=MAX_BYTES);assert.ok(Buffer.byteLength(JSON.stringify(s))<=MAX_BYTES);assert.ok(!s.startsWith('0'));assert.ok(s.includes('499'));});
test('Progress oversized partial cannot grow without bound or leak its prefix',async()=>{const f=fixture();f.p.feed('x'.repeat(MAX_BYTES+1));f.p.feed('hidden tail\n');await f.p.close();assert.equal(f.local.join(''),'[linha excede limite; omitida]\n');});
test('Progress redacts known secrets, headers, env, hotspot and identifiers across chunks',async()=>{
 const f=fixture({env:{CUSTOM_API_TOKEN:'fixture-secret-value'}});
 for(const s of ['fixture-secret-','value\n','Authorization: Bearer fake\n','[persist.sys.ap.password]: [fake-hotspot]\n','[ril.imei]: [123456789012345]\n','[persist.sys.gpsinfo]: [coordinates]\n','[sys.virtual.vin]: [fake-vin]\n','CUSTOM=private\n','ghp_exampletoken\n'])f.p.feed(Buffer.from(s));
 await f.p.close();const s=JSON.stringify(f.writes)+f.local.join('');for(const secret of ['fixture-secret-value','fake-hotspot','123456789012345','coordinates','fake-vin','private','ghp_exampletoken'])assert.ok(!s.includes(secret),secret);
});
test('Progress preserves UTF8 split bytes and isolates stdout/stderr fragments',async()=>{const f=fixture();const bytes=Buffer.from('é\n');f.p.feed(bytes.subarray(0,1),'a');f.p.feed('other\n','b');f.p.feed(bytes.subarray(1),'a');await f.p.close();assert.equal(f.writes[0].recent_output,'other\né');});
test('Failed progress retains pending data and successful timestamp, retries without storm',async()=>{
 let fail=true;const calls=[];const f=fixture({write:async b=>{calls.push(b);if(fail)throw Error('do not expose this');}});
 for(let i=0;i<30;i++)f.p.line('line');await tick();assert.equal(f.p.snapshot().pending,30);assert.equal(f.p.snapshot().lastSuccess,0);
 for(let i=0;i<100;i++)f.p.line('more');await tick();assert.equal(calls.length,1);await f.advance(999);assert.equal(calls.length,1);
 fail=false;await f.advance(1);assert.equal(calls.length,3);assert.equal(f.p.snapshot().lastSuccess,1000);assert.equal(f.p.snapshot().pending,0);assert.deepEqual(f.errors,['progress_publish_failed']);await f.p.close();
});
test('Single flight retains arrivals during successful write and uses monotonic bigint sequence',async()=>{
 const pending=[],bodies=[];const f=fixture({initialSeq:'9007199254740993',write:b=>{bodies.push(b);return new Promise(r=>pending.push(r));}});
 for(let i=0;i<30;i++)f.p.line('old');await tick();for(let i=0;i<30;i++)f.p.line('new');await tick();assert.equal(bodies.length,1);
 await f.advance(123);pending.shift()();await tick();assert.equal(bodies.length,2);assert.equal(bodies[0].progress_seq,'9007199254740994');assert.equal(bodies[1].progress_seq,'9007199254740995');pending.shift()();await tick();await f.p.close();
});
test('Shutdown checkpoint flushes lines but preserves incomplete secret across subsequent chunks',async()=>{const f=fixture({env:{API_KEY:'abcdefghijklmnop'}});f.p.feed('line\nabcdefgh');await f.p.checkpoint('shutdown');assert.equal(f.writes[0].recent_output,'line');f.p.feed('ijklmnop\n');await f.p.close('succeeded');assert.equal(f.writes.length,2);assert.ok(!JSON.stringify(f.writes).includes('abcdefgh'));});
test('Local logs private, hashed path, no symlink overwrite',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'progress-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const l=localLog(root,'../../outside');l.append('safe\n');l.close();assert.equal(fs.statSync(l.filename).mode&0o777,0o600);assert.equal(fs.statSync(path.dirname(l.filename)).mode&0o777,0o700);fs.unlinkSync(l.filename);fs.symlinkSync(path.join(root,'other'),l.filename);assert.throws(()=>localLog(root,'../../outside'));
});
for(const outcome of ['completed','failed'])test('Worker awaits progress before existing terminal transition '+outcome,async t=>{
 const events=[];const h=harness(t,'supabase-worker.js',{fetch:async(u,o)=>{events.push(JSON.parse(o.body).status);return {ok:true,text:async()=>''};}});
 h.set('pr',{close:async s=>events.push('flush '+s)});h.set('runResult',{code:outcome==='completed'?0:1,stdout:JSON.stringify({status:outcome,answer:'OK'}),stderr:''});
 await h.run("finish({id:'1'},runResult,pr)");assert.deepEqual(events,outcome==='completed'?['flush succeeded','succeeded']:['flush failed','failed']);
});
test('Worker progress PATCH uses exact sequence CAS and server timestamp with no lifecycle fields',async t=>{
 let call;const h=harness(t,'supabase-worker.js',{fetch:async(u,o)=>{call={u,o};return {ok:true,text:async()=>JSON.stringify([{id:'1'}])};}});
 h.run("activeProgress=progressFor({id:'1',progress_seq:4,progress_message:null,recent_output:null,last_progress_at:null,last_flush_reason:null,last_flush_line_count:null});activeProgress.line('hello')");await h.run("activeProgress.close('succeeded')");
 assert.match(call.u,/status=eq.running/);assert.match(call.u,/progress_seq=eq.4/);assert.ok(call.o.signal);const body=JSON.parse(call.o.body);assert.equal(body.progress_seq,'5');assert.equal(body.last_progress_at,undefined);assert.equal(body.last_flush_reason,'final');assert.equal(body.last_flush_line_count,1);assert.equal(body.status,undefined);assert.equal(body.result,undefined);
});
test('Worker writes the executor percentage only when the task schema has that column',async t=>{
 let call;const h=harness(t,'supabase-worker.js',{fetch:async(u,o)=>{call={u,o};return {ok:true,text:async()=>JSON.stringify([{id:'1'}])};}});
 h.run("activeProgress=progressFor({id:'1',progress_seq:0,progress_message:null,recent_output:null,last_progress_at:null,last_flush_reason:null,last_flush_line_count:null,progress_percent:0});activeProgress.line('starting')");await h.run("activeProgress.flush('lines')");
 await h.run("activeProgress.close('succeeded')");const body=JSON.parse(call.o.body);assert.equal(body.progress_percent,25);
});
test('Worker idempotently appends sanitized terminal events without patching them onto bridge_tasks',async t=>{
 const calls=[];const h=harness(t,'supabase-worker.js',{fetch:async(u,o)=>{calls.push({u,o});return {ok:true,text:async()=>u.includes('bridge_task_terminal_events')?'':'[{"id":"1"}]'};}});
 h.run("activeProgress=progressFor({id:'1',progress_seq:0,progress_message:null,recent_output:null,last_progress_at:null,last_flush_reason:null,last_flush_line_count:null});activeProgress.event('command_start',{command_key:'c1',command:'echo safe'})");
 await h.run("activeProgress.close('succeeded')");
 assert.match(calls[0].u,/bridge_task_terminal_events\?on_conflict=event_key/);assert.equal(calls[0].o.method,'POST');assert.match(calls[0].o.headers.Prefer,/ignore-duplicates/);
 const events=JSON.parse(calls[0].o.body);assert.equal(events[0].task_id,'1');assert.equal(events[0].event_type,'command_start');assert.equal(events[0].command,'echo safe');
 assert.match(calls[1].u,/bridge_tasks/);assert.equal(JSON.parse(calls[1].o.body).terminal_events,undefined);
});
test('Worker legacy schema records local output with no progress network requests',async t=>{const h=harness(t,'supabase-worker.js');h.run("activeProgress=progressFor({id:'legacy'});activeProgress.line('hello')");await h.run("activeProgress.close('succeeded')");assert.match(h.logs.join('\n'),/schema_pending/);assert.equal(fs.readdirSync(path.join(h.dir,'supabase-state/progress')).length,1);});
test('Worker streams literal executor output into progress while preserving result JSON',async t=>{
 const h=harness(t,'supabase-worker.js');const chunks=[];h.set('pr',{feed:(s,c)=>chunks.push([String(s),c])});const promise=h.run("execute('hello',{},pr)");const c=h.calls[0];assert.equal(c.opts.env.CODEX_BRIDGE_PROGRESS,'1');c.child.stderr.emit('data','line\n');await tick();c.child.stdout.emit('data','{"status":"completed"}');c.child.emit('close',0);const run=await promise;assert.equal(JSON.parse(run.stdout).status,'completed');assert.deepEqual(chunks,[['line\n','stderr'],['{"status":"completed"}','stdout']]);
});

test('Worker SIGTERM flushes active progress without killing executor',async t=>{
 const h=harness(t,'supabase-worker.js');let stage;
 h.set('pr',{checkpoint:async s=>{stage=s;}});h.run('activeProgress=pr');h.proc.emit('SIGTERM');await tick();assert.equal(stage,'shutdown');assert.equal(h.calls.length,0);
});
test('Worker finalization survives progress publication error',async t=>{
 const calls=[];const h=harness(t,'supabase-worker.js',{fetch:async(u,o)=>{
  const b=JSON.parse(o.body);calls.push(b);return b.status?{ok:true,text:async()=>''}:{ok:false,status:503,text:async()=>'sensitive server error'};
 }});
 h.run("activeProgress=progressFor({id:'1',progress_seq:0,progress_message:null,recent_output:null,last_progress_at:null,last_flush_reason:null,last_flush_line_count:null});activeProgress.line('remainder')");
 await h.run("finish({id:'1'},{code:0,stdout:'{\"status\":\"completed\"}',stderr:''},activeProgress)");
 assert.equal(calls.at(-1).status,'succeeded');assert.ok(!h.logs.join('').includes('sensitive server error'));
});


test('Command with 3 lines immediately flushes on exit including unterminated final line',async()=>{
 const f=fixture();f.p.feed('first\nsecond\nthird','cmd');assert.equal(f.writes.length,0);
 await f.p.commandComplete(0,'cmd');assert.equal(f.writes.length,1);assert.equal(f.writes[0].recent_output,'first\nsecond\nthird');assert.equal(f.p.snapshot().pending,0);
 assert.deepEqual(f.local.slice(-2),['third\n','[command exit: 0]\n']);await f.p.close();assert.equal(f.writes.length,1);
});
test('Structured terminal stream persists command, sanitized output, and exit per task',async()=>{
 const f=fixture({env:{API_TOKEN:'fixture-secret'}}),capture=commandStream(f.p),frame=e=>JSON.stringify({bridge_progress:1,...e})+'\n';
 await capture.write(Buffer.from(frame({type:'start',id:'c1',command:'echo safe'})+
  frame({type:'data',id:'c1',text:'Authorization: Bearer fixture-secret\nresult ok\n'})+
  frame({type:'end',id:'c1',code:0})));
 await capture.end();
 const events=f.writes.flatMap(write=>write.terminal_events||[]);
 assert.deepEqual(events.map(x=>x.event_type),['command_start','output','output','command_end']);
 assert.equal(events[0].command,'echo safe');assert.equal(events[1].content,'[linha sensível omitida]');
 assert.equal(events[2].content,'result ok');assert.equal(events[3].exit_code,0);
 assert.ok(!JSON.stringify(f.writes).includes('fixture-secret'));await f.p.close();
});
test('Terminal upload batches stay below one half MiB without dropping output events',async()=>{
 const f=fixture();for(let i=0;i<4;i++)f.p.feed('x'.repeat(150000)+'\n','command:'+i);
 await f.p.flush('lines');await f.p.close();const events=f.writes.flatMap(write=>write.terminal_events||[]);
 assert.equal(events.length,4);for(const write of f.writes)assert.ok(Buffer.byteLength(JSON.stringify(write.terminal_events||[]))<MAX_BYTES);
});
test('Silent command exit never emits a redundant progress row update',async()=>{
 const f=fixture();await f.p.commandComplete(0,'empty');await f.advance(60000);await f.p.close();assert.equal(f.writes.length,0);
});
test('Nonzero command exit flushes buffered stderr with redaction',async()=>{
 const f=fixture({env:{API_TOKEN:'abcdefghijklmnop'}});f.p.feed('failed\nAuthorization: Bearer abcdefghijklmnop','err');
 await f.p.commandComplete(12,'err');assert.equal(f.writes.length,1);assert.match(f.writes[0].progress_message,/erro/);assert.ok(!JSON.stringify(f.writes).includes('abcdefghijklmnop'));await f.p.close();
});
test('Command completion resets the next one-second batch timer',async()=>{
 const f=fixture();await f.advance(10000);f.p.feed('a\nb\nc\n');await f.p.commandComplete(0);
 for(let i=0;i<29;i++)f.p.line('next '+i);await f.advance(999);assert.equal(f.writes.length,1);
 await f.advance(1);assert.equal(f.writes.length,2);
 f.p.line('timer batch');await f.advance(999);assert.equal(f.writes.length,2);await f.advance(1);assert.equal(f.writes.length,3);await f.p.close();
});
test('Framed capture waits for completion flush before next command output and accepts split frames',async()=>{
 let release;const writes=[];const f=fixture({write:b=>{writes.push(b);return writes.length===1?new Promise(r=>{release=r;}):Promise.resolve();}});
 const capture=commandStream(f.p),frame=e=>JSON.stringify({bridge_progress:1,...e})+'\n';
 const first=frame({type:'data',id:'one',text:'a\nb\nc'});
 await capture.write(Buffer.from(first.slice(0,12)));await capture.write(Buffer.from(first.slice(12)));
 const processing=capture.write(Buffer.from(frame({type:'end',id:'one',code:0})+frame({type:'data',id:'two',text:'later\n'})));
 await tick();assert.equal(writes.length,1);assert.equal(f.p.snapshot().lines.includes('later'),false);
 release();await processing;await capture.end();await f.p.close();assert.match(writes.at(-1).recent_output,/later/);
});
test('Concurrent command completion drains only its own partial stream',async()=>{
 const f=fixture({env:{API_TOKEN:'abcdefghijklmnop'}});f.p.feed('abcdefgh','other');f.p.feed('done','current');
 await f.p.commandComplete(0,'current');assert.equal(f.writes[0].recent_output,'done');
 f.p.feed('ijklmnop','other');await f.p.commandComplete(1,'other');assert.ok(!JSON.stringify(f.writes).includes('abcdefgh'));await f.p.close();
});
test('Worker child close waits for final capture and progress flush regardless of exit code',async t=>{
 const h=harness(t,'supabase-worker.js');const events=[];let release;
 h.set('pr',{feed:(s,c)=>events.push(['data',String(s),c]),commandComplete:code=>{events.push(['exit',code]);return new Promise(r=>release=r);}});
 const result=h.run("execute('hello',{},pr)");const c=h.calls[0];c.child.stdout.emit('data','last stdout');c.child.stderr.emit('data','last stderr');c.child.emit('close',4);
 let done=false;result.then(()=>done=true);await tick();assert.equal(done,false);assert.deepEqual(events.at(-1),['exit',4]);assert.ok(events.some(e=>e[1]==='last stderr\n'));release();assert.equal((await result).code,4);
});


test('Successful progress sequence advances exactly once; failure keeps same candidate and payload',async()=>{
 let fail=true;const calls=[];const f=fixture({write:async b=>{calls.push({...b});if(fail)throw Error('offline');}});
 f.p.line('one');await f.p.flush('lines');assert.equal(f.p.snapshot().seq,'0');assert.equal(calls[0].progress_seq,'1');
 fail=false;await f.p.flush('timeout');assert.equal(f.p.snapshot().seq,'1');assert.deepEqual(calls[1],calls[0]);
 await f.p.commandComplete(0);assert.equal(f.p.snapshot().seq,'1');assert.equal(calls.length,2);
 f.p.line('two');await f.p.close('succeeded');assert.equal(f.p.snapshot().seq,'2');assert.equal(calls.at(-1).progress_seq,'2');
});
test('Reasons and new-line counts match all four triggers, excluding old rolling lines',async()=>{
 const f=fixture();for(let i=0;i<30;i++)f.p.line('line');await tick();
 assert.equal(f.writes[0].last_flush_reason,'lines');assert.equal(f.writes[0].last_flush_line_count,30);
 f.p.line('next');await f.advance(1000);assert.equal(f.writes[1].last_flush_reason,'timeout');assert.equal(f.writes[1].last_flush_line_count,1);
 f.p.feed('a\nb\nc','cmd');await f.p.commandComplete(1,'cmd');assert.equal(f.writes[2].last_flush_reason,'command_end');assert.equal(f.writes[2].last_flush_line_count,3);
 f.p.feed('final fragment');await f.p.close('failed');assert.equal(f.writes[3].last_flush_reason,'final');assert.equal(f.writes[3].last_flush_line_count,1);
 assert.deepEqual(f.writes.map(b=>b.progress_seq),['1','2','3','4']);
});
test('Final retry persists frozen batch then new lines, counting only retained new lines',async()=>{
 let fail=true;const writes=[];const f=fixture({write:async b=>{writes.push(b);if(fail)throw Error('offline');}});
 f.p.line('old');await f.p.flush('lines');for(let i=0;i<600;i++)f.p.line('new '+i);
 fail=false;await f.p.close('succeeded');assert.equal(f.p.snapshot().pending,0);assert.equal(f.p.snapshot().seq,'2');
 assert.equal(writes.at(-1).last_flush_line_count,500);assert.equal(writes.at(-1).last_flush_reason,'final');
});
test('Worker reconciles a lost write response without incrementing twice',async t=>{
 let saved=null,patches=0,reads=0;const h=harness(t,'supabase-worker.js',{fetch:async(u,o)=>{
  if(o.method==='PATCH'){
   patches++;const b=JSON.parse(o.body);if(!saved){saved=b;throw Error('reply lost');}
   return {ok:true,text:async()=>'[]'};
  }
  reads++;return {ok:true,text:async()=>JSON.stringify([saved])};
 }});
 h.run("activeProgress=progressFor({id:'1',progress_seq:0,progress_message:null,recent_output:null,last_progress_at:null,last_flush_reason:null,last_flush_line_count:null});activeProgress.line('output')");
 await h.run("activeProgress.flush('lines')");assert.equal(h.run('activeProgress.snapshot().seq'),'0');
 await h.run("activeProgress.flush('lines')");assert.equal(h.run('activeProgress.snapshot().seq'),'1');assert.equal(saved.progress_seq,'1');assert.equal(patches,2);assert.equal(reads,1);await h.run("activeProgress.close('succeeded')");
});
test('Local-only legacy logging never claims a Supabase sequence increment',async()=>{
 const f=fixture({write:async()=>({localOnly:true})});f.p.line('local');await f.p.close();assert.equal(f.p.snapshot().seq,'0');assert.equal(f.p.snapshot().pending,0);
});
