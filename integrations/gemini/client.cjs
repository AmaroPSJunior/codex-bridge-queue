'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {shortTitle,displayTask,inferTitle,taskSummary}=require('../../task-display');
const {sanitizer}=require('../../task-progress');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const STATUSES=['queued','running','succeeded','failed','cancelled','uncertain','duplicate'];
class BridgeError extends Error {
 constructor(code,message,identifier){super(message);this.code=code;this.identifier=identifier;}
}
function validate(args,allowed){
 if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!allowed.includes(k)))throw new BridgeError('invalid_input','Argumentos inválidos.');
}
function loadLocal(root,home=os.homedir()){
 const dir=path.join(home,'.config/codex-bridge'),secret=path.join(dir,'supabase-service-role.key');
 const d=fs.lstatSync(dir);
 if(!d.isDirectory()||d.isSymbolicLink()||(d.mode&0o777)!==0o700||d.uid!==process.getuid())throw Error('private configuration');
 const fd=fs.openSync(secret,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 let key;
 try {const s=fs.fstatSync(fd);if(!s.isFile()||(s.mode&0o777)!==0o600||s.uid!==process.getuid())throw Error('private credential');key=fs.readFileSync(fd,'utf8');}finally{fs.closeSync(fd);}
 if(!key.trim())throw Error('missing credential');
 const config=JSON.parse(fs.readFileSync(path.join(root,'remote-config.json'),'utf8'));
 const url=new URL(config.supabase.url);
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||!['','/'].includes(url.pathname))throw Error('invalid service URL');
 const titles=path.join(dir,'gemini-titles');
 function titlePath(id){if(!UUID.test(id))throw Error('invalid id');return path.join(titles,id+'.json');}
 const legacy={
  get(id){try{const p=titlePath(id);const fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{return JSON.parse(fs.readFileSync(fd,'utf8')).title;}finally{fs.closeSync(fd);}}catch{return undefined;}},
  set(id,title){
   if(!fs.existsSync(titles))fs.mkdirSync(titles,{mode:0o700});
   const s=fs.lstatSync(titles);if(!s.isDirectory()||s.isSymbolicLink()||(s.mode&0o777)!==0o700)throw Error('private metadata');
   const p=titlePath(id);
   try{const fd=fs.openSync(p,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);try{fs.writeFileSync(fd,JSON.stringify({title}));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
   catch(e){if(e.code!=='EEXIST'||legacy.get(id)!==title)throw e;}
  }
 };
 return {url:url.origin,key,legacy,maxPromptBytes:Math.min(24000,Number(config.maxPromptBytes)||24000)};
}
function createClient({url,key,legacy={get(){},set(){}},maxPromptBytes=24000,fetch:fetcher=globalThis.fetch,newId=crypto.randomUUID}){
 let humanFields;
 function redact(s){return typeof s==='string'?s.split(key).join('[credencial omitida]'):s;}
 async function request(route,method='GET',body){
  let r;
  try {r=await fetcher(url+'/rest/v1/'+route,{method,redirect:'error',signal:AbortSignal.timeout(20000),headers:{apikey:key,Authorization:'Bearer '+key,'Content-Type':'application/json',Prefer:'return=representation'},body:body===undefined?undefined:JSON.stringify(body)});}
  catch {throw new BridgeError('network','Falha de comunicação. Não repita uma criação sem consultar o recibo.');}
  if(!r.ok){let code;try{code=(await r.json()).code;}catch{}
   const e=new BridgeError('upstream','Não foi possível acessar a fila. Confira a configuração local.');e.httpStatus=r.status;e.upstreamCode=code;throw e;
  }
  try{return await r.json();}catch{throw new BridgeError('response','Resposta inválida da fila.');}
 }
 async function supportsHumanFields(){
  if(humanFields===undefined){
   try{await request('bridge_tasks?select=task_number,title&limit=0');humanFields=true;}
   catch(e){if(e.httpStatus===400&&['42703','PGRST204'].includes(e.upstreamCode))humanFields=false;else throw e;}
  }
  return humanFields;
 }
 function view(row,details=true){
  if(!row||!UUID.test(row.id))throw new BridgeError('response','Resposta inválida da fila.');
  const human=displayTask({...row,title:redact(row.title||legacy.get(row.id))});
  const presented=taskSummary({...row,title:human.title});
  const out={id:row.id,task_name:human.title,status_label:presented.status_label,summary:presented.summary,identifier:human.number||row.id,label:human.label,title:human.title,task_number:human.number,status:STATUSES.includes(row.status)?row.status:'unknown',created_at:typeof row.created_at==='string'?redact(row.created_at):null};
  if(details){
   const result=redact(typeof row.result==='string'?row.result:null),error=redact(typeof row.error==='string'?row.error:null);
   out.result=result?.slice(0,64000)??null;out.error=error?.slice(0,8000)??null;
   out.truncated=Boolean(result?.length>64000||error?.length>8000);
   if(Object.prototype.hasOwnProperty.call(row,'progress_seq')){
    const clean=sanitizer({SERVICE_KEY:key});
    const output=typeof row.recent_output==='string'?row.recent_output.split(/\r?\n/).map(clean).join('\n'):null;
    out.progress_message=typeof row.progress_message==='string'?clean(row.progress_message).slice(0,240):null;
    out.recent_output=output?.slice(0,64000)??null;
    out.last_progress_at=typeof row.last_progress_at==='string'&&/^\d{4}-\d{2}-\d{2}T[0-9:.+Z-]+$/.test(row.last_progress_at)?row.last_progress_at:null;
    out.last_flush_reason=['lines','timeout','command_end','final'].includes(row.last_flush_reason)?row.last_flush_reason:null;
    out.last_flush_line_count=Number.isInteger(row.last_flush_line_count)&&row.last_flush_line_count>0&&row.last_flush_line_count<=500?row.last_flush_line_count:null;
    out.progress_seq=/^\d+$/.test(String(row.progress_seq))?String(row.progress_seq):null;
    out.progress_truncated=Boolean(output?.length>64000);
   }
  }
  return out;
 }
 async function get(args){
  validate(args,['identifier']);let id=args.identifier;
  if(typeof id==='number'&&Number.isSafeInteger(id)&&id>0)id=String(id);
  if(typeof id!=='string')throw new BridgeError('invalid_input','Informe o número da tarefa ou o recibo técnico.');
  const label=id.match(/^Tarefa ([1-9][0-9]*)\s*(?:—.*)?$/);if(label)id=label[1];
  let filter;
  if(/^[1-9][0-9]{0,18}$/.test(id)&&BigInt(id)<=9223372036854775807n){
   if(!await supportsHumanFields())throw new BridgeError('legacy','Esta fila ainda usa recibos técnicos. Consulte pelo identificador recebido.');
   filter='task_number=eq.'+id;
  }else if(UUID.test(id))filter='id=eq.'+encodeURIComponent(id);
  else throw new BridgeError('invalid_input','Identificador inválido.');
  const rows=await request('bridge_tasks?'+filter+'&select=*&limit=1');
  if(!Array.isArray(rows)||!rows.length)throw new BridgeError('not_found','Tarefa não encontrada.');
  return view(rows[0]);
 }
 async function list(args={}){
  validate(args,['status','limit']);const limit=args.limit??10;
  if(!Number.isInteger(limit)||limit<1||limit>50||args.status!==undefined&&!STATUSES.includes(args.status))throw new BridgeError('invalid_input','Use um estado válido e limite entre 1 e 50.');
  const human=await supportsHumanFields();
  const select='id,status,created_at'+(human?',task_number,title':'');
  const rows=await request('bridge_tasks?select='+select+'&order=created_at.desc,id.desc&limit='+limit+(args.status?'&status=eq.'+args.status:''));
  if(!Array.isArray(rows))throw new BridgeError('response','Resposta inválida da fila.');
  return {tasks:rows.map(r=>view(r,false)),limit};
 }
 async function create(args){
  validate(args,['title','task_name','instruction','request_id']);
  if(args.title!==undefined&&args.task_name!==undefined&&args.title!==args.task_name)throw new BridgeError('invalid_input','Use um único nome para a tarefa.');
  const requestedTitle=args.title??args.task_name;
  if(requestedTitle!==undefined&&(typeof requestedTitle!=='string'||!requestedTitle.trim()||Array.from(requestedTitle).length>80||requestedTitle.includes('\0'))||typeof args.instruction!=='string'||!args.instruction.trim()||args.instruction.includes('\0')||Buffer.byteLength(args.instruction)>maxPromptBytes)throw new BridgeError('invalid_input','Informe título de até 80 caracteres e instrução válida dentro do limite da fila.');
  if(args.request_id!==undefined&&(typeof args.request_id!=='string'||!UUID.test(args.request_id)))throw new BridgeError('invalid_input','Recibo técnico inválido.');
  const human=await supportsHumanFields(),id=args.request_id||newId(),title=shortTitle(requestedTitle,inferTitle(args.instruction));
  const body={id,instruction:args.instruction,status:'queued',...(human?{title}:{})};
  if(!human)legacy.set(id,title);
  try {
   const rows=await request('bridge_tasks','POST',body);
   if(!Array.isArray(rows)||rows.length!==1||rows[0].id!==id)throw new BridgeError('response','Resposta inválida da criação.');
   return {...view(rows[0]),legacy_schema:!human};
  }catch(e){
   if(e.httpStatus===409){
    let rows;try{rows=await request('bridge_tasks?id=eq.'+encodeURIComponent(id)+'&select=*&limit=1');}catch{throw new BridgeError('uncertain','Recibo existente; consulta indisponível. Consulte novamente antes de criar.',id);}
    if(rows?.[0]?.instruction===args.instruction&&shortTitle(rows[0].title||legacy.get(id))===title)return {...view(rows[0]),already_exists:true};
    throw new BridgeError('conflict','Recibo já usado por outra tarefa.',id);
   }
   if(e.httpStatus>=400&&e.httpStatus<500)throw new BridgeError('rejected','A fila recusou a criação. Confira configuração e permissões locais.',id);
   throw new BridgeError('uncertain','A criação pode ter ocorrido. Consulte este recibo antes de tentar novamente.',id);
  }
 }
 return {create,get,list};
}
module.exports={loadLocal,createClient,BridgeError};
