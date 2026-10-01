#!/usr/bin/env node
'use strict';
// Explicit client: create from JSON stdin, or read one task. No automatic retries.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const {shortTitle,displayTask,inferTitle,taskSummary}=require('../task-display');
const ROOT=path.resolve(__dirname,'..');
function github(endpoint,method,body){
 const args=['api','--hostname','github.com',endpoint,'--method',method];if(body)args.push('--input','-');
 const r=spawnSync('gh',args,{input:body?JSON.stringify(body):undefined,encoding:'utf8',timeout:20000,shell:false});
 if(r.error||r.status!==0)throw Error('GitHub request failed; outcome may be uncertain.');return JSON.parse(r.stdout);
}
async function supabase(config,route,method,body){
 let key=process.env.CODEX_SUPABASE_SERVICE_ROLE_KEY;
 if(!key){const file=path.join(process.env.HOME,'.config/codex-bridge/supabase-service-role.key');const stat=fs.lstatSync(file);if(!stat.isFile()||(stat.mode&0o777)!==0o600)throw Error('Private credential required');key=fs.readFileSync(file,'utf8');}
 const url=config.supabase.url.replace(/\/$/,'');if(!url.startsWith('https://'))throw Error('HTTPS required');
 const r=await fetch(url+'/rest/v1/'+route,{method,redirect:'error',signal:AbortSignal.timeout(20000),headers:{apikey:key,Authorization:'Bearer '+key,'Content-Type':'application/json',Prefer:'return=representation'},body:body?JSON.stringify(body):undefined});
 if(!r.ok){let code;try{code=(await r.json()).code;}catch{}const e=Error('Supabase request failed; outcome may be uncertain.');e.missingColumn=r.status===400&&['42703','PGRST204'].includes(code);throw e;}return r.json();
}
function payload(input,transport){
 const prompt=input.instruction??input.prompt;
 if(typeof prompt!=='string'||!prompt.trim()||prompt.includes('\0')||Buffer.byteLength(prompt)>24000)throw Error('Invalid instruction');
 const id=input.id??input.task_id??crypto.randomUUID();
 if(transport==='supabase'&&!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id))throw Error('UUID required');
 if(transport==='github'&&!/^[A-Za-z0-9][A-Za-z0-9._-]{7,99}$/.test(id))throw Error('Invalid task_id');
 const title=shortTitle(input.title??input.task_name,transport==='github'?'Tarefa sem título':inferTitle(prompt));
 return transport==='github'?{title,labels:['codex:queued'],body:JSON.stringify({protocol:'codex-bridge/v1',task_id:id,title,prompt})}:{id,title,instruction:prompt,status:'queued'};
}
function lookupRoute(transport,id){
 if(transport==='github'){
  if(!/^[1-9][0-9]*$/.test(id||''))throw Error('Issue number required');
  return id;
 }
 if(/^[1-9][0-9]*$/.test(id||''))return 'bridge_tasks?task_number=eq.'+id+'&select=*';
 if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id||''))throw Error('Task number or UUID required');
 return 'bridge_tasks?id=eq.'+encodeURIComponent(id)+'&select=*';
}
async function main(args=process.argv.slice(2)){
 const [transport,action,id]=args;
 if(!['github','supabase'].includes(transport)||!['create','get'].includes(action))throw Error('Usage: tasks.cjs github|supabase create|get [id]');
 const config=JSON.parse(fs.readFileSync(path.join(ROOT,'remote-config.json')));
 let result;
 if(action==='create'){
  const body=payload(JSON.parse(fs.readFileSync(0,'utf8')),transport);
  // Keep the technical receipt even if the POST response is lost; no blind retry.
  const technicalId=transport==='github'?JSON.parse(body.body).task_id:body.id;
  process.stderr.write(JSON.stringify({receipt:{id:technicalId},message:'Guarde este ID técnico; se houver falha, consulte antes de reenviar.'})+'\n');
  if(transport==='supabase'){
   // Capability read only; never retry a potentially committed POST.
   let supported=false;
   try{await supabase(config,'bridge_tasks?select=task_number,title&limit=0','GET');supported=true;}
   catch(e){if(!e.missingColumn)throw e;}
   if(!supported)delete body.title;
  }
  result=transport==='github'?github('repos/'+config.repository+'/issues','POST',body):(await supabase(config,'bridge_tasks','POST',body))[0];
 }else{
  const route=lookupRoute(transport,id);
  result=transport==='github'?github('repos/'+config.repository+'/issues/'+route,'GET'):(await supabase(config,route,'GET'))[0];
 }
 if(!result)throw Error('Task not found');
 let technicalId=result.id, answer=result.result??null;
 if(transport==='github'){
  let task;try{task=JSON.parse(result.body);}catch{}
  technicalId=task?.task_id??null;
  if(action==='get'&&technicalId){
   const parts=[];
   for(let page=1;;page++){
    const comments=github('repos/'+config.repository+'/issues/'+id+'/comments?per_page=100&page='+page,'GET');
    for(const comment of comments){
     if(!config.allowedAuthors.some(a=>a.toLowerCase()===comment.user?.login?.toLowerCase()))continue;
     const marker='<!-- codex-bridge:result:'+technicalId+':';
     if(comment.body.startsWith(marker)){const m=comment.body.slice(marker.length).match(/^(\d+)\/(\d+) -->\n/);if(m)parts.push({index:Number(m[1]),body:comment.body.slice(marker.length+m[0].length)});}
    }
    if(comments.length<100)break;
   }
   if(parts.length)answer=parts.sort((a,b)=>a.index-b.index).map(p=>p.body).join('\n\n');
  }
 }
 const ghStatus=transport==='github'?result.labels?.map(l=>typeof l==='string'?l:l.name).find(l=>l.startsWith('codex:'))?.slice(6):null;
 const view=taskSummary({...result,status:result.status||ghStatus||result.state},transport);
 console.log(JSON.stringify({...view,id:technicalId,result:answer}));
}
if(require.main===module)main().catch(()=>{console.error('Task request failed. No automatic retry; inspect the receipt and service state. Details suppressed.');process.exitCode=1;});
module.exports={payload,lookupRoute,main};
