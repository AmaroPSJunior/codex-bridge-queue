const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const http = require('http');
const {spawn} = require('child_process');
const DIR = path.join(process.env.HOME, 'codex-bridge');
const THREAD_FILE = process.env.CODEX_BRIDGE_THREAD_FILE || path.join(DIR, 'thread-id');
const JSON_MODE = process.env.CODEX_BRIDGE_JSON === '1';
const prompt = process.argv.slice(2).join(' ').trim();
const WS_URL = 'ws://127.0.0.1:8765';
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
  main().catch(e => { console.error(e.message); process.exit(1); });
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
  let nextId=1, threadId, turnId, answer='', finished=false;
  const pending = new Map();
  const timeout = setTimeout(()=>finish('Timeout; o turno pode continuar no app-server. Não reenviar automaticamente.'),180000);
  function finish(error) {
    if (finished) return;
    finished=true; clearTimeout(timeout);
    if (JSON_MODE) console.log(JSON.stringify({threadId,turnId,status:error?'failed':'completed',answer,error:error||null}));
    else if (error) console.error(error);
    else console.log('\n--- CODEX ---\n'+(answer||'(sem resposta textual)')+'\n-------------\nThread: '+threadId);
    process.exitCode=error?1:0;
    ws.close();
    setTimeout(()=>ws.terminate(),1000).unref();
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
    if (msg.method==='item/completed' && p.turnId===turnId && p.item?.type==='agentMessage') answer=p.item.text||answer;
    if (msg.method==='turn/completed' && p.turn?.id===turnId) {
      finish(p.turn.status==='completed'?null:JSON.stringify(p.turn.error||{status:p.turn.status}));
    }
  });
  ws.on('error', e=>finish('Erro WebSocket: '+e.message));
  ws.on('close',()=>{if(!finished) finish('WebSocket fechado antes da conclusão; resultado incerto.');});
  ws.on('open',async()=>{
    try {
      await rpc('initialize',{clientInfo:{name:'termux-persistent-bridge',version:'2.1.0'},capabilities:{experimentalApi:true}});
      ws.send(JSON.stringify({jsonrpc:'2.0',method:'initialized',params:{}}));
      const saved=fs.existsSync(THREAD_FILE)?fs.readFileSync(THREAD_FILE,'utf8').trim():'';
      const result=await rpc(saved?'thread/resume':'thread/start',saved?{threadId:saved}:{});
      threadId=result?.thread?.id;
      if(!threadId) throw Error('Resposta sem threadId; ponteiro preservado.');
      if(saved!==threadId) {fs.writeFileSync(THREAD_FILE+'.tmp',threadId+'\n',{mode:0o600}); fs.renameSync(THREAD_FILE+'.tmp',THREAD_FILE);}
      const turn=await rpc('turn/start',{threadId,input:[{type:'text',text:prompt}]});
      turnId=turn.turn.id;
    } catch(e) {finish(e.message);}
  });
}
