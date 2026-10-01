'use strict';
const fs=require('fs'), path=require('path'), crypto=require('crypto');
const {spawn}=require('child_process');
const {shortTitle,markdownLabel,taskSummary}=require('./task-display');
const DIR=__dirname, STATE=path.join(DIR,'remote-state');
const config=JSON.parse(fs.readFileSync(path.join(DIR,'remote-config.json')));
const repo=config.repository, base='repos/'+repo;
fs.mkdirSync(STATE,{recursive:true,mode:0o700});
process.umask(0o077);
function log(event,data={}) { console.log(JSON.stringify({at:new Date().toISOString(),event,...data})); }
function save(s) {
  s.updatedAt=new Date().toISOString();
  const file=path.join(STATE,s.issue+'.json'), tmp=file+'.tmp';
  const fd=fs.openSync(tmp,'w',0o600);
  try {fs.writeFileSync(fd,JSON.stringify(s,null,2)+'\n'); fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
  fs.renameSync(tmp,file);
  const d=fs.openSync(STATE,'r'); try {fs.fsyncSync(d);} finally {fs.closeSync(d);}
}
function records(){return fs.readdirSync(STATE).filter(f=>/^\d+\.json$/.test(f)).map(f=>JSON.parse(fs.readFileSync(path.join(STATE,f))));}
function run(command,args,input,options={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{shell:false,stdio:['pipe','pipe','pipe'],...options});
    let stdout='',stderr='';
    const timer=setTimeout(()=>child.kill('SIGTERM'),30000);
    child.stdin.on('error',()=>{});
    child.stdout.on('data',d=>stdout+=d); child.stderr.on('data',d=>stderr+=d);
    child.on('error',e=>{clearTimeout(timer);reject(e);});
    child.on('close',code=>{clearTimeout(timer);code===0?resolve(stdout):reject(Error(command+' exit '+code+': '+stderr.slice(-1500)));});
    child.stdin.end(input);
  });
}
async function api(endpoint,method='GET',body) {
  const args=['api','--hostname','github.com',endpoint,'--method',method];
  if(body!==undefined) args.push('--input','-');
  const result=await run('gh',args,body===undefined?undefined:JSON.stringify(body));
  return result.trim()?JSON.parse(result):null;
}
async function pages(endpoint) {
  const rows=[];
  for(let page=1;;page++) {
    const batch=await api(endpoint+(endpoint.includes('?')?'&':'?')+'per_page=100&page='+page);
    rows.push(...batch); if(batch.length<100) return rows;
  }
}
async function comments(issue){return pages(base+'/issues/'+issue+'/comments');}
async function commentOnce(s,marker,body) {
  const existing=await comments(s.issue);
  if(!existing.some(c=>c.user.login.toLowerCase()===config.allowedAuthors[0].toLowerCase() && c.body.includes(marker))) {
    await api(base+'/issues/'+s.issue+'/comments','POST',{body:marker+'\n'+body});
  }
}
const statuses=['queued','running','done','error','uncertain','duplicate','rejected'];
async function setStatus(s,status,close=false) {
  // This repository is dedicated to the queue; preserve unrelated labels.
  const issue=await api(base+'/issues/'+s.issue);
  const labels=issue.labels.map(l=>l.name).filter(n=>!statuses.some(st=>n==='codex:'+st));
  await api(base+'/issues/'+s.issue,'PATCH',{labels:[...labels,'codex:'+status],...(close?{state:'closed'}:{})});
}
function parseTask(body) {
  const v=JSON.parse(body);
  if(v.protocol!=='codex-bridge/v1' || typeof v.task_id!=='string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{7,99}$/.test(v.task_id)) throw Error('protocol ou task_id inválido');
  if(typeof v.prompt!=='string' || !v.prompt.trim() || v.prompt.includes('\0') || Buffer.byteLength(v.prompt)>config.maxPromptBytes) throw Error('prompt vazio, NUL ou tamanho excedido');
  return v;
}
async function execute(s) {
  await commentOnce(s,'<!-- codex-bridge:claim:'+s.taskId+' -->',markdownLabel(s,'github')+'. Recebida. ID técnico: `'+s.taskId+'`. Execução única neste Termux.');
  await setStatus(s,'running');
  // Write-ahead execution fence. Recovery never reruns a task past this point.
  s.status='executing'; s.executions=1; s.startedAt=new Date().toISOString(); save(s);
  log('execution_start',{issue:s.issue,taskId:s.taskId});
  const stdoutFile=path.join(STATE,s.issue+'.stdout'),stderrFile=path.join(STATE,s.issue+'.stderr');
  const out=fs.openSync(stdoutFile,'w',0o600), err=fs.openSync(stderrFile,'w',0o600);
  const result=await new Promise(resolve=>{
    const child=spawn(path.join(process.env.PREFIX||'/data/data/com.termux/files/usr','bin/codex-bridge'),[s.prompt],{
      shell:false,stdio:['ignore',out,err],env:{...process.env,CODEX_BRIDGE_JSON:'1',CODEX_BRIDGE_TASK_TRANSPORT:'github',CODEX_BRIDGE_TASK_NUMBER:String(s.issue),CODEX_BRIDGE_TASK_TITLE:shortTitle(s.title),CODEX_BRIDGE_THREAD_FILE:path.join(DIR,'remote-thread-id')}
    });
    fs.closeSync(out);fs.closeSync(err);
    s.childPid=child.pid; save(s);
    child.on('error',e=>resolve({code:1,error:e.message}));
    child.on('close',code=>resolve({code}));
  });
  const stdout=fs.readFileSync(stdoutFile,'utf8'),stderr=fs.readFileSync(stderrFile,'utf8');
  let response; try {response=JSON.parse(stdout.trim());} catch {}
  s.status='publishing';
  s.outcome=result.code===0 && response?.status==='completed'?'done':'uncertain';
  s.result=response?.answer || stdout || '(sem resposta textual)';
  s.error=response?.error || result.error || stderr || null;
  s.threadId=response?.threadId; s.turnId=response?.turnId;
  s.finishedAt=new Date().toISOString();save(s);
  log('execution_finish',{issue:s.issue,outcome:s.outcome});
}
async function publish(s) {
  const text=s.result+(s.error?'\n\nErro: '+s.error:'');
  const chunks=Array.from(text.matchAll(/[\s\S]{1,16000}/gu),m=>m[0]);
  if(!chunks.length)chunks.push('(sem resposta)');
  for(let i=0;i<chunks.length;i++) {
    await commentOnce(s,'<!-- codex-bridge:result:'+s.taskId+':'+(i+1)+'/'+chunks.length+' -->',
      markdownLabel(s,'github')+' — '+taskSummary({...s,status:s.outcome},'github').status_label+' · parte '+(i+1)+'/'+chunks.length+'\n\n'+chunks[i]);
  }
  await setStatus(s,s.outcome,s.outcome==='done'||s.outcome==='duplicate'||s.outcome==='rejected');
  s.status=s.outcome; s.publishedAt=new Date().toISOString();save(s);
  log('published',{issue:s.issue,status:s.status});
}
async function accept(issue) {
  if(issue.pull_request)return;
  const file=path.join(STATE,issue.number+'.json');
  if(fs.existsSync(file)) {
    const s=JSON.parse(fs.readFileSync(file));
    if(!['claimed','executing','publishing'].includes(s.status)) await setStatus(s,s.status,['done','duplicate','rejected'].includes(s.status));
    return;
  }
  // Author restriction is in addition to the repository being private.
  if(!config.allowedAuthors.some(a=>a.toLowerCase()===issue.user.login.toLowerCase())) {log('unauthorized',{issue:issue.number});return;}
  let task;
  try {task=parseTask(issue.body);} catch(e) {
    const s={issue:issue.number,taskId:'invalid-'+issue.number,status:'publishing',outcome:'rejected',executions:0,result:e.message};save(s);await publish(s);return;
  }
  const s={issue:issue.number,title:shortTitle(task.title,shortTitle(issue.title)),githubId:issue.id,taskId:task.task_id,prompt:task.prompt,promptSha256:crypto.createHash('sha256').update(task.prompt).digest('hex'),status:'claimed',executions:0};
  const previous=records().find(r=>r.taskId===s.taskId);
  if(previous) {
    Object.assign(s,{status:'publishing',outcome:'duplicate',result:'task_id já registrado na issue #'+previous.issue+'. Consulte a issue original. O prompt não foi executado novamente.'});
  } else {
    // A server-side claim surviving local state loss is never blindly replayed.
    const cs=await comments(s.issue);
    if(cs.some(c=>c.body.includes('<!-- codex-bridge:claim:')||c.body.includes('<!-- codex-bridge:result:'))) {
      Object.assign(s,{status:'publishing',outcome:'uncertain',result:'Registro remoto anterior encontrado sem estado local. Execução automática bloqueada para evitar duplicidade.'});
    }
  }
  save(s);
  if(s.status==='claimed')await execute(s);
  if(s.status==='publishing')await publish(s);
}
let stopping=false,wake;
process.on('SIGTERM',()=>{stopping=true;if(wake)wake();log('stop_requested');});
process.on('SIGINT',()=>{stopping=true;if(wake)wake();});
async function main() {
  if(process.env.CODEX_QUEUE_LOCKED!=='1')throw Error('Use ./remote start (lock obrigatório).');
  fs.writeFileSync(path.join(DIR,'remote.pid'),String(process.pid)+'\n');
  for(const s of records()) if(s.status==='executing') {
    s.status='publishing';s.outcome='uncertain';s.result='Worker interrompido após registrar o início. Não houve reexecução automática. Inspecione os arquivos locais '+s.issue+'.stdout/.stderr e o turno antes de enviar nova tarefa.';save(s);
  }
  log('started',{pid:process.pid,repository:repo});
  let failures=0;
  while(!stopping) {
    try {
      const metadata=await api(base);
      if(!metadata.private || !metadata.has_issues)throw Error('Repositório deve ser privado e ter Issues habilitado.');
      for(const s of records()) {
        if(stopping)break;
        if(s.status==='claimed')await execute(s);
        if(s.status==='publishing')await publish(s);
      }
      if(!stopping) {
        const issues=await pages(base+'/issues?state=open&labels=codex%3Aqueued&sort=created&direction=asc');
        for(const issue of issues){if(stopping)break;await accept(issue);}
      }
      failures=0;
      fs.writeFileSync(path.join(DIR,'remote-heartbeat.json'),JSON.stringify({at:new Date().toISOString(),pid:process.pid,status:'polling'}));
    } catch(e) {failures++;log('poll_error',{error:e.message,retrySeconds:Math.min(300,config.pollSeconds*2**Math.min(failures,5))});}
    if(!stopping)await new Promise(resolve=>{const timer=setTimeout(resolve,Math.min(300,config.pollSeconds*2**Math.min(failures,5))*1000);wake=()=>{clearTimeout(timer);resolve();};});
  }
  log('stopped');
}
if(require.main===module)main().catch(e=>{log('fatal',{error:e.message});process.exitCode=1;}).finally(()=>{try{if(fs.readFileSync(path.join(DIR,'remote.pid'),'utf8').trim()===String(process.pid))fs.unlinkSync(path.join(DIR,'remote.pid'));}catch{}});
module.exports={parseTask};
