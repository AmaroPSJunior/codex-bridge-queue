'use strict';
const {spawn}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path');
const {commitMessage}=require('../task-git');
function lifecycleSettings(env=process.env,config={}){
 const git=env.CODEX_BRIDGE_TASK_GIT==='1'||env.CODEX_BRIDGE_TASK_AUTOCOMMIT==='1'||config.git?.autoCommit===true;
 return {git,validate:git||env.CODEX_BRIDGE_VALIDATE==='1'};
}
function command(cwd,file,args,env){return new Promise((resolve,reject)=>{
 const child=spawn(file,args,{cwd,env,shell:false,stdio:['ignore','pipe','pipe']});let out='',size=0,failed=false;
 const timer=setTimeout(()=>{failed=true;child.kill('SIGTERM');reject(Object.assign(Error('Lifecycle command timeout'),{uncertain:true}));},900000);
 child.stdout.on('data',d=>{size+=d.length;if(size>4*1024*1024){failed=true;child.kill('SIGTERM');reject(Object.assign(Error('Lifecycle output limit'),{uncertain:true}));}else out+=d;});child.stderr.on('data',()=>{});
 child.on('error',()=>{clearTimeout(timer);reject(Error('Lifecycle command unavailable'));});child.on('close',code=>{clearTimeout(timer);if(!failed)code===0?resolve(out.trimEnd()):reject(Error('Lifecycle command failed'));});
});}
function createLifecycle({cwd,env=process.env,config={},task={},run=(file,args)=>command(cwd,file,args,env)}={}){
 const {git,validate}=lifecycleSettings(env,config);let head;
 return {enabled:validate,async begin(){if(git){if(await run('git',['status','--porcelain=v1','--untracked-files=all']))throw Error('Workspace inicialmente sujo; commit automático recusado.');head=await run('git',['rev-parse','HEAD']);}},async complete(result){
  let parsed;try{parsed=JSON.parse(result.stdout);}catch{}
  if(result.code!==0||parsed?.status!=='completed')return {...result,gitMetadata:{git_status:'not_attempted',commit_sha:null,git_files:[]}};
  try{
   if(validate)await run('npm',['test']);
   if(!git)return {...result,gitMetadata:{git_status:'disabled',commit_sha:null,git_files:[]}};
   if(await run('git',['rev-parse','HEAD'])!==head)throw Error('HEAD mudou durante a tarefa; segundo commit recusado.');
   const status=await run('git',['status','--porcelain=v1','--untracked-files=all']);
   if(!status)return {...result,gitMetadata:{git_status:'no_changes',commit_sha:null,git_files:[]}};
   // Reject pre-staged entries: another actor may have staged work; never reset it.
   if(await run('git',['diff','--cached','--name-only']))throw Error('Index alterado durante a tarefa; revisão necessária.');
   const names=(await run('git',['ls-files','--modified','--deleted','--others','--exclude-standard','-z'])).split('\0').filter(Boolean);
   const files=[...new Set(names)];
   for(const file of files){
    if(!file||file.startsWith('-')||path.isAbsolute(file)||file.split('/').some(x=>['..','.git','.config','.codex','.agents'].includes(x))||/(^|\/)(\.env[^/]*|[^/]*(secret|credential|token|\.key|\.pem)[^/]*)$/i.test(file))throw Error('Arquivo privado recusado pelo task-git.');
    const full=path.join(cwd,file);let st;try{st=fs.lstatSync(full);}catch(e){if(e.code==='ENOENT')continue;throw e;}
    if(!st.isFile()||st.size>2*1024*1024)throw Error('Arquivo requer revisão manual.');
    const body=fs.readFileSync(full,'utf8');
    for(const [name,value]of Object.entries(env))if(/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(name)&&value&&body.includes(value))throw Error('Credencial detectada; commit recusado.');
    if(/(?:gsk_|sb_secret_|github_pat_|ghp_)[A-Za-z0-9_]{15,}|-----BEGIN .*PRIVATE KEY-----/.test(body))throw Error('Possível credencial; commit recusado.');
   }
   await run('git',['add','--',...files]);await run('git',['commit','-m',commitMessage(task)]);
   const sha=await run('git',['rev-parse','HEAD']);return {...result,gitMetadata:{git_status:'committed',commit_sha:sha,git_files:files}};
  }catch(error){
   return {...result,code:1,stdout:JSON.stringify({...parsed,...(error.uncertain?{workspaceReleased:false}:{}),status:'failed',error:'Validação ou commit da tarefa falhou; saída preservada para revisão.'}),gitMetadata:git?{git_status:'failed',commit_sha:null,git_files:[]}:undefined};
  }
 }};
}
module.exports={createLifecycle,lifecycleSettings};
