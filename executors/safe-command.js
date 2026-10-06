'use strict';

const fs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');

const fail=(code,message)=>Object.assign(new Error(message),{kind:code});

const COMMANDS=new Set(['npm','npx','node','git']);

function validateString(value,label,max=512){
  if(typeof value!=='string'||!value||value.length>max||value.includes('\0'))
    throw fail('permission',`${label} recusado`);
  return value;
}

function validateArgs(args){
  if(!Array.isArray(args)||args.length>64)
    throw fail('permission','Argumentos recusados');

  return args.map(arg=>{
    if(typeof arg!=='string'||arg.length>1024||arg.includes('\0'))
      throw fail('permission','Argumento recusado');
    return arg;
  });
}

function relativeFile(root,value){
  validateString(value,'Caminho');

  if(path.isAbsolute(value)||value.includes('\\'))
    throw fail('permission','Caminho recusado');

  const parts=value.split('/').filter(x=>x&&x!=='.');

  for(const part of parts){
    if(
      part==='..'||
      part.startsWith('.')||
      /^(node_modules|logs|state|supabase-state|pending-results)$/i.test(part)||
      /secret|credential|token|\.env|\.pem$|\.key$/i.test(part)
    ){
      throw fail('permission','Caminho recusado');
    }
  }

  const resolved=path.resolve(root,...parts);

  if(resolved!==root&&!resolved.startsWith(root+path.sep))
    throw fail('permission','Caminho recusado');

  return resolved;
}

