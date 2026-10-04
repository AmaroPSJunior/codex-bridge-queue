'use strict';
const fs=require('fs'),path=require('path'),{spawn}=require('child_process');
const workerControl=require('./executors/worker-control');
const {mode:executionMode,executeCommand}=require('./executors/command');
const {createCodexExecutor,toLegacyRun}=require('./executors/codex');
const {createAntigravityExecutor}=require('./executors/antigravity');
const {createLocalExecutor,configFromEnv}=require('./executors/local-openai');
const {createGroqExecutor}=require('./executors/groq');
const {observation}=require('./executors/task-metadata');
const {createLifecycle,lifecycleSettings}=require('./executors/task-lifecycle');
const {receipt,pending:pendingReceipts}=require('./executors/result-receipt');
const {selectProvider,requireImplemented}=require('./executors/provider-config');
const {acquire:acquireWorkspace}=require('./executors/workspace-lock');
const {displayTask,taskSummary}=require('./task-display');
const {createProgress,localLog,sanitizer,commandStream}=require('./task-progress');
const {createSpeaker}=require('./task-tts');
const DIR=__dirname, STATE=path.join(DIR,'supabase-state');
const config=JSON.parse(fs.readFileSync(path.join(DIR,'remote-config.json')));
const sb=config.supabase||{};
const url=(process.env.CODEX_SUPABASE_URL||sb.url||'').replace(/\/$/,'');
const key=process.env.CODEX_SUPABASE_SERVICE_ROLE_KEY||'';
const pollSeconds=Number(sb.pollSeconds||config.pollSeconds||15);
const DEFAULT_EXECUTION_TIMEOUT_MS=900000;
fs.mkdirSync(STATE,{recursive:true,mode:0o700}); process.umask(0o077);
const speak=createSpeaker({spawn,setTimeout,clearTimeout,env:process.env});
function log(event,data={}){console.log(JSON.stringify({at:new Date().toISOString(),transport:'supabase',event,...data}));}
function headers(extra={}){return {apikey:key,Authorization:'Bearer '+key,'Content-Type':'application/json',...extra};}
async function request(route,options={}){
  const r=await fetch(url+'/rest/v1/'+route,{...options,headers:headers(options.headers)});
  const text=await r.text(); if(!r.ok)throw Error('Supabase '+r.status+': '+text.slice(0,1000));
  return text?JSON.parse(text):null;
}
async function next(){
  const rows=await request('bridge_tasks?status=eq.queued&select=*&order=created_at.asc&limit=1');
  return rows?.[0]||null;
}
async function claim(task){
  const rows=await request('bridge_tasks?id=eq.'+encodeURIComponent(task.id)+'&status=eq.queued',{
    method:'PATCH',headers:{Prefer:'return=representation'},body:JSON.stringify({status:'running',claimed_at:new Date().toISOString(),updated_at:new Date().toISOString()})
  });
  return rows?.[0]||null;
}
let activeProgress;
function progressFor(task){
  let file,fileClosed=false,localWarned=false;
  try{file=localLog(STATE,task.id);}catch{log('progress_local_log_unavailable');}
  const supported=['progress_message','recent_output','last_progress_at','progress_seq','last_flush_reason','last_flush_line_count'].every(k=>Object.prototype.hasOwnProperty.call(task,k));
  if(!supported)log('progress_local_only',{reason:'schema_pending'});
  const progress=createProgress({env:process.env,initialSeq:task.progress_seq,append:s=>{if(file&&!fileClosed)file.append(s);},
    onError:event=>{if(event==='local_log_failed'){if(localWarned)return;localWarned=true;}log(event);},write:async body=>{
      if(!supported)return {localOnly:true};
      const expected=String(BigInt(body.progress_seq)-1n);
      const route='bridge_tasks?id=eq.'+encodeURIComponent(task.id);
      // Compare-and-swap plus the DB trigger atomically advances exactly one step.
      const rows=await request(route+'&status=eq.running&progress_seq=eq.'+expected+'&select=id',{
        method:'PATCH',signal:AbortSignal.timeout(10000),headers:{Prefer:'return=representation'},body:JSON.stringify(body)
      });
      if(rows?.length)return;
      // A previous response may have been lost. One bounded read reconciles that
      // exact snapshot; this is not a polling loop and never repeats the increment.
      const saved=await request(route+'&select=progress_seq::text,progress_message,recent_output,last_flush_reason,last_flush_line_count&limit=1',{
        signal:AbortSignal.timeout(10000)
      });
      const row=saved?.[0];
      if(!row||String(row.progress_seq)!==body.progress_seq||
         ['progress_message','recent_output','last_flush_reason','last_flush_line_count'].some(k=>row[k]!==body[k]))throw Error('Progress not acknowledged');

    }});
  const close=progress.close;
  progress.close=async stage=>{try{await close(stage);}finally{if(!fileClosed){fileClosed=true;try{file?.close();}catch{log('progress_local_log_close_failed');}}}};
  return progress;
}
function executionTimeoutMs(){
  const value=process.env.CODEX_BRIDGE_TIMEOUT_MS||'';
  const number=Number(value);
  return /^\d+$/.test(value)&&Number.isSafeInteger(number)&&number>0&&number<=2147483647
    ? number : DEFAULT_EXECUTION_TIMEOUT_MS;
}
function runCodexProcess(prompt,task={},progress,workspaceToken){
  return new Promise(resolve=>{
    const child=spawn(path.join(process.env.PREFIX||'/data/data/com.termux/files/usr','bin/codex-bridge'),[prompt],{
      shell:false,stdio:['ignore','pipe','pipe'],env:{...process.env,...(workspaceToken?{CODEX_BRIDGE_WORKSPACE_TOKEN:workspaceToken}:{}),...(lifecycleSettings(process.env,config).validate?{CODEX_BRIDGE_TTS:'0'}:{}),CODEX_BRIDGE_JSON:'1',CODEX_BRIDGE_PROGRESS:progress?'1':'0',CODEX_BRIDGE_TASK_TRANSPORT:'supabase',CODEX_BRIDGE_TASK_NUMBER:displayTask(task).number||'',CODEX_BRIDGE_TASK_TITLE:displayTask(task).title,CODEX_BRIDGE_THREAD_FILE:path.join(DIR,'supabase-thread-id')}
    });
    let stdout='',stderr='',settled=false,outputDone=Promise.resolve();
    const capture=progress?commandStream(progress,s=>{stderr=(stderr+s).slice(-262144);}):null;
    child.stdout.on('data',d=>{stdout+=d;progress?.feed(d,'stdout');});
    child.stderr.on('data',d=>{
      if(!capture){stderr+=d;return;}
      // Backpressure bounds outstanding frames and awaits command flush before next frame.
      child.stderr.pause?.();
      outputDone=outputDone.then(()=>capture.write(d)).finally(()=>child.stderr.resume?.());
    });
    async function done(code,error){
      if(settled)return;settled=true;
      try{await outputDone;if(capture)await capture.end();await progress?.commandComplete?.(code);}
      catch{log('progress_capture_failed');}
      resolve({code,stdout,stderr,...(error?{error}: {})});
    }
    child.on('error',e=>{void done(1,e.message);});
    child.on('close',code=>{void done(code);});
  });
}
// Keep legacy invalid-input handling in the bridge (including its TTS/error output).
// Valid tasks use the provider contract; the queue receives the exact old envelope.
async function executeCodex(prompt,task={},progress,workspaceToken){
  if(typeof prompt!=='string'||!prompt.trim())return runCodexProcess(prompt,task,progress,workspaceToken);
  // Preserve native capture (UTF-8 decoder, per-command channels, backpressure).
  // The runner remains responsible for delivery to the existing progress sink.
  const executor=createCodexExecutor(input=>runCodexProcess(input.instruction,task,progress,workspaceToken));
  const result=await executor.execute({instruction:prompt});
  return toLegacyRun(result);
}
function executeAntigravity(prompt,task={},progress){
  const controller=new AbortController();
  const executor=createAntigravityExecutor({cwd:DIR,env:process.env,timeoutMs:executionTimeoutMs(),spawn,timer:setTimeout,clear:clearTimeout});
  const run=executor.execute({instruction:prompt,signal:controller.signal,onProgress:async event=>{
    if(event.type==='output')progress?.feed(event.text,event.stream);
    else if(event.type==='command_end')await progress?.commandComplete?.(event.code);
  }}).then(result=>({code:result.status==='completed'?0:1,stdout:JSON.stringify({status:result.status==='completed'?'completed':'failed',answer:result.answer,error:result.error?.message||null,workspaceReleased:result.workspaceReleased}),stderr:'',provider:'antigravity',providerErrorCode:result.error?.code}));
  run.cancel=()=>controller.abort();return run;
}
function executeLocal(prompt,task={},progress,provider='local',workspaceToken){
  const controller=new AbortController();
  const executor=provider==='groq'?createGroqExecutor({env:process.env,cwd:DIR,workspaceToken,timeoutMs:executionTimeoutMs()}):createLocalExecutor({...configFromEnv(process.env),env:process.env,timeoutMs:executionTimeoutMs()});
  const execution=executor.execute({instruction:prompt,signal:controller.signal,onProgress:async event=>{
    if(event.type==='output')progress?.feed(event.text,event.stream);
    else if(event.type==='command_end')await progress?.commandComplete?.(event.code);
  }}).then(result=>({code:result.status==='completed'?0:1,stdout:JSON.stringify({status:result.status==='completed'?'completed':'failed',answer:result.answer,error:result.error?.message||null,workspaceReleased:result.workspaceReleased}),stderr:'',provider,providerErrorCode:result.error?.code}));
  execution.cancel=()=>controller.abort();return execution;
}
function execute(prompt,task={},progress){
  let mode;
  try{mode=executionMode(task);}catch{return Promise.resolve({code:1,stdout:JSON.stringify({status:'failed',answer:'',error:'Modo/payload recusado.'}),stderr:''});}
  if(mode==='command'){
    let lease;
    try{lease=acquireWorkspace(DIR);}catch{return Promise.resolve({code:1,executionMode:'command',stdout:JSON.stringify({status:'failed',answer:'',error:'Workspace ocupado ou incerto.'}),stderr:''});}
    const controller=new AbortController();
    const run=executeCommand(task.command_payload,{cwd:DIR,env:process.env,signal:controller.signal,progress}).then(result=>{
      if(JSON.parse(result.stdout).workspaceReleased)lease.release();else lease.retain();return result;
    },()=>{lease.retain();return {code:1,executionMode:'command',stdout:JSON.stringify({status:'failed',answer:'',error:'Execução local incerta.'}),stderr:''};});
    run.cancel=()=>controller.abort();return run;
  }
  const controlRun=workerControl.control(STATE,prompt,task);if(controlRun)return Promise.resolve(controlRun);
  let selected;
  try{
    selected=requireImplemented(selectProvider({task,env:process.env}));
  }catch(e){
    const reasons={PROVIDER_INVALID:'Provider inválido.',PROVIDER_NOT_IMPLEMENTED:'Provider ainda não implementado no contrato Multi-IA.',PROVIDER_AUTO_DISABLED:'Seleção auto desabilitada: não há fallback automático nesta etapa.'};
    const error=reasons[e.code]||'Configuração de provider indisponível ou insegura.';
    return Promise.resolve({code:1,stdout:JSON.stringify({status:'failed',answer:'',error}),stderr:''});
  }
  let lease;
  try{lease=acquireWorkspace(DIR);}catch{
    return Promise.resolve({code:1,stdout:JSON.stringify({status:'failed',answer:'',error:'Workspace ocupado ou com execução incerta. Nenhum executor iniciado.'}),stderr:''});
  }
  const model=selected.provider==='groq'?(process.env.GROQ_MODEL||'openai/gpt-oss-120b'):selected.provider==='local'?(process.env.LOCAL_AI_MODEL||null):null;
  const lifecycle=createLifecycle({cwd:DIR,env:process.env,config,task});let execution,cancelled=false;
  function launch(){
    if(cancelled)throw Error('Cancelled before execution');
    execution=['local','groq'].includes(selected.provider)?executeLocal(prompt,task,progress,selected.provider,lease.token):selected.provider==='antigravity'?executeAntigravity(prompt,task,progress):executeCodex(prompt,task,progress,lease.token);
    return execution;
  }
  let pending;
  try{pending=lifecycle.enabled?lifecycle.begin().then(launch):launch();}
  catch{lease.release();return Promise.resolve({code:1,stdout:JSON.stringify({status:'failed',answer:'',error:'Não foi possível preparar o executor.'}),stderr:''});}
  const completion=pending.then(async run=>{
    run.providerSelection=selected;run.providerModel=model;
    let result;try{result=JSON.parse(run.stdout);}catch{}
    run.providerOutcome={code:run.code,status:result?.status};
    // Validation/commit must finish before the workspace lease can be released.
    if(result?.workspaceReleased===true){run=await lifecycle.complete(run);let final;try{final=JSON.parse(run.stdout);}catch{}if(final?.workspaceReleased===true)lease.release();else lease.retain();}else lease.retain();
    return run;
  },()=>{if(execution)lease.retain();else lease.release();return {code:1,stdout:JSON.stringify({status:'failed',answer:'',error:'Falha na preparação ou contrato do executor.'}),stderr:''};});
  completion.cancel=()=>{cancelled=true;execution?.cancel?.();};
  return completion;
}

