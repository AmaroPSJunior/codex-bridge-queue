'use strict';
const fs=require('fs'),path=require('path'),{spawn}=require('child_process');
const {displayTask,taskSummary}=require('./task-display');
const {createProgress,localLog,sanitizer,commandStream}=require('./task-progress');
const DIR=__dirname, STATE=path.join(DIR,'supabase-state');
const config=JSON.parse(fs.readFileSync(path.join(DIR,'remote-config.json')));
const sb=config.supabase||{};
const url=(process.env.CODEX_SUPABASE_URL||sb.url||'').replace(/\/$/,'');
const key=process.env.CODEX_SUPABASE_SERVICE_ROLE_KEY||'';
const pollSeconds=Number(sb.pollSeconds||config.pollSeconds||15);
fs.mkdirSync(STATE,{recursive:true,mode:0o700}); process.umask(0o077);
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
function execute(prompt,task={},progress){
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
async function finish(task,run,progress){
  let parsed; try{parsed=JSON.parse(run.stdout.trim());}catch{}
  const ok=run.code===0&&parsed?.status==='completed';
  const result=parsed?.answer||run.stdout||'(sem resposta textual)';
  const rawError=parsed?.error||run.error||run.stderr||null;
  const error=rawError&&String(rawError).split(/\r?\n/).map(sanitizer(process.env)).join('\n');
  if(progress)await progress.close(ok?'succeeded':'failed');
  await request('bridge_tasks?id=eq.'+encodeURIComponent(task.id),{
    method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify({
      status:ok?'succeeded':'failed',result,error,completed_at:new Date().toISOString(),updated_at:new Date().toISOString()
    })
  });
  log('execution_finish',{id:task.id,taskNumber:displayTask(task).number,status:ok?'succeeded':'failed'});
  return {...taskSummary({...task,status:ok?'succeeded':'failed'}),result,error};
}
let stopping=false,wake;
for(const sig of ['SIGTERM','SIGINT'])process.on(sig,()=>{stopping=true;if(activeProgress)void activeProgress.checkpoint('shutdown');if(wake)wake();});
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
          activeProgress=progressFor(claimed);
          try{await finish(claimed,await execute(task.instruction,claimed,activeProgress),activeProgress);}
          finally{await activeProgress.close('shutdown');activeProgress=undefined;}
          continue;
        }
      }
    }catch(e){log('poll_error',{error:e.message});}
    await new Promise(resolve=>{const t=setTimeout(resolve,pollSeconds*1000);wake=()=>{clearTimeout(t);resolve();};});
  }
  log('stopped');
}
main().catch(e=>{log('fatal',{error:e.message});process.exitCode=1;});
