'use strict';
const fs=require('fs'),path=require('path'),{spawn}=require('child_process');
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
  const rows=await request('bridge_tasks?status=eq.queued&select=id,instruction,created_at&order=created_at.asc&limit=1');
  return rows?.[0]||null;
}
async function claim(task){
  const rows=await request('bridge_tasks?id=eq.'+encodeURIComponent(task.id)+'&status=eq.queued',{
    method:'PATCH',headers:{Prefer:'return=representation'},body:JSON.stringify({status:'running',claimed_at:new Date().toISOString(),updated_at:new Date().toISOString()})
  });
  return rows?.[0]||null;
}
function execute(prompt){
  return new Promise(resolve=>{
    const child=spawn(path.join(process.env.PREFIX||'/data/data/com.termux/files/usr','bin/codex-bridge'),[prompt],{
      shell:false,stdio:['ignore','pipe','pipe'],env:{...process.env,CODEX_BRIDGE_JSON:'1',CODEX_BRIDGE_THREAD_FILE:path.join(DIR,'supabase-thread-id')}
    });
    let stdout='',stderr='';
    child.stdout.on('data',d=>stdout+=d); child.stderr.on('data',d=>stderr+=d);
    child.on('error',e=>resolve({code:1,stdout,stderr,error:e.message}));
    child.on('close',code=>resolve({code,stdout,stderr}));
  });
}
async function finish(task,run){
  let parsed; try{parsed=JSON.parse(run.stdout.trim());}catch{}
  const ok=run.code===0&&parsed?.status==='completed';
  const result=parsed?.answer||run.stdout||'(sem resposta textual)';
  const error=parsed?.error||run.error||run.stderr||null;
  await request('bridge_tasks?id=eq.'+encodeURIComponent(task.id),{
    method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify({
      status:ok?'succeeded':'failed',result,error,completed_at:new Date().toISOString(),updated_at:new Date().toISOString()
    })
  });
  log('execution_finish',{id:task.id,status:ok?'succeeded':'failed'});
}
let stopping=false,wake;
for(const sig of ['SIGTERM','SIGINT'])process.on(sig,()=>{stopping=true;if(wake)wake();});
async function main(){
  if(!url||!key)throw Error('Defina CODEX_SUPABASE_SERVICE_ROLE_KEY; URL pode vir de remote-config.json ou CODEX_SUPABASE_URL.');
  log('started',{url,pollSeconds});
  while(!stopping){
    try{
      const task=await next();
      if(task){
        const claimed=await claim(task);
        if(claimed){log('execution_start',{id:task.id});await finish(task,await execute(task.instruction));continue;}
      }
    }catch(e){log('poll_error',{error:e.message});}
    await new Promise(resolve=>{const t=setTimeout(resolve,pollSeconds*1000);wake=()=>{clearTimeout(t);resolve();};});
  }
  log('stopped');
}
main().catch(e=>{log('fatal',{error:e.message});process.exitCode=1;});
