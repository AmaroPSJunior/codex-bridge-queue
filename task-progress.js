'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {StringDecoder}=require('node:string_decoder');
const {performance}=require('node:perf_hooks');
const MAX_LINES=500,MAX_BYTES=512*1024,INTERVAL=60000,FLUSH_LINES=30;
const STAGES={commandUnknown:'Comando terminou; código de saída indisponível.',commandDone:'Comando concluído.',commandError:'Comando terminou com erro.',running:'Codex está executando a tarefa.',command:'Executando comando e recebendo saída.',message:'Codex está preparando a resposta.',succeeded:'Execução concluída; publicando resultado.',failed:'Execução falhou; publicando resultado.',cancelled:'Execução cancelada; publicando resultado.',shutdown:'Worker encerrando; preservando progresso.'};
function sanitizer(env={}) {
 const secrets=Object.entries(env).filter(([k,v])=>/KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIAL/i.test(k)&&typeof v==='string'&&v.length>0).map(([,v])=>v).sort((a,b)=>b.length-a.length);
 return value=>{
  let s=String(value).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'');
  for(const secret of secrets)s=s.split(secret).join('[REDACTED]');
  // Omit entire suspect lines: property dumps, headers, environment and identifiers.
  if(/authorization|proxy-authorization|cookie|bearer\s|api[_-]?key|service[_-]?role|secret|password|passwd|token|credential|private.key|BEGIN .*KEY|\b(?:imei|imsi|iccid|msisdn|vin|serialno|gpsinfo|latitude|longitude)\b|(?:[._])(?:vin|serialno|gpsinfo|bt_addr|addr)\b|https?:\/\/[^\s/]+:[^\s/]+@/i.test(s))return '[linha sensível omitida]';
  // Environment assignments can have arbitrary names, not just *_TOKEN.
  if(/^\s*(?:export\s+)?[A-Z_][A-Z0-9_]*\s*=/.test(s))return '[variável de ambiente omitida]';
  return s.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,'[REDACTED]')
   .replace(/\b(?:sk-|gsk_|sb_secret_|gh[pousr]_|github_pat_)[A-Za-z0-9_-]+/g,'[REDACTED]')
   .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,'[identificador omitido]')
   .replace(/\b(?:[0-9a-f]{2}:){5}[0-9a-f]{2}\b/gi,'[MAC omitido]')
   .replace(/\b\d{14,20}\b/g,'[identificador omitido]')
   .replace(/\b[A-HJ-NPR-Z0-9]{17}\b/g,'[identificador omitido]')
   .replace(/\b[A-Za-z0-9_+\/=-]{40,}\b/g,'[valor opaco omitido]')
   .replace(/[\x00-\x08\x0b-\x1f\x7f]/g,'');
 };
}
function createProgress({write=async()=>{},append=()=>{},env={},initialSeq=0,now=()=>performance.now(),timer=setTimeout,cancel=clearTimeout,onError=()=>{}}={}) {
 const clean=sanitizer(env),lines=[],streams=new Map();
 let pending=0,lastSuccess=now(),retryAt=0,handle,inflight,closed=false,stage='running',seq,attempt,suppressBatch=false;
 try {seq=BigInt(initialSeq||0);if(seq<0n)seq=0n;}catch{seq=0n;}
 const text=()=>lines.join('\n');
 function clear(){if(handle!==undefined){cancel(handle);handle=undefined;}}
 function arm(){
  clear();if(closed||!pending||inflight)return;
  handle=timer(()=>{handle=undefined;void flush('timeout');},Math.max(0,Math.max(lastSuccess+INTERVAL,retryAt)-now()));
  handle?.unref?.();
 }
 function line(value){
  if(closed)return;
  if(value==='Executando comando.')stage='command';
  if(value==='Codex está preparando a resposta.')stage='message';
  let safe=clean(value);
  // Single over-limit lines are omitted whole, never cut through a secret.
  if(Buffer.byteLength(JSON.stringify(safe),'utf8')>MAX_BYTES)safe='[linha excede limite; omitida]';
  try{append(safe+'\n');}catch{onError('local_log_failed');}
  lines.push(safe);
  while(lines.length>MAX_LINES||Buffer.byteLength(JSON.stringify(text()),'utf8')>MAX_BYTES)lines.shift();
  pending++;
  if(!suppressBatch&&pending>=FLUSH_LINES&&now()>=retryAt)void flush('lines');else arm();
 }
 function feed(chunk,channel='output'){
  if(closed)return;
  let state=streams.get(channel);
  if(!state){state={decoder:new StringDecoder('utf8'),partial:'',dropping:false};streams.set(channel,state);}
  consume(state,state.decoder.write(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk)));
 }
 function consume(state,value){
  for(const piece of value.split(/(?<=\n)/)){
   const ended=piece.endsWith('\n');
   if(!state.dropping){
    state.partial+=piece;
    if(Buffer.byteLength(state.partial)>MAX_BYTES){state.partial='';state.dropping=true;}
   }
   if(ended){line(state.dropping?'[linha excede limite; omitida]':state.partial.replace(/\r?\n$/,''));state.partial='';state.dropping=false;}
  }
 }
 function drain(channel){for(const [name,state] of streams){
  if(channel!==undefined&&name!==channel)continue;
  consume(state,state.decoder.end());
  if(state.partial||state.dropping)line(state.dropping?'[linha excede limite; omitida]':state.partial);
  state.partial='';state.dropping=false;
  streams.delete(name);
 }}
 function flush(reason='final'){
  if(inflight)return inflight;
  if(!pending)return Promise.resolve();
  clear();
  if(!attempt){
   const count=pending;
   attempt={count,payload:{progress_message:STAGES[stage],recent_output:text(),progress_seq:String(seq+1n),
     last_flush_reason:reason,last_flush_line_count:Math.min(count,lines.length)}};
  }
  const current=attempt;
  // Retry the exact same snapshot after ambiguity; never allocate a new sequence on failure.
  inflight=Promise.resolve().then(()=>write(current.payload)).then(ack=>{
   if(!ack?.localOnly)seq=BigInt(current.payload.progress_seq);
   pending-=current.count;attempt=undefined;lastSuccess=now();retryAt=0;
  },()=>{retryAt=now()+INTERVAL;onError('progress_publish_failed');}).finally(()=>{
   inflight=undefined;
   if(!closed&&!suppressBatch&&pending>=FLUSH_LINES&&now()>=retryAt)void flush('lines');else arm();
  });
  return inflight;
 }
 async function flushRemaining(reason){
  if(inflight)await inflight;
  const retry=attempt;
  if(pending)await flush(reason);
  // A frozen retry can precede additional lines; flush those too before finalizing.
  if(retry&&!attempt&&pending)await flush(reason);
 }
 async function commandComplete(code,channel){
  stage=code===0?'commandDone':Number.isInteger(code)?'commandError':'commandUnknown';
  suppressBatch=true;drain(channel);suppressBatch=false;
  try{append('[command exit: '+(Number.isInteger(code)?code:'unknown')+']\n');}catch{onError('local_log_failed');}
  await flushRemaining('command_end');
 }
 async function checkpoint(nextStage){stage=STAGES[nextStage]?nextStage:stage;await flushRemaining('final');}
 async function close(nextStage){
  stage=STAGES[nextStage]?nextStage:stage;suppressBatch=true;drain();closed=true;suppressBatch=false;clear();
  await flushRemaining('final');clear();
 }
 return {feed,line,flush,checkpoint,commandComplete,close,setStage:s=>{if(STAGES[s])stage=s;},snapshot:()=>({lines:[...lines],pending,lastSuccess,seq:String(seq),closed})};
}
function commandStream(progress,onDiagnostic=()=>{}){
 const decoder=new StringDecoder('utf8');let partial='',dropping=false;
 async function record(raw){
  let event;try{event=JSON.parse(raw);}catch{}
  if(event?.bridge_progress===1&&typeof event.id==='string'&&event.id.length<=256){
   const channel='command:'+event.id;
   if(event.type==='data'&&typeof event.text==='string'){progress.setStage?.('command');progress.feed(event.text,channel);return;}
   if(event.type==='end'&&(event.code===null||Number.isInteger(event.code))){await progress.commandComplete(event.code,channel);return;}
  }
  onDiagnostic(raw+'\n');
  progress.feed(raw+'\n','stderr');
 }
 async function consume(text){
  for(const piece of text.split(/(?<=\n)/)){
   const ended=piece.endsWith('\n');
   if(!dropping){partial+=piece;if(Buffer.byteLength(partial)>8*MAX_BYTES){partial='';dropping=true;}}
   if(ended){await record(dropping?'[registro de progresso excede limite; omitido]':partial.replace(/\r?\n$/,''));partial='';dropping=false;}
  }
 }
 return {write:chunk=>consume(decoder.write(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk))),end:async()=>{
  await consume(decoder.end());if(partial||dropping)await record(dropping?'[registro de progresso excede limite; omitido]':partial);partial='';dropping=false;
 }};
}
function localLog(root,id){
 const dir=path.join(root,'progress');
 fs.mkdirSync(dir,{recursive:true,mode:0o700});
 const ds=fs.lstatSync(dir);if(!ds.isDirectory()||ds.isSymbolicLink()||(ds.mode&0o777)!==0o700)throw Error('private log directory required');
 const filename=path.join(dir,crypto.createHash('sha256').update(String(id)).digest('hex')+'.log');
 const fd=fs.openSync(filename,fs.constants.O_APPEND|fs.constants.O_CREAT|fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,0o600);
 const st=fs.fstatSync(fd);if(!st.isFile()||(st.mode&0o777)!==0o600){fs.closeSync(fd);throw Error('private log required');}
 return {filename,append:s=>fs.writeSync(fd,s),close:()=>fs.closeSync(fd)};
}
module.exports={commandStream,createProgress,sanitizer,localLog,MAX_LINES,MAX_BYTES,INTERVAL};
