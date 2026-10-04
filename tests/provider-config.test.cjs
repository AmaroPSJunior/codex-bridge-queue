'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const c=require('../executors/provider-config');
const {harness}=require('./harness.cjs');
function home(t){const h=fs.mkdtempSync(path.join(os.tmpdir(),'provider-test-'));t.after(()=>fs.rmSync(h,{recursive:true,force:true}));return h;}
test('selection defaults to Codex and respects task > environment > persisted default',t=>{
 const h=home(t);const pick=(task={},env={})=>c.selectProvider({task,env,home:h});
 assert.deepEqual(pick(),{provider:'codex',source:'default'});
 c.writeDefault(h,'claude');assert.equal(pick().provider,'claude');
 assert.equal(pick({}, {AI_PROVIDER:'antigravity'}).provider,'antigravity');
 assert.deepEqual(pick({ai_provider:'codex'},{AI_PROVIDER:'auto'}),{provider:'codex',source:'task'});
 assert.equal(pick({ai_provider:null}).provider,'claude');
 assert.equal(pick({provider:'codex',metadata:{ai_provider:'codex'}}).provider,'claude');
});
test('valid names are not all executable; auto never falls back',()=>{
 for(const provider of c.PROVIDERS){assert.equal(c.validateProvider(provider),provider);
  if(c.IMPLEMENTED.includes(provider))assert.equal(c.requireImplemented({provider}).provider,provider);
  else assert.throws(()=>c.requireImplemented({provider}),/PROVIDER_(AUTO_DISABLED|NOT_IMPLEMENTED)/);
 }
 for(const value of ['',null,1,{},'CODEX','codex ','opencode','$(id)','sensitive-secret'])
  assert.throws(()=>c.validateProvider(value),e=>e.message==='PROVIDER_INVALID');
});
test('explicit invalid overrides fail rather than silently inherit',t=>{
 const h=home(t);
 assert.throws(()=>c.selectProvider({home:h,env:{AI_PROVIDER:''}}),/PROVIDER_INVALID/);
 assert.throws(()=>c.selectProvider({home:h,env:{AI_PROVIDER:'codex'},task:{ai_provider:''}}),/PROVIDER_INVALID/);
});
test('private persistence is atomic, exact-schema and contains no inherited secrets',t=>{
 const h=home(t);c.writeDefault(h,'codex');c.writeDefault(h,'claude');
 const dir=path.join(h,'.config/codex-bridge'),file=path.join(dir,'provider.json');
 assert.equal(fs.statSync(dir).mode&0o777,0o700);assert.equal(fs.statSync(file).mode&0o777,0o600);
 assert.deepEqual(JSON.parse(fs.readFileSync(file)),{version:1,default_provider:'claude'});
 assert.deepEqual(fs.readdirSync(dir),['provider.json']);
 assert.throws(()=>c.writeDefault(h,'secret'),/PROVIDER_INVALID/);assert.equal(c.readDefault(h),'claude');
});
test('unsafe permissions, symlinks and malformed configuration fail closed',t=>{
 const h=home(t);c.writeDefault(h,'codex');const dir=path.join(h,'.config/codex-bridge'),file=path.join(dir,'provider.json');
 fs.chmodSync(file,0o644);assert.throws(()=>c.readDefault(h),/UNSAFE/);fs.chmodSync(file,0o600);
 fs.writeFileSync(file,'{"version":1,"default_provider":"codex","token":"secret"}');
 assert.throws(()=>c.readDefault(h),e=>e.message==='PROVIDER_CONFIG_INVALID');
 fs.unlinkSync(file);fs.symlinkSync(path.join(h,'missing'),file);assert.throws(()=>c.readDefault(h));assert.throws(()=>c.writeDefault(h,'codex'));
 fs.unlinkSync(file);fs.chmodSync(dir,0o755);assert.throws(()=>c.readDefault(h),/UNSAFE/);
 fs.rmdirSync(dir);fs.symlinkSync(h,dir);assert.throws(()=>c.readDefault(h),/UNSAFE/);
});
test('CLI can list, persist and show without leaking invalid input or environment',t=>{
 const h=home(t),cli=path.resolve(__dirname,'../scripts/provider.cjs');
 const invoke=args=>spawnSync(process.execPath,[cli,...args],{env:{PATH:process.env.PATH,HOME:h,LD_LIBRARY_PATH:process.env.LD_LIBRARY_PATH,CODEX_SUPABASE_SERVICE_ROLE_KEY:'secret-only-test'},encoding:'utf8'});
 assert.equal(invoke(['list']).status,0);assert.equal(invoke(['set','codex']).status,0);
 const shown=invoke(['show']);assert.equal(JSON.parse(shown.stdout).provider,'codex');
 const invalid=invoke(['set','secret-only-test']);assert.equal(invalid.status,1);assert.ok(!(invalid.stdout+invalid.stderr).includes('secret-only-test'));
});
for(const provider of ['claude','auto','invalid'])test('worker rejects '+provider+' without spawning and finalizes failed',async t=>{
 const writes=[];const h=harness(t,'supabase-worker.js',{env:{AI_PROVIDER:provider},fetch:async(u,o)=>{writes.push(JSON.parse(o.body));return {ok:true,text:async()=>''};}});
 const result=await h.run("execute('test')");assert.equal(h.calls.length,0);assert.equal(result.code,1);
 h.set('run',result);await h.run("finish({id:'test'},run)");assert.equal(writes[0].status,'failed');
 assert.ok(!JSON.stringify(writes).includes('service_role'));
});
test('task override Codex wins over global unimplemented provider',async t=>{
 const h=harness(t,'supabase-worker.js',{env:{AI_PROVIDER:'claude'}});
 const p=h.run("execute('ok',{ai_provider:'codex'})");assert.equal(h.calls.length,1);
 h.calls[0].child.stdout.emit('data','{"status":"completed","answer":"ok"}');h.calls[0].child.emit('close',0);
 assert.equal((await p).code,0);
});
test('worker observes persisted changes between tasks, not during an execution',async t=>{
 const h=harness(t,'supabase-worker.js');c.writeDefault(h.dir,'codex');
 const first=h.run("execute('ok')");c.writeDefault(h.dir,'auto');
 h.calls[0].child.emit('close',0);await first;
 assert.equal((await h.run("execute('next')")).code,1);assert.equal(h.calls.length,1);
});
