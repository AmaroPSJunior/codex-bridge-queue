'use strict';

const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {createSafeCommandRunner}=require('./safe-command');

const MAX_STEPS=32;
const MAX_FILE_BYTES=131072;
const MAX_RETRIES=3;
const BLOCKED=/^(node_modules|logs|state|supabase-state|pending-results)$/i;
const SENSITIVE=/secret|credential|token|\.env|\.pem$|\.key$/i;

function fail(code,message){return Object.assign(new Error(message),{kind:code});}
function int(value,min,max,name){if(!Number.isSafeInteger(value)||value<min||value>max)throw fail('protocol',name+' inválido');return value;}

function relativeFile(root,value,{mustExist=false}={}){
  if(typeof value!=='string'||!value||value.length>512||path.isAbsolute(value)||value.includes('\\')||value.includes('\0'))throw fail('permission','Caminho recusado');
  const parts=value.split('/');
  if(parts.some(part=>!part||part==='.'||part==='..'||part.startsWith('.')||BLOCKED.test(part)||SENSITIVE.test(part)))throw fail('permission','Caminho recusado');
  const resolved=path.resolve(root,...parts);
  if(!resolved.startsWith(root+path.sep))throw fail('permission','Caminho recusado');
  const parent=path.dirname(resolved),parentReal=fs.realpathSync(parent);
  if(parentReal!==root&&!parentReal.startsWith(root+path.sep))throw fail('permission','Diretório recusado');
  if(mustExist){const st=fs.lstatSync(resolved);if(st.isSymbolicLink()||!st.isFile())throw fail('permission','Arquivo recusado');}
  else if(fs.existsSync(resolved)){const st=fs.lstatSync(resolved);if(st.isSymbolicLink()||!st.isFile())throw fail('permission','Arquivo recusado');}
  return resolved;
}

function validatePolicy(value={}){
  if(!value||Array.isArray(value)||typeof value!=='object'||Object.keys(value).some(k=>!['max_retries','rollback_on_failure','checkpoint','resume'].includes(k)))throw fail('protocol','Política inválida');
  const max_retries=value.max_retries??1;
  int(max_retries,0,MAX_RETRIES,'max_retries');
  for(const k of ['rollback_on_failure','checkpoint','resume'])if(value[k]!=null&&typeof value[k]!=='boolean')throw fail('protocol',k+' inválido');
  return {max_retries,rollback_on_failure:value.rollback_on_failure!==false,checkpoint:value.checkpoint!==false,resume:value.resume!==false};
}

function validate(payload){
  if(!payload||Array.isArray(payload)||typeof payload!=='object'||Object.keys(payload).some(k=>!['version','steps','policy'].includes(k))||payload.version!==1||!Array.isArray(payload.steps)||payload.steps.length<1||payload.steps.length>MAX_STEPS)throw fail('protocol','Plano inválido');
  const policy=validatePolicy(payload.policy||{});
  return {version:1,policy,steps:payload.steps.map((step,index)=>{
    if(!step||Array.isArray(step)||typeof step!=='object')throw fail('protocol','Etapa inválida: '+index);
    if(step.type==='write_file'){
      if(Object.keys(step).some(k=>!['type','path','content'].includes(k))||typeof step.path!=='string'||typeof step.content!=='string'||Buffer.byteLength(step.content)>MAX_FILE_BYTES)throw fail('protocol','write_file inválido: '+index);
      return {type:'write_file',path:step.path,content:step.content};
    }
    if(step.type==='delete_file'){
      if(Object.keys(step).some(k=>!['type','path'].includes(k))||typeof step.path!=='string')throw fail('protocol','delete_file inválido: '+index);
      return {type:'delete_file',path:step.path};
    }
    if(step.type==='run_command'){
      if(Object.keys(step).some(k=>!['type','command','args','retries'].includes(k))||typeof step.command!=='string'||!Array.isArray(step.args)||step.args.some(x=>typeof x!=='string'))throw fail('protocol','run_command inválido: '+index);
      const retries=step.retries??policy.max_retries;int(retries,0,MAX_RETRIES,'retries');
      return {type:'run_command',command:step.command,args:[...step.args],retries};
    }
    throw fail('protocol','Tipo de etapa recusado: '+index);
  })};
}