function rejectShellSyntax(args){
  const dangerous=/^(?:\||\|\||&&|;|>|>>|<|<<|2>|2>>|&|\$\(|`)/;

  for(const arg of args){
    if(dangerous.test(arg)||arg.includes('\n')||arg.includes('\r'))
      throw fail('permission','Sintaxe de shell recusada');
  }
}

function validateNpm(args){
  const sub=args[0];

  const allowed=new Set([
    'install',
    'uninstall',
    'remove',
    'test',
    'run',
    'ci',
    'ls',
    'list',
    'outdated',
    'audit'
  ]);

  if(!allowed.has(sub))
    throw fail('permission','Comando npm recusado');

  const forbidden=new Set([
    '-g',
    '--global',
    '--prefix',
    '--userconfig',
    '--registry',
    '--cache'
  ]);

  for(const arg of args){
    if(forbidden.has(arg)||[...forbidden].some(x=>arg.startsWith(x+'=')))
      throw fail('permission','Opção npm recusada');
  }

  if(sub==='audit'&&args.slice(1).includes('fix'))
    throw fail('permission','npm audit fix recusado');
}

function validateNpx(args){
  if(!args.length)
    throw fail('permission','npx sem ferramenta');

  for(const arg of args){
    if(
      arg==='--yes'||
      arg==='-y'||
      arg==='--package'||
      arg.startsWith('--package=')||
      arg==='--call'||
      arg.startsWith('--call=')
    ){
      throw fail('permission','Opção npx recusada');
    }
  }

  // Só executa binários já presentes no projeto.
  if(!args.includes('--no-install'))
    args.unshift('--no-install');
}

function validateNode(root,args){
  if(!args.length)
    throw fail('permission','node sem arquivo');

  const forbidden=new Set([
    '-e','--eval',
    '-p','--print',
    '-i','--interactive',
    '--inspect',
    '--inspect-brk'
  ]);

  for(const arg of args){
    if(forbidden.has(arg)||arg.startsWith('--inspect='))
      throw fail('permission','Opção node recusada');
  }

  const script=args.find(a=>!a.startsWith('-'));

  if(!script)
    throw fail('permission','Arquivo node ausente');

  const resolved=relativeFile(root,script);

  if(!fs.existsSync(resolved)||!fs.statSync(resolved).isFile())
    throw fail('permission','Arquivo node recusado');
}

function validateGit(root,args,allowCommit){
  if(!args.length)
    throw fail('permission','git sem subcomando');

  const readOnly=new Set([
    'status','diff','log','show','branch','rev-parse'
  ]);

  const writable=new Set([
    'add','commit'
  ]);

  const sub=args[0];

  if(readOnly.has(sub))
    return;

  if(allowCommit&&writable.has(sub)){
    if(sub==='add'){
      for(const arg of args.slice(1)){
        if(arg==='-A'||arg==='--all')continue;
        if(arg.startsWith('-'))throw fail('permission','Opção git add recusada');
      }
    }

    if(sub==='commit'){
      if(!args.includes('-m')&&!args.includes('--message'))
        throw fail('permission','git commit exige mensagem explícita');

      for(const arg of args){
        if(
          arg==='--amend'||
          arg==='--no-verify'||
          arg==='-a'||
          arg==='--all'
        ){
          throw fail('permission','Opção git commit recusada');
        }
      }
    }

    return;
  }

  throw fail('permission','Comando git recusado');
}

function createSafeCommandRunner({
  cwd,
  env=process.env,
  timeoutMs=120000,
  maxOutputBytes=262144,
  allowGitCommit=false
}={}){
  if(!cwd)throw TypeError('cwd obrigatório');

  const root=fs.realpathSync(cwd);

  return async function runSafeCommand({
    command,
    args=[],
    signal
  }={}){
    validateString(command,'Comando',32);

    if(!COMMANDS.has(command))
      throw fail('permission','Comando recusado');

    args=validateArgs(args);
    rejectShellSyntax(args);

    if(command==='npm')validateNpm(args);
    else if(command==='npx')validateNpx(args);
    else if(command==='node')validateNode(root,args);
    else if(command==='git')validateGit(root,args,allowGitCommit);

    const childEnv={};

    for(const key of [
      'PATH','PREFIX','TMPDIR','LANG','LC_ALL','SYSTEMROOT'
    ]){
      if(env[key])childEnv[key]=env[key];
    }

    childEnv.HOME=path.join(root,'.bridge-agent-home');
    childEnv.GIT_CONFIG_NOSYSTEM='1';
    childEnv.GIT_CONFIG_GLOBAL='/dev/null';
    childEnv.GIT_TERMINAL_PROMPT='0';
    childEnv.NPM_CONFIG_UPDATE_NOTIFIER='false';
    childEnv.NPM_CONFIG_FUND='false';
    childEnv.NPM_CONFIG_AUDIT='false';

    fs.mkdirSync(childEnv.HOME,{
      recursive:true,
      mode:0o700
    });

    return await new Promise((resolve,reject)=>{
      let text='';
      let ended=false;
      let timed=false;

      const child=spawn(command,args,{
        cwd:root,
        env:childEnv,
        shell:false,
        detached:true,
        stdio:['ignore','pipe','pipe']
      });

      const finishError=(err)=>{
        if(ended)return;
        ended=true;
        reject(err);
      };

      const stop=()=>{
        if(ended)return;

        try{process.kill(-child.pid,'SIGKILL');}catch{}

        finishError(
          fail(
            timed?'timeout':'cancelled',
            timed?'Comando excedeu o tempo limite':'Comando cancelado'
          )
        );
      };

      const timer=setTimeout(()=>{
        timed=true;
        stop();
      },timeoutMs);

      const collect=chunk=>{
        text+=chunk.toString();

        if(Buffer.byteLength(text)>maxOutputBytes){
          try{process.kill(-child.pid,'SIGKILL');}catch{}
          clearTimeout(timer);
          finishError(fail('execution','Saída do comando excedeu o limite'));
        }
      };

      child.stdout.on('data',collect);
      child.stderr.on('data',collect);

      child.on('error',()=>{
        clearTimeout(timer);
        finishError(fail('execution','Não foi possível iniciar comando'));
      });

      child.on('close',code=>{
        if(ended)return;
        ended=true;
        clearTimeout(timer);
        signal?.removeEventListener('abort',stop);

        resolve({
          code,
          output:text
        });
      });

      signal?.addEventListener('abort',stop,{once:true});

      if(signal?.aborted)stop();
    });
  };
}

module.exports={
  createSafeCommandRunner
};
