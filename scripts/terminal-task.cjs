'use strict';
const {spawn}=require('node:child_process');
const crypto=require('node:crypto');
const {StringDecoder}=require('node:string_decoder');
const fs=require('node:fs');
const path=require('node:path');
const {sanitizer}=require('../task-progress');

function fail(message){console.error(message);process.exitCode=2;}
function config(){
 let remote={};
 try{remote=JSON.parse(fs.readFileSync(path.join(__dirname,'..','remote-config.json'),'utf8'));}catch{}
 const url=String(process.env.CODEX_SUPABASE_URL||remote.supabase?.url||'').replace(/\/$/,'');
 const key=process.env.CODEX_SUPABASE_SERVICE_ROLE_KEY||'';
 if(!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url)||!key)throw Error('Configure CODEX_SUPABASE_URL e CODEX_SUPABASE_SERVICE_ROLE_KEY na sessão do Termux.');
 return {url,key};
}
async function main(){
 const args=process.argv.slice(2),separator=args.indexOf('--'),number=args[0],command=args.slice(separator+1).join(' ');
 if(separator<1||!/^\d+$/.test(number)||!command.trim())return fail('Uso: node scripts/terminal-task.cjs <número-da-tarefa> -- "comando para executar"');
 const {url,key}=config(),headers={apikey:key,Authorization:'Bearer '+key,'Content-Type':'application/json'};
 const query=new URLSearchParams({task_number:'eq.'+number,select:'id',limit:'1'});
 const taskResponse=await fetch(url+'/rest/v1/bridge_tasks?'+query,{headers,signal:AbortSignal.timeout(15000)});
 if(!taskResponse.ok)throw Error('Não foi possível localizar a tarefa ('+taskResponse.status+').');
 const rows=await taskResponse.json();if(!rows.length)throw Error('Tarefa #'+number+' não encontrada.');
 const taskId=rows[0].id,commandKey='manual-'+crypto.randomUUID(),clean=sanitizer(process.env),pending=[];
 let flushPromise=Promise.resolve(),timer,failed=false;
 async function flush(){
  clearTimeout(timer);timer=undefined;if(!pending.length)return flushPromise;
  const batch=pending.splice(0);
  flushPromise=flushPromise.then(async()=>{
   const response=await fetch(url+'/rest/v1/bridge_task_terminal_events?on_conflict=event_key',{
    method:'POST',headers:{...headers,Prefer:'resolution=ignore-duplicates,return=minimal'},
    body:JSON.stringify(batch),signal:AbortSignal.timeout(15000)
   });
   if(!response.ok)throw Error('Supabase '+response.status);
   failed=false;
  }).catch(error=>{pending.unshift(...batch);failed=true;console.error('Falha ao salvar o histórico do terminal:',error.message);});
  return flushPromise;
 }
 function add(event){pending.push({event_key:crypto.randomUUID(),task_id:taskId,command_key:commandKey,...event});if(pending.length>=30)void flush();else if(!timer)timer=setTimeout(()=>void flush(),1000);}
 function safe(value){let result=clean(value);if(Buffer.byteLength(result,'utf8')>524288)result='[linha excede limite; omitida]';return result;}
 const startCommand=safe(command).slice(0,2000);
 add({event_type:'command_start',command:startCommand});await flush();
 const child=spawn('bash',['-lc',command],{cwd:process.cwd(),shell:false,stdio:['inherit','pipe','pipe'],env:process.env});
 const streams=new Map();
 function output(stream,data){
  let state=streams.get(stream);if(!state){state={decoder:new StringDecoder('utf8'),partial:'',dropping:false};streams.set(stream,state);}
  const pieces=state.decoder.write(data).split('\n');
  for(let i=0;i<pieces.length;i++){
   if(!state.dropping){state.partial+=pieces[i];if(Buffer.byteLength(state.partial,'utf8')>524288){state.partial='';state.dropping=true;}}
   if(i<pieces.length-1){add({event_type:'output',stream,content:state.dropping?'[linha excede limite; omitida]':safe(state.partial.replace(/\r$/,''))});state.partial='';state.dropping=false;}
  }
 }
 child.stdout.on('data',chunk=>{process.stdout.write(chunk);output('stdout',chunk);});
 child.stderr.on('data',chunk=>{process.stderr.write(chunk);output('stderr',chunk);});
 const code=await new Promise(resolve=>{child.once('error',error=>{console.error(error.message);resolve(127);});child.once('close',value=>resolve(Number.isInteger(value)?value:1));});
 for(const [stream,state] of streams){const tail=state.decoder.end();if(!state.dropping)state.partial+=tail;if(state.partial||state.dropping)add({event_type:'output',stream,content:state.dropping?'[linha excede limite; omitida]':safe(state.partial.replace(/\r$/,''))});}
 add({event_type:'command_end',exit_code:code});await flush();
 if(failed||pending.length){await flush();if(failed||pending.length)console.error('Parte da saída pode não ter sido gravada; consulte a conexão do Termux.');}
 process.exitCode=code;
}
main().catch(error=>fail(error.message||'Falha ao executar o comando.'));