async function finish(task,run,progress){
  const metadata=observation(task,run,process.env);
  let parsed; try{parsed=JSON.parse(run.stdout.trim());}catch{}
  const ok=run.code===0&&parsed?.status==='completed';
  const finalStatus=ok?'succeeded':run.executionMode==='command'&&parsed?.status==='cancelled'?'cancelled':'failed';
  const rawResult=typeof parsed?.answer==='string'?parsed.answer:run.stdout||'(sem resposta textual)';
  const result=String(rawResult).split(/\r?\n/).map(sanitizer(process.env)).join('\n');
  const rawError=parsed?.error||run.error||run.stderr||null;
  const error=rawError&&String(rawError).split(/\r?\n/).map(sanitizer(process.env)).join('\n');
  if(progress)await progress.close(finalStatus);
  const payload={status:finalStatus,result,error,completed_at:new Date().toISOString(),updated_at:new Date().toISOString()};
  if(Object.hasOwn(task,'execution_mode'))payload.execution_mode=run.executionMode||'agent';
  if(run.executionMode==='command'){
    if(Object.hasOwn(task,'command_result')&&run.commandResult)payload.command_result=run.commandResult;
    for(const field of ['actual_provider','provider_model','provider_session_id','fallback_from','fallback_reason'])if(Object.hasOwn(task,field))payload[field]=null;
  }
  if(run.gitMetadata&&['git_status','commit_sha','git_files'].every(k=>Object.prototype.hasOwnProperty.call(task,k)))Object.assign(payload,run.gitMetadata);
  // Durable sanitized receipt precedes publication; failure never reruns the provider.
  receipt(STATE,task.id,payload,metadata);
  if(metadata){
    const recorded=await request('rpc/bridge_record_multi_ai',{method:'POST',signal:AbortSignal.timeout(10000),body:JSON.stringify(metadata)});
    if(recorded!==true)throw Error('Metadados não confirmados; resultado preservado no recibo.');
  }
  await request('bridge_tasks?id=eq.'+encodeURIComponent(task.id)+'&status=eq.running',{
    method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify(payload)
  });
  // Receipt is removed only after a read confirms publication (recoverResults).
  if(['antigravity','local','groq'].includes(run.provider)||(run.providerSelection?.provider==='codex'&&(lifecycleSettings(process.env,config).validate)))void speak(displayTask(task),{status:ok?'completed':'failed',answer:result,error});
  log('execution_finish',{id:task.id,taskNumber:displayTask(task).number,status:finalStatus});
  return {...taskSummary({...task,status:finalStatus}),result,error,...run.gitMetadata};
}
async function recoverResults(){
  for(const item of pendingReceipts(STATE)){
    try{
      const route='bridge_tasks?id=eq.'+encodeURIComponent(item.id);
      let rows=await request(route+'&select=status,result,error&limit=1',{signal:AbortSignal.timeout(10000)});
      if(rows?.[0]?.status==='running'){
        if(item.metadata){const recorded=await request('rpc/bridge_record_multi_ai',{method:'POST',signal:AbortSignal.timeout(10000),body:JSON.stringify(item.metadata)});if(recorded!==true)throw Error('Metadata unacknowledged');}
        await request(route+'&status=eq.running',{method:'PATCH',signal:AbortSignal.timeout(10000),headers:{Prefer:'return=minimal'},body:JSON.stringify(item.payload)});
        rows=await request(route+'&select=status,result,error&limit=1',{signal:AbortSignal.timeout(10000)});
      }
      const row=rows?.[0];
      if(row&&['status','result','error'].every(k=>row[k]===item.payload[k])){workerControl.confirm(STATE,item.id);fs.unlinkSync(item.file);}
      else log('result_receipt_needs_review');
    }catch{log('result_receipt_pending');}
  }
}
let stopping=false,wake,activeExecution;
for(const sig of ['SIGTERM','SIGINT'])process.on(sig,()=>{stopping=true;if(activeExecution?.cancel)activeExecution.cancel();if(activeProgress)void activeProgress.checkpoint('shutdown');if(wake)wake();});
async function main(){
  if(!url||!key)throw Error('Defina CODEX_SUPABASE_SERVICE_ROLE_KEY; URL pode vir de remote-config.json ou CODEX_SUPABASE_URL.');
  log('started',{url,pollSeconds});
  while(!stopping){
    try{
      await recoverResults();
      if(workerControl.checkpoint(STATE,DIR,process.pid)){
        await new Promise(resolve=>{const t=setTimeout(resolve,1000);wake=()=>{clearTimeout(t);resolve();};});continue;
      }
      const task=await next();
      if(process.env.BRIDGE_SUPERVISOR_GENERATION)workerControl.save(path.join(STATE,'control','boot.json'),{pid:process.pid,generation:process.env.BRIDGE_SUPERVISOR_GENERATION});
      if(task){
        const claimed=await claim(task);
        if(claimed){
          log('execution_start',{id:task.id,taskNumber:displayTask(claimed).number});
          activeProgress=progressFor(claimed);
          try{activeExecution=execute(task.instruction,claimed,activeProgress);await finish(claimed,await activeExecution,activeProgress);}
          finally{activeExecution=undefined;await activeProgress.close('shutdown');activeProgress=undefined;}
          continue;
        }
      }
    }catch(e){log('poll_error',{error:'Falha na fila; consulte recibos locais privados.'});}
    await new Promise(resolve=>{const t=setTimeout(resolve,pollSeconds*1000);wake=()=>{clearTimeout(t);resolve();};});
  }
  log('stopped');
}
main().catch(e=>{log('fatal',{error:e.message});process.exitCode=1;});
