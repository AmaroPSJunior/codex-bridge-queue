const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const http = require('http');
const {spawn} = require('child_process');
const {createSpeaker} = require('./task-tts');
const speak = createSpeaker({spawn,setTimeout,clearTimeout,env:process.env});
const DIR = path.join(process.env.HOME, 'codex-bridge');
const THREAD_FILE = process.env.CODEX_BRIDGE_THREAD_FILE || path.join(DIR, 'thread-id');
const JSON_MODE = process.env.CODEX_BRIDGE_JSON === '1';
const TTS_ENABLED = process.env.CODEX_BRIDGE_TTS !== '0' && (JSON_MODE || process.env.CODEX_BRIDGE_TTS === '1');
const SPEECH_TASK = {transport:process.env.CODEX_BRIDGE_TASK_TRANSPORT||'supabase',
  task_number:process.env.CODEX_BRIDGE_TASK_NUMBER,number:process.env.CODEX_BRIDGE_TASK_NUMBER,
  title:process.env.CODEX_BRIDGE_TASK_TITLE};
// Override only this bridge conversation; preserve the global notify hook.
const SPEECH_CONFIG = TTS_ENABLED ? {config:{notify:[]}} : {};
// Invalid, zero or overflowing values use a safe default (Node timers are int32).
const DEFAULT_TIMEOUT_MS = 900000;
const timeoutSetting = process.env.CODEX_BRIDGE_TIMEOUT_MS || '';
const timeoutNumber = Number(timeoutSetting);
const TIMEOUT_MS = /^\d+$/.test(timeoutSetting) && Number.isSafeInteger(timeoutNumber) && timeoutNumber > 0 && timeoutNumber <= 2147483647
  ? timeoutNumber : DEFAULT_TIMEOUT_MS;
const prompt = process.argv.slice(2).join(' ').trim();
const WS_URL = 'ws://127.0.0.1:8765';
// Operator-selected profile, resolved and enforced by app-server. No automatic grant.
// Named profiles and legacy sandbox fields are mutually exclusive in protocol 0.156.1.
const PERMISSIONS_PROFILE = process.env.CODEX_BRIDGE_PERMISSIONS_PROFILE || '';
function permissionParams(turn=false) {
  if (PERMISSIONS_PROFILE) {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(PERMISSIONS_PROFILE))
      throw Error('CODEX_BRIDGE_PERMISSIONS_PROFILE deve ser um nome de perfil definido pelo operador.');
    return {approvalPolicy:'never',permissions:PERMISSIONS_PROFILE};
  }
  return turn
    ? {approvalPolicy:'never',sandboxPolicy:{type:'workspaceWrite',writableRoots:["/data/data/com.termux/files/home/.config/codex-bridge","/data/data/com.termux/files/home/.bashrc"]}}
    : {approvalPolicy:'never',sandbox:'workspace-write'};
}

