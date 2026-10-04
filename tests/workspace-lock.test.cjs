'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process');
const locks=require('../executors/workspace-lock'),{harness}=require('./harness.cjs');
function workspace(t){const d=fs.mkdtempSync(path.join(os.tmpdir(),'workspace-lock-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;}
test('workspace identity ignores provider, task, thread and symlink aliases',t=>{
 const d=workspace(t),real=path.join(d,'repo'),alias=path.join(d,'alias');fs.mkdirSync(real);fs.symlinkSync(real,alias);
 const lease=locks.acquire(real);
 assert.throws(()=>locks.acquire(alias),/BUSY/);
 const child=locks.acquire(alias,lease.token);child.release();assert.throws(()=>locks.acquire(real),/BUSY/);
 assert.throws(()=>locks.acquire(real,'wrong'));lease.release();lease.release();locks.acquire(alias).release();
});
test('independent workspaces run independently, uncertainty never expires automatically',t=>{
 const a=workspace(t),b=workspace(t),l=locks.acquire(a);locks.acquire(b).release();l.retain();l.release();
 assert.throws(()=>locks.acquire(a),/BUSY/);assert.throws(()=>locks.acquire(a,l.token));
 const owner=JSON.parse(fs.readFileSync(path.join(a,'.bridge-workspace-lock/owner.json')));assert.equal(owner.state,'uncertain');
});
test('unsafe symlink and foreign ownership token cannot release a lock',t=>{
 const d=workspace(t),l=locks.acquire(d),owner=path.join(d,'.bridge-workspace-lock/owner.json');
 const saved=JSON.parse(fs.readFileSync(owner));fs.writeFileSync(owner,JSON.stringify({...saved,token:'other'}));
 assert.throws(()=>l.release(),/OWNER_CHANGED/);fs.unlinkSync(owner);fs.symlinkSync('/nonexistent',owner);assert.throws(()=>l.release());
});
test('concurrent processes for three providers never enter the same critical section',async t=>{
 const d=workspace(t),mod=require.resolve('../executors/workspace-lock');
 const code=`const fs=require('fs'),path=require('path'),{acquire}=require(process.argv[1]);let l;try{l=acquire(process.argv[2]);}catch{process.exit(3);}const mark=path.join(process.argv[2],'active');try{fs.writeFileSync(mark,process.argv[3],{flag:'wx'});}catch{process.exit(9);}setTimeout(()=>{fs.unlinkSync(mark);l.release();},150);`;
 const results=await Promise.all(Array.from({length:9},(_,i)=>new Promise((resolve,reject)=>{
  const p=spawn(process.execPath,['-e',code,mod,d,['codex','antigravity','claude'][i%3]],{stdio:'ignore'});p.on('error',reject);p.on('exit',resolve);
 })));
 assert.ok(results.includes(0));assert.ok(results.every(x=>x===0||x===3));assert.ok(results.includes(3));
 locks.acquire(d).release();
});
test('owner process disappearance leaves a safety fence for surviving remote work',async t=>{
 const d=workspace(t);await new Promise((resolve,reject)=>{const p=spawn(process.execPath,['-e',"require(process.argv[1]).acquire(process.argv[2]);process.exit(0)",require.resolve('../executors/workspace-lock'),d],{stdio:'ignore'});p.on('error',reject);p.on('exit',c=>c===0?resolve():reject(Error('child failed')));});
 assert.throws(()=>locks.acquire(d),/BUSY/);
});
test('worker serializes multiple tasks, passes lease, releases only acknowledged completion',async t=>{
 const h=harness(t,'supabase-worker.js',{modules:{'./executors/workspace-lock':locks}});
 const first=h.run("execute('first')");assert.equal(h.calls.length,1);
 const token=h.calls[0].opts.env.CODEX_BRIDGE_WORKSPACE_TOKEN;assert.equal(typeof token,'string');
 assert.equal((await h.run("execute('second')")).code,1);assert.equal(h.calls.length,1);
 h.calls[0].child.stdout.emit('data',JSON.stringify({status:'completed',answer:'ok',workspaceReleased:true}));h.calls[0].child.emit('close',0);await first;
 const next=h.run("execute('third')");assert.equal(h.calls.length,2);
 h.calls[1].child.stdout.emit('data',JSON.stringify({status:'failed',error:'Timeout'}));h.calls[1].child.emit('close',1);await next;
 assert.equal((await h.run("execute('fourth')")).code,1);assert.equal(h.calls.length,2);
});
test('worker retains fence on spawn failure rather than retrying another executor',async t=>{
 const h=harness(t,'supabase-worker.js',{modules:{'./executors/workspace-lock':locks}});
 const p=h.run("execute('first')");h.calls[0].child.emit('error',Error('spawn failed'));await p;
 assert.equal((await h.run("execute('next')")).code,1);assert.equal(h.calls.length,1);
});
