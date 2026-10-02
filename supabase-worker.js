'use strict';
const fs=require('fs'),path=require('path'),{spawn}=require('child_process');
const {displayTask,taskSummary}=require('./task-display');
const {createProgress,localLog,sanitizer,commandStream}=require('./task-progress');
const {inspectRepository,commitTaskChanges}=require('./task-git');
const {createSpeaker}=require('./task-tts');
const DIR=__dirname, STATE=path.join(DIR,'supabase-state');
const config=JSON.parse(fs.readFileSync(path.join(DIR,'remote-config.json')));
const sb=config.supabase||{};
const gitConfig=config.git||{};
const autoCommitEnabled=
  process.env.CODEX_BRIDGE_TASK_AUTOCOMMIT==='1' ||
  gitConfig.autoCommit===true;
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
function executeCodex(prompt,task={},progress){
  return new Promise(resolve=>{
    const child=spawn(path.join(process.env.PREFIX||'/data/data/com.termux/files/usr','bin/codex-bridge'),[prompt],{
      shell:false,stdio:['ignore','pipe','pipe'],env:{...process.env,CODEX_BRIDGE_JSON:'1',CODEX_BRIDGE_PROGRESS:progress?'1':'0',CODEX_BRIDGE_TASK_TRANSPORT:'supabase',CODEX_BRIDGE_TASK_NUMBER:displayTask(task).number||'',CODEX_BRIDGE_TASK_TITLE:displayTask(task).title,CODEX_BRIDGE_THREAD_FILE:path.join(DIR,'supabase-thread-id')}
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
function normalizeAntigravity(stdout,stderr='',spawnError=null){
  let parsed;
  try{parsed=JSON.parse(String(stdout||'').trim());}catch{}
  if(!parsed||typeof parsed!=='object')return {status:'failed',answer:'',error:spawnError||'Resposta JSON inválida do agy.'};
  if(parsed.status==='SUCCESS')return {status:'completed',answer:typeof parsed.response==='string'?parsed.response:String(parsed.response||''),error:null};
  return {status:'failed',answer:typeof parsed.response==='string'?parsed.response:'',error:parsed.error||spawnError||stderr||'agy terminou com status de erro.'};
}
function executeAntigravity(prompt,task={},progress){
  const args=['--print='+prompt,'--output-format','json'];
  let cancel=()=>{};
  const result=new Promise(resolve=>{
    const child=spawn('agy',args,{cwd:DIR,shell:false,stdio:['ignore','pipe','pipe'],env:{...process.env}});
    let stdout='',stderr='',settled=false,timeoutHandle;
    const finish=(code,error)=>{
      if(settled)return;settled=true;
      if(timeoutHandle!==undefined)clearTimeout(timeoutHandle);
      const normalized=normalizeAntigravity(stdout,stderr,error);
      void Promise.resolve(progress?.commandComplete?.(code)).then(()=>resolve({
        code:code===0&&normalized.status==='completed'?0:1,
        stdout:JSON.stringify(normalized),stderr,...(error?{error}: {})
      }));
    };
    cancel=()=>{if(!settled)child.kill?.('SIGTERM');};
    timeoutHandle=setTimeout(()=>{cancel();finish(1,'Timeout após '+executionTimeoutMs()+' ms; agy foi encerrado.');},executionTimeoutMs());
    timeoutHandle?.unref?.();
    child.stdout.on('data',d=>{stdout+=d;progress?.feed(d,'stdout');});
    child.stderr.on('data',d=>{stderr+=d;progress?.feed(d,'stderr');});
    child.on('error',e=>finish(1,e.message));
    child.on('close',code=>finish(code));
  });
  result.cancel=cancel;
  return result;
}
function execute(prompt,task={},progress){
  return process.env.AI_PROVIDER==='antigravity' ? executeAntigravity(prompt,task,progress) : executeCodex(prompt,task,progress);
}
async function finish(task,run,progress,gitState={}){
  let parsed; try{parsed=JSON.parse(run.stdout.trim());}catch{}
  const executionOk=run.code===0&&parsed?.status==='completed';
  const result=parsed?.answer||run.stdout||'(sem resposta textual)';
  const rawError=parsed?.error||run.error||run.stderr||null;
  let error=rawError&&String(rawError).split(/\r?\n/).map(sanitizer(process.env)).join('\n');

  let gitResult={
    status:autoCommitEnabled?'not_attempted':'disabled',
    commit_sha:null,
    files:[]
  };

  if(executionOk&&autoCommitEnabled){
    try{
      if(gitState.error)throw new Error('Git inspection failed');
      gitResult=await commitTaskChanges({
        cwd:DIR,
        task,
        before:gitState.before,
        enabled:true
      });
    }catch(e){
      gitResult={status:'failed',commit_sha:null,files:[]};
      error='Git commit failed: '+String(e.message||e);
      log('task_git_failed',{id:task.id,error:e.message});
    }
  }

  const ok=executionOk&&gitResult.status!=='failed';

  if(progress)await progress.close(ok?'succeeded':'failed');

  const completion={
    status:ok?'succeeded':'failed',
    result,
    error,
    completed_at:new Date().toISOString(),
    updated_at:new Date().toISOString()
  };

  const gitSchemaSupported=
    ['git_status','commit_sha','git_files']
      .every(k=>Object.prototype.hasOwnProperty.call(task,k));

  if(gitSchemaSupported){
    completion.git_status=gitResult.status;
    completion.commit_sha=gitResult.commit_sha;
    completion.git_files=gitResult.files||[];
  }

  await request('bridge_tasks?id=eq.'+encodeURIComponent(task.id),{
    method:'PATCH',
    headers:{Prefer:'return=minimal'},
    body:JSON.stringify(completion)
  });

  if(process.env.AI_PROVIDER==='antigravity'){
    await speak(displayTask(task),{status:ok?'completed':'failed',answer:result,error});
  }

  log('execution_finish',{
    id:task.id,
    taskNumber:displayTask(task).number,
    status:ok?'succeeded':'failed',
    gitStatus:gitResult.status,
    commitSha:gitResult.commit_sha
  });

  return {
    ...taskSummary({...task,status:ok?'succeeded':'failed'}),
    result,
    error,
    git_status:gitResult.status,
    commit_sha:gitResult.commit_sha,
    git_files:gitResult.files||[]
  };
}
let stopping=false,wake,activeExecution;
for(const sig of ['SIGTERM','SIGINT'])process.on(sig,()=>{stopping=true;if(activeExecution?.cancel)activeExecution.cancel();if(activeProgress)void activeProgress.checkpoint('shutdown');if(wake)wake();});
async function main(){
  if(!url||!key)throw Error('Defina CODEX_SUPABASE_SERVICE_ROLE_KEY; URL pode vir de remote-config.json ou CODEX_SUPABASE_URL.');
  log('started',{url,pollSeconds});
  while(!stopping){
    try{
      const task=await next();
      if(task){
        const claimed=await claim(task);
        if(claimed){
          log('execution_start',{id:task.id,taskNumber:displayTask(claimed).number});
          const gitState={before:null,error:null};
          if(autoCommitEnabled){
            try{
              gitState.before=await inspectRepository({cwd:DIR});
              log('task_git_start',{
                id:task.id,
                clean:gitState.before.clean,
                head:gitState.before.head
              });
            }catch(e){
              gitState.error=e.message;
              log('task_git_inspect_failed',{id:task.id,error:e.message});
            }
          }
          activeProgress=progressFor(claimed);
          try{
            activeExecution=execute(task.instruction,claimed,activeProgress);
            await finish(
              claimed,
              await activeExecution,
              activeProgress,
              gitState
            );
          }
          finally{activeExecution=undefined;await activeProgress.close('shutdown');activeProgress=undefined;}
          continue;
        }
      }
    }catch(e){log('poll_error',{error:e.message});}
    await new Promise(resolve=>{const t=setTimeout(resolve,pollSeconds*1000);wake=()=>{clearTimeout(t);resolve();};});
  }
  log('stopped');
}
main().catch(e=>{log('fatal',{error:e.message});process.exitCode=1;});