if (!prompt) { console.error('Uso: codex-bridge "sua instrução"'); process.exit(1); }
fs.mkdirSync(path.join(DIR, 'logs'), {recursive:true});
// flock serializes callers of the same thread, including the existing local worker.
if (process.env.CODEX_BRIDGE_LOCKED !== THREAD_FILE) {
  const child = spawn('flock', ['-x', THREAD_FILE + '.lock', process.execPath, __filename, ...process.argv.slice(2)], {
    stdio:'inherit', env:{...process.env, CODEX_BRIDGE_LOCKED:THREAD_FILE}
  });
  child.on('error', e => { console.error(e.message); process.exit(1); });
  child.on('exit', (code) => process.exit(code ?? 1));
} else {
  main().catch(async e => {
    console.error(e.message);
    if (TTS_ENABLED) await speak(SPEECH_TASK,{status:'failed',error:e.message});
    process.exitCode=1;
  });
}
function ready() {
  return new Promise(resolve => {
    const req = http.get('http://127.0.0.1:8765/readyz', res => {res.resume(); resolve(res.statusCode===200);});
    req.on('error', () => resolve(false));
    req.setTimeout(1000, () => {req.destroy(); resolve(false);});
  });
}
async function main() {
  if (!await ready()) {
    const out = fs.openSync(path.join(DIR, 'logs/app-server.log'), 'a', 0o600);
    const child = spawn('codex', ['app-server', '--listen', WS_URL], {detached:true, stdio:['ignore',out,out]});
    child.on('error', e => {console.error(e.message); process.exit(1);});
    child.unref(); fs.closeSync(out);
    fs.writeFileSync(path.join(DIR, 'app-server.pid'), String(child.pid));
    for (let i=0;i<20 && !await ready();i++) await new Promise(r=>setTimeout(r,500));
    if (!await ready()) throw Error('O app-server não ficou pronto.');
  }
  const ws = new WebSocket(WS_URL);
  let nextId=1, threadId, turnId, answer='', finished=false, socketClosed=false, closeTimer;
  const pending = new Map();
  const commandOffsets=new Map();
  const progressEvent=event=>{
    if(process.stderr.write(JSON.stringify({bridge_progress:1,...event})+'\n')===false){
      ws.pause?.();process.stderr.once('drain',()=>ws.resume?.());
    }
  };
  const timeout = setTimeout(()=>finish('Timeout após '+TIMEOUT_MS+' ms; o turno pode continuar no app-server. Não reenviar automaticamente. Consulte o estado antes de tentar novamente.'),TIMEOUT_MS);
  function finish(error) {
    if (finished) return;
    finished=true; clearTimeout(timeout);
    if (JSON_MODE) console.log(JSON.stringify({threadId,turnId,status:error?'failed':'completed',answer,error:error||null}));
    else if (error) console.error(error);
    else console.log('\n--- CODEX ---\n'+(answer||'(sem resposta textual)')+'\n-------------\nThread: '+threadId);
    if (TTS_ENABLED) void speak(SPEECH_TASK,{status:error?'failed':'completed',answer,error});
    process.exitCode=error?1:0;
    ws.close();
    if (!socketClosed) closeTimer=setTimeout(()=>{closeTimer=undefined;ws.terminate();},1000).unref();
  }
  function rpc(method,params={}) {
    return new Promise((resolve,reject)=>{const id=nextId++; pending.set(id,{resolve,reject}); ws.send(JSON.stringify({jsonrpc:'2.0',id,method,params}));});
  }
  ws.on('message',raw=>{
    let msg; try {msg=JSON.parse(raw);} catch {return;}
    if (msg.id != null && pending.has(msg.id)) {
      const p=pending.get(msg.id); pending.delete(msg.id);
      if(msg.error) p.reject(Error(JSON.stringify(msg.error))); else p.resolve(msg.result);
      return;
    }
    if (msg.id != null && msg.method) {
      // A headless caller cannot answer interactive approvals. Never silently approve.
      ws.send(JSON.stringify({jsonrpc:'2.0',id:msg.id,error:{code:-32000,message:'Ponte sem interação: aprovação requer sessão local.'}}));
      finish('Solicitação interativa: '+msg.method+'. Resolva em uma sessão local.'); return;
    }
    const p=msg.params;
    if (!p || p.threadId!==threadId || !turnId) return;
    // Opt-in stderr only: preserve stdout JSON and suppress unrelated turns.
    if (!finished && process.env.CODEX_BRIDGE_PROGRESS==='1' && p.turnId===turnId) {
      if(msg.method==='item/commandExecution/outputDelta' && typeof p.delta==='string') {
        const id=String(p.itemId||'command');
        commandOffsets.set(id,(commandOffsets.get(id)||0)+p.delta.length);
        progressEvent({type:'data',id,text:p.delta});
      }
      if(msg.method==='item/completed' && p.item?.type==='commandExecution') {
        const id=String(p.item.id||'command'),offset=commandOffsets.get(id)||0;
        const output=typeof p.item.aggregatedOutput==='string'?p.item.aggregatedOutput:'';
        if(output.length>offset)progressEvent({type:'data',id,text:output.slice(offset)});
        progressEvent({type:'end',id,code:Number.isInteger(p.item.exitCode)?p.item.exitCode:null});
        commandOffsets.delete(id);
      }
      if(msg.method==='item/completed' && p.item?.type==='agentMessage') console.error('Codex está preparando a resposta.');
    }
    if (msg.method==='item/completed' && p.turnId===turnId && p.item?.type==='agentMessage') answer=p.item.text||answer;
    if (msg.method==='turn/completed' && p.turn?.id===turnId) {
      finish(p.turn.status==='completed'?null:JSON.stringify(p.turn.error||{status:p.turn.status}));
    }
  });
  ws.on('error', e=>finish('Erro WebSocket: '+e.message));
  ws.on('close',()=>{socketClosed=true;if(closeTimer){clearTimeout(closeTimer);closeTimer=undefined;}if(!finished) finish('WebSocket fechado antes da conclusão; resultado incerto.');});
  ws.on('open',async()=>{
    try {
      await rpc('initialize',{clientInfo:{name:'termux-persistent-bridge',version:'2.1.0'},capabilities:{experimentalApi:true}});
      ws.send(JSON.stringify({jsonrpc:'2.0',method:'initialized',params:{}}));
      const saved=fs.existsSync(THREAD_FILE)?fs.readFileSync(THREAD_FILE,'utf8').trim():'';
      const result=await rpc(saved?'thread/resume':'thread/start',{...(saved?{threadId:saved}:{}),...permissionParams(),...SPEECH_CONFIG});
      threadId=result?.thread?.id;
      if(!threadId) throw Error('Resposta sem threadId; ponteiro preservado.');
      if(saved!==threadId) {fs.writeFileSync(THREAD_FILE+'.tmp',threadId+'\n',{mode:0o600}); fs.renameSync(THREAD_FILE+'.tmp',THREAD_FILE);}
      const turn=await rpc('turn/start',{threadId,...permissionParams(true),input:[{type:'text',text:prompt}]});
      turnId=turn.turn.id;
    } catch(e) {finish(e.message);}
  });
}