function hashSpec(spec){return crypto.createHash('sha256').update(JSON.stringify(spec)).digest('hex');}
function checkpointFile(cwd,taskId,spec){
  const folder=path.join(cwd,'supabase-state','plan-checkpoints');
  fs.mkdirSync(folder,{recursive:true,mode:0o700});
  const st=fs.lstatSync(folder);if(st.isSymbolicLink()||!st.isDirectory())throw fail('permission','Checkpoint inseguro');
  const key=crypto.createHash('sha256').update(String(taskId||hashSpec(spec))).digest('hex');
  return path.join(folder,key+'.json');
}
function writeCheckpoint(file,state){
  const tmp=file+'.tmp-'+process.pid;
  fs.writeFileSync(tmp,JSON.stringify(state),{flag:'w',mode:0o600});
  fs.renameSync(tmp,file);
}
function readCheckpoint(file,planHash){
  if(!fs.existsSync(file))return null;
  const st=fs.lstatSync(file);if(st.isSymbolicLink()||!st.isFile()||st.size>2*1024*1024)throw fail('permission','Checkpoint recusado');
  const value=JSON.parse(fs.readFileSync(file,'utf8'));
  if(value?.version!==1||value.plan_hash!==planHash||!Number.isSafeInteger(value.next_index)||!Array.isArray(value.results)||!value.backups||typeof value.backups!=='object')throw fail('protocol','Checkpoint incompatível');
  return value;
}
function safeUnlink(file){try{fs.unlinkSync(file);}catch(e){if(e.code!=='ENOENT')throw e;}}
function snapshot(cwd,relative,backups){
  if(Object.hasOwn(backups,relative))return;
  const file=relativeFile(cwd,relative);
  if(!fs.existsSync(file)){backups[relative]={exists:false};return;}
  const st=fs.lstatSync(file);if(st.size>MAX_FILE_BYTES)throw fail('permission','Arquivo grande demais para rollback');
  backups[relative]={exists:true,mode:st.mode&0o777,content:fs.readFileSync(file).toString('base64')};
}
function rollback(cwd,backups){
  const names=Object.keys(backups).reverse();
  for(const relative of names){
    const b=backups[relative],file=relativeFile(cwd,relative);
    if(!b.exists){safeUnlink(file);continue;}
    fs.writeFileSync(file,Buffer.from(b.content,'base64'),{flag:'w',mode:b.mode||0o600});
  }
}

async function executePlan(payload,{cwd,env=process.env,signal,progress,runSafeCommand,taskId}={}){
  let spec,checkpoint,planHash,state,resumed=false;
  try{
    spec=validate(payload);cwd=fs.realpathSync(cwd);planHash=hashSpec(spec);checkpoint=checkpointFile(cwd,taskId,spec);
    state={version:1,plan_hash:planHash,next_index:0,results:[],backups:{}};
    if(spec.policy.checkpoint&&spec.policy.resume){const prior=readCheckpoint(checkpoint,planHash);if(prior){state=prior;resumed=state.next_index>0||state.results.length>0;}}
  }catch(e){return envelope('failed',[],e.message,true,{resumed:false,rolledBack:false});}

  const runCommand=runSafeCommand||createSafeCommandRunner({cwd,env,allowGitCommit:false});
  const persist=()=>{if(spec.policy.checkpoint)writeCheckpoint(checkpoint,state);};
  try{
    for(let i=state.next_index;i<spec.steps.length;i++){
      if(signal?.aborted)throw fail('cancelled','Plano cancelado');
      const step=spec.steps[i];
      await progress?.planStep?.({index:i,total:spec.steps.length,type:step.type,command:step.command,path:step.path});
      if(step.type==='write_file'){
        snapshot(cwd,step.path,state.backups);state.next_index=i;persist();
        const file=relativeFile(cwd,step.path);fs.writeFileSync(file,step.content,{flag:'w',mode:0o600});
        state.results.push({index:i,type:step.type,path:step.path,status:'completed'});state.next_index=i+1;persist();continue;
      }
      if(step.type==='delete_file'){
        snapshot(cwd,step.path,state.backups);state.next_index=i;persist();
        const file=relativeFile(cwd,step.path,{mustExist:true});fs.unlinkSync(file);
        state.results.push({index:i,type:step.type,path:step.path,status:'completed'});state.next_index=i+1;persist();continue;
      }
      if(step.type==='run_command'){
        let r,attempt=0;
        state.next_index=i;persist();
        do{
          attempt++;
          await progress?.feed?.(`Executando ${step.command} ${step.args.join(' ')} (tentativa ${attempt}/${step.retries+1})\\n`,'stdout');
          r=await runCommand({command:step.command,args:step.args,signal});
          const output=String(r.output||'');if(output)await progress?.feed?.(output,'stdout');await progress?.commandComplete?.(r.code);
          if(r.code===0)break;
          if(signal?.aborted)throw fail('cancelled','Plano cancelado');
        }while(attempt<=step.retries);
        const output=String(r.output||'');
        state.results.push({index:i,type:step.type,command:step.command,args:step.args,exit_code:r.code,output,attempts:attempt,status:r.code===0?'completed':'failed'});
        if(r.code!==0){persist();throw fail('execution',`Etapa ${i} terminou com exit code ${r.code} após ${attempt} tentativa(s)`);}
        state.next_index=i+1;persist();
      }
    }
    safeUnlink(checkpoint);
    return envelope('completed',state.results,null,true,{resumed,rolledBack:false});
  }catch(e){
    const cancelled=signal?.aborted||e?.kind==='cancelled';let rolledBack=false;
    if(spec.policy.rollback_on_failure){
      try{rollback(cwd,state.backups);rolledBack=true;safeUnlink(checkpoint);}catch(rollbackError){return envelope('failed',state.results,'Falha no rollback: '+rollbackError.message,false,{resumed,rolledBack:false});}
    }else persist();
    return envelope(cancelled?'cancelled':'failed',state.results,e?.message||'Falha no plano',true,{resumed,rolledBack});
  }
}

function envelope(status,steps,error,released,{resumed=false,rolledBack=false}={}){
  return {code:status==='completed'?0:1,executionMode:'plan',planResult:{version:1,status,steps,error:error||null,resumed,rolled_back:rolledBack},stdout:JSON.stringify({status,answer:status==='completed'?`Plano concluído: ${steps.length} etapa(s).`:'',error:error||null,workspaceReleased:released}),stderr:''};
}

module.exports={validate,relativeFile,executePlan,MAX_STEPS,MAX_FILE_BYTES,MAX_RETRIES};
