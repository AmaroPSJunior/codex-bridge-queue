'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const PROVIDERS=Object.freeze(['codex','antigravity','local','groq','claude','auto']);
const IMPLEMENTED=Object.freeze(['codex','antigravity','local','groq']);
function fail(code){const e=new Error(code);e.code=code;throw e;}
function validateProvider(value){
  if(typeof value!=='string'||!PROVIDERS.includes(value))fail('PROVIDER_INVALID');
  return value;
}
function location(home){if(typeof home!=='string'||!path.isAbsolute(home))fail('PROVIDER_HOME_INVALID');return path.join(home,'.config','codex-bridge');}
function secureDirectory(dir){
  const s=fs.lstatSync(dir);
  if(!s.isDirectory()||s.isSymbolicLink()||(s.mode&0o777)!==0o700||s.uid!==process.getuid())fail('PROVIDER_CONFIG_UNSAFE');
}
function readDefault(home){
  const dir=location(home);
  try{secureDirectory(dir);}catch(e){if(e.code==='ENOENT')return null;throw e;}
  let fd;
  try{
    fd=fs.openSync(path.join(dir,'provider.json'),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
    const s=fs.fstatSync(fd);
    if(!s.isFile()||(s.mode&0o777)!==0o600||s.uid!==process.getuid()||s.size>1024)fail('PROVIDER_CONFIG_UNSAFE');
    let data;try{data=JSON.parse(fs.readFileSync(fd,'utf8'));}catch{fail('PROVIDER_CONFIG_INVALID');}
    if(!data||Array.isArray(data)||Object.keys(data).sort().join(',')!=='default_provider,version'||data.version!==1)fail('PROVIDER_CONFIG_INVALID');
    return validateProvider(data.default_provider);
  }catch(e){if(e.code==='ENOENT')return null;throw e;}
  finally{if(fd!==undefined)fs.closeSync(fd);}
}
function writeDefault(home,value){
  validateProvider(value);
  const dir=location(home);
  fs.mkdirSync(path.dirname(dir),{recursive:true,mode:0o700});
  try{fs.mkdirSync(dir,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}
  secureDirectory(dir);
  // Reject existing unsafe files rather than overwriting them silently.
  readDefault(home);
  const tmp=path.join(dir,'.provider-'+crypto.randomBytes(12).toString('hex'));
  let fd;
  try{
    fd=fs.openSync(tmp,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,0o600);
    fs.writeFileSync(fd,JSON.stringify({version:1,default_provider:value})+'\n');fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
    fs.renameSync(tmp,path.join(dir,'provider.json'));
  }finally{if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(tmp);}catch(e){if(e.code!=='ENOENT')throw e;}}
}
function selectProvider({task={},env=process.env,home=env.HOME}={}){
  if(Object.prototype.hasOwnProperty.call(task,'requested_provider')&&task.requested_provider!==null&&task.requested_provider!==undefined)
    return {provider:validateProvider(task.requested_provider),source:'task'};
  if(Object.prototype.hasOwnProperty.call(task,'ai_provider')&&task.ai_provider!==null&&task.ai_provider!==undefined)
    return {provider:validateProvider(task.ai_provider),source:'task'};
  if(Object.prototype.hasOwnProperty.call(env,'AI_PROVIDER'))return {provider:validateProvider(env.AI_PROVIDER),source:'environment'};
  const saved=readDefault(home);
  return {provider:saved||'codex',source:saved?'config':'default'};
}
function requireImplemented(selection){
  if(!IMPLEMENTED.includes(selection.provider))fail(selection.provider==='auto'?'PROVIDER_AUTO_DISABLED':'PROVIDER_NOT_IMPLEMENTED');
  return selection;
}
module.exports={PROVIDERS,IMPLEMENTED,validateProvider,readDefault,writeDefault,selectProvider,requireImplemented};
