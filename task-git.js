'use strict';

const {spawn}=require('child_process');

function runGit(args,{cwd,spawnFn=spawn}={}){
  return new Promise((resolve,reject)=>{
    const child=spawnFn('git',args,{
      cwd,
      shell:false,
      stdio:['ignore','pipe','pipe']
    });

    let stdout='',stderr='',settled=false;

    child.stdout.on('data',chunk=>{stdout+=String(chunk);});
    child.stderr.on('data',chunk=>{stderr+=String(chunk);});

    child.on('error',err=>{
      if(settled)return;
      settled=true;
      reject(err);
    });

    child.on('close',code=>{
      if(settled)return;
      settled=true;

      if(code!==0){
        const err=new Error('git '+args[0]+' failed');
        err.code=code;
        err.stderr=stderr;
        reject(err);
        return;
      }

      resolve(stdout.trim());
    });
  });
}

async function inspectRepository({cwd,spawnFn}={}){
  const root=await runGit(
    ['rev-parse','--show-toplevel'],
    {cwd,spawnFn}
  );

  const head=await runGit(
    ['rev-parse','HEAD'],
    {cwd:root,spawnFn}
  );

  const status=await runGit(
    ['status','--porcelain=v1','--untracked-files=normal'],
    {cwd:root,spawnFn}
  );

  return {
    root,
    head,
    clean:status.length===0,
    status
  };
}

function sensitivePath(file){const n=String(file||"").replace(/\\\\/g,"/");return /(^|\/)\.env($|\.)/i.test(n)||/\.(key|pem|p12|pfx)$/i.test(n)||/(^|\/)(credentials?|secrets?)(\.|\/|$)/i.test(n)||/(^|\/)supabase-state\//i.test(n);}

async function unstageAll(root,spawnFn){try{await runGit(["reset","--mixed","HEAD","--","."],{cwd:root,spawnFn});}catch{}}

function commitMessage(task={}){
  const number=task.task_number ?? task.number ?? null;
  const title=String(task.title||task.task_name||'Tarefa')
    .replace(/[\r\n\0]+/g,' ')
    .replace(/\s+/g,' ')
    .trim()
    .slice(0,80);

  return number
    ? `task(${number}): ${title}`
    : `task: ${title}`;
}

async function commitTaskChanges({
  cwd,
  task,
  before,
  enabled=false,
  spawnFn
}={}){
  if(!enabled){
    return {status:'disabled',commit_sha:null};
  }

  if(!before?.clean){
    return {status:'dirty_start',commit_sha:null};
  }

  const current=await inspectRepository({cwd,spawnFn});

  if(current.root!==before.root){
    throw new Error('Git repository changed during task');
  }

  if(current.head!==before.head){
    throw new Error('Git HEAD changed during task');
  }

  if(current.clean){
    return {status:'no_changes',commit_sha:null};
  }

  await runGit(
    ['add','-A','--','.'],
    {cwd:current.root,spawnFn}
  );

  const staged=await runGit(
    ['diff','--cached','--name-only'],
    {cwd:current.root,spawnFn}
  );

  if(!staged){
    return {status:'no_changes',commit_sha:null};
  }

  const files=staged.split(/\r?\n/).filter(Boolean);
  if(files.find(sensitivePath)){
    await unstageAll(current.root,spawnFn);
    throw new Error('Sensitive path blocked from task commit');
  }

  try{
    await runGit(['commit','-m',commitMessage(task)],{cwd:current.root,spawnFn});
  }catch(e){
    await unstageAll(current.root,spawnFn);
    throw e;
  }

  const sha=await runGit(
    ['rev-parse','HEAD'],
    {cwd:current.root,spawnFn}
  );

  return {
    status:'committed',
    commit_sha:sha,
    files
  };
}

module.exports={
  runGit,
  inspectRepository,
  commitTaskChanges,
  commitMessage,
  sensitivePath
};
