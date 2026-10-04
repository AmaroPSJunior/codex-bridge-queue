'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {harness}=require('./harness.cjs');
const {createLifecycle,lifecycleSettings}=require('../executors/task-lifecycle');

for(const [name,env,config] of [
 ['new',{CODEX_BRIDGE_TASK_GIT:'1'},{}],
 ['legacy env',{CODEX_BRIDGE_TASK_AUTOCOMMIT:'1'},{}],
 ['legacy config',{}, {git:{autoCommit:true}}],
 ['all',{CODEX_BRIDGE_TASK_GIT:'1',CODEX_BRIDGE_TASK_AUTOCOMMIT:'1'},{git:{autoCommit:true}}]
])test('task-git '+name+' validates and commits once under worker lease',async t=>{
 let head=0,status=0,commits=0,release=0,body;
 const calls=[];
 const h=harness(t,'supabase-worker.js',{env,config,modules:{
  './executors/workspace-lock':{acquire:()=>({release(){release++;},retain(){throw Error('Unexpected uncertain run');}})},
  './executors/task-lifecycle':{lifecycleSettings,createLifecycle:opts=>createLifecycle({...opts,run:async(file,args)=>{
   assert.equal(release,0);calls.push([file,...args]);
   if(args[0]==='status')return status++?'?? new.js':'';
   if(args[0]==='rev-parse')return head++<2?'before':'after';
   if(args[0]==='ls-files')return 'new.js\0';
   if(args[0]==='commit'){commits++;assert.equal(args[2],'task(31): Código');}
   return '';
  }})}
 },fetch:async(u,o)=>{body=JSON.parse(o.body);return {ok:true,text:async()=>''};}});
 fs.writeFileSync(path.join(h.dir,'new.js'),'safe source');
 h.set('task',{id:'task',task_number:31,title:'Código',git_status:null,commit_sha:null,git_files:null});
 const p=h.run("execute('instruction',task)");
 while(!h.calls.length)await new Promise(r=>setImmediate(r));
 assert.equal(h.calls[0].opts.env.CODEX_BRIDGE_TTS,'0');
 h.calls[0].child.stdout.emit('data',JSON.stringify({status:'completed',answer:'OK',workspaceReleased:true}));h.calls[0].child.emit('close',0);
 const run=await p;assert.equal(commits,1);assert.equal(release,1);assert.ok(calls.some(c=>c[0]==='npm'&&c[1]==='test'));assert.ok(!calls.some(c=>c.includes('push')));
 h.set('result',run);const result=await h.run('finish(task,result)');
 assert.equal(result.status,'succeeded');assert.equal(result.commit_sha,'after');assert.equal(body.git_status,'committed');assert.equal(body.result,'OK');
 for(const c of h.calls)if(c.command==='termux-tts-speak')c.child.emit('close',0);
});
test('flags disabled by default; legacy true remains enabled if another alias is zero',()=>{
 assert.equal(lifecycleSettings({},{}).git,false);
 assert.equal(lifecycleSettings({CODEX_BRIDGE_TASK_GIT:'0',CODEX_BRIDGE_TASK_AUTOCOMMIT:'1'},{}).git,true);
 assert.equal(lifecycleSettings({}, {git:{autoCommit:'true'}}).git,false);
});
for(const legacy of [false,true])test('Git metadata publication preserves '+(legacy?'legacy':'migrated')+' schema',async t=>{
 let body;const h=harness(t,'supabase-worker.js',{fetch:async(u,o)=>{body=JSON.parse(o.body);return {ok:true,text:async()=>''};}});
 h.set('task',{id:'task',...(legacy?{}:{git_status:null,commit_sha:null,git_files:null})});
 h.set('result',{code:1,stdout:JSON.stringify({status:'failed',answer:'partial',error:'validation failed'}),gitMetadata:{git_status:'failed',commit_sha:null,git_files:[]}});
 const result=await h.run('finish(task,result)');assert.equal(result.status,'failed');assert.equal(body.result,'partial');assert.equal(Object.hasOwn(body,'git_status'),!legacy);
});
test('commit failure preserves output and never reports success',async t=>{
 const h=harness(t,'supabase-worker.js');fs.writeFileSync(path.join(h.dir,'new.js'),'safe');let statuses=0;
 const lifecycle=createLifecycle({cwd:h.dir,env:{CODEX_BRIDGE_TASK_AUTOCOMMIT:'1'},run:async(file,args)=>{
  if(args[0]==='status')return statuses++?'?? new.js':'';
  if(args[0]==='rev-parse')return 'same';if(args[0]==='ls-files')return 'new.js\0';if(args[0]==='commit')throw Error('synthetic failure');return '';
 }});
 await lifecycle.begin();const result=await lifecycle.complete({code:0,stdout:'{"status":"completed","answer":"preserved","workspaceReleased":true}'});
 assert.equal(result.code,1);assert.equal(result.gitMetadata.git_status,'failed');assert.equal(JSON.parse(result.stdout).answer,'preserved');
});
