'use strict';
// Internal entrypoint only: the supervisor reserves resources before launching this child.
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(process.argv[3]||'');
if(!['execute','publish'].includes(process.argv[2])||!process.env.CODEX_BRIDGE_RUNTIME_CHILD)throw Error('Internal runtime entrypoint');
process.env.CODEX_BRIDGE_LIBRARY_ONLY='1';process.env.CODEX_BRIDGE_STATE_DIR=path.join(root,'state');
process.umask(0o077);
const engine=require('../supabase-worker'),{save}=require('../executors/worker-control'),{sanitizer}=require('../task-progress');
const clean=sanitizer(process.env);
const task=JSON.parse(fs.readFileSync(path.join(root,'task.json'),'utf8'));
let timer;
(async()=>{
 fs.mkdirSync(process.env.CODEX_BRIDGE_STATE_DIR,{recursive:true,mode:0o700});
 timer=setInterval(()=>save(path.join(root,'executor-health.json'),{pid:process.pid,at:Date.now()}),2000);
 if(process.argv[2]==='execute'){
  const progress=engine.progressFor(task);
  let legacyControl=false;try{legacyControl=Object.hasOwn(JSON.parse(task.instruction),'bridge_control');}catch{}
  let run;
  // Device-only commands do not edit the workspace. The coordinator owns the ADB/artifact fence.
  const device=task.execution_mode==='command'&&task.command_payload?.action;
  try{run=legacyControl?{code:1,stdout:JSON.stringify({status:'failed',answer:'',error:'Runtime v2: use o controle local autenticado do supervisor; nenhum restart foi solicitado.',workspaceReleased:true}),stderr:''}:device?await require('../executors/command').executeCommand(task.command_payload,{cwd:path.resolve(__dirname,'..'),env:process.env,taskId:task.id,progress}):await engine.execute(task.instruction,task,progress);}
  catch{throw Error('Executor failed; effects require review');}
  // Redact text leaves, never pass the serialized protocol envelope to a line sanitizer.
  function redact(value){
   if(typeof value==='string')return value.split('\n').map(clean).join('\n');
   if(Array.isArray(value))return value.map(redact);
   if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,redact(v)]));
   return value;
  }
  let envelope;try{envelope=JSON.parse(run.stdout);}catch{}
  run=redact(run);
  run.stdout=envelope?JSON.stringify(redact(envelope)):redact(run.stdout||'');
  save(path.join(root,'result.json'),run); // fsync before publication: never repeat execution to publish
  try{await engine.finish(task,run,progress);}catch{ /* existing private receipt remains */ }
 }else{
  // Crash after result journaling but before creation of publication receipt.
  const run=JSON.parse(fs.readFileSync(path.join(root,'result.json'),'utf8'));
  process.env.CODEX_BRIDGE_REPLAY_PUBLICATION='1';
  if(!await engine.verifyPublished(task,run)){try{await engine.finish(task,run);}catch{}}
 }
 await engine.recoverResults();
 const run=JSON.parse(fs.readFileSync(path.join(root,'result.json'),'utf8'));
 const pending=path.join(root,'state/pending-results');
 const published=await engine.verifyPublished(task,run);
 const parsed=JSON.parse(run.stdout);
 save(path.join(root,'done.json'),{published,released:parsed.workspaceReleased===true,pid:process.pid});
})().catch(()=>{console.error('Runtime: execução/publicação incerta; consultar recibos privados.');process.exitCode=1;}).finally(()=>clearInterval(timer));
