// Execute actual source with isolated filesystem, fake transport/process/timers.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {EventEmitter}=require('node:events');
const ROOT=path.resolve(__dirname,'..');
function harness(t,file,options={}) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-unit-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const config={repository:'owner/queue',allowedAuthors:['owner'],maxPromptBytes:24,pollSeconds:1,supabase:{url:'https://example.invalid',pollSeconds:1},...options.config};
 fs.writeFileSync(path.join(dir,'remote-config.json'),JSON.stringify(config));
 const calls=[],logs=[],timers=[];
 const proc=new EventEmitter();Object.assign(proc,{env:{HOME:dir,PREFIX:dir,CODEX_SUPABASE_SERVICE_ROLE_KEY:'synthetic-only',...options.env},pid:12345,argv:options.argv||['node',file],umask:()=>{},exit:code=>{throw Error('exit '+code);}});
 function spawn(command,args,opts){
  const child=new EventEmitter();child.pid=456;child.stdin=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin.end=input=>{child.input=input;};
  child.kill=sig=>{child.killed=sig;child.emit('close',null);};child.unref=()=>{};
  calls.push({command,args,opts,child});return child;
 }
 const context={Buffer,URL,AbortSignal,AbortController,console:{log:s=>logs.push(s),error:s=>logs.push(s)},__dirname:dir,__filename:path.join(dir,file),process:proc,module:{exports:{}},exports:{},fetch:options.fetch||(()=>{throw Error('Unexpected network call');}),setTimeout:(fn,ms)=>{const x={fn,ms,unref(){return this;}};timers.push(x);return x;},clearTimeout:x=>{if(x)x.cleared=true;},setInterval:(fn,ms)=>{timers.push({fn,ms});},require:name=>{
  if(name==='./executors/command')return options.modules?.[name]||require('../executors/command');
  if(name==='./executors/workspace-lock')return options.modules?.[name]||{acquire:()=>({token:undefined,release(){},retain(){}})};
  if(name==='./executors/provider-config')return require('../executors/provider-config');
  if(name==='./executors/task-lifecycle')return options.modules?.[name]||require('../executors/task-lifecycle');
  if(name==='./executors/worker-control')return require('../executors/worker-control');
  if(name==='./executors/result-receipt')return require('../executors/result-receipt');
  if(name==='./executors/task-metadata')return require('../executors/task-metadata');
  if(name==='./executors/groq')return options.modules?.[name]||require('../executors/groq');
  if(name==='./executors/local-openai')return options.modules?.[name]||require('../executors/local-openai');
  if(name==='./executors/antigravity')return options.modules?.[name]||require('../executors/antigravity');
  if(name==='./executors/codex')return require('../executors/codex');
  if(name==='./task-progress')return require('../task-progress');
  if(name==='./task-tts')return require('../task-tts');
  if(name==='./task-display')return require('../task-display');
  if(name==='child_process')return {spawn};
  if(options.modules?.[name])return options.modules[name];
  if(['fs','path','crypto'].includes(name))return require(name);
  throw Error('Unmocked module '+name);
 }};
 vm.createContext(context);
 let source=fs.readFileSync(path.join(ROOT,file),'utf8');
 if(file==='supabase-worker.js'){
  const entry="main().catch(e=>{log('fatal',{error:e.message});process.exitCode=1;});";
  if(!source.includes(entry))throw Error('Entry point changed: update test harness');
  source=source.replace(entry,'');
 }
 vm.runInContext(source,context,{filename:file});
 return {dir,calls,logs,timers,proc,context,run:s=>vm.runInContext(s,context),set:(k,v)=>context[k]=v};
}
const flush=()=>new Promise(r=>setImmediate(r));
module.exports={harness,flush};
