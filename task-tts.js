'use strict';
const {spawn:defaultSpawn}=require('child_process');
const {displayTask,shortTitle}=require('./task-display');
const UUID=/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
function cleanSpeech(value,env={}) {
  let text=typeof value==='string'?value:'';
  // Redact known credentials before markup cleanup can transform them.
  for(const [name,secret] of Object.entries(env)) {
    if(/KEY|TOKEN|SECRET|PASSWORD/i.test(name)&&typeof secret==='string'&&secret.length>=8)text=text.split(secret).join('[credencial omitida]');
  }
  return text.replace(UUID,'').replace(/```[\s\S]*?```/g,' ').replace(/!?\[([^\]]*)\]\([^)]*\)/g,'$1')
    .replace(/https?:\/\/\S+/g,'').replace(/Bearer\s+\S+/gi,'credencial omitida')
    .replace(/\b(?:sk-|sb_secret_)[A-Za-z0-9_-]+/g,'credencial omitida')
    .replace(/[`*_~>#]/g,'').replace(/[\x00-\x1f\x7f\s]+/g,' ').trim();
}
function errorSummary(error,env={}) {
  const text=cleanSpeech(error,env);
  if(/timeout|tempo limite/i.test(text))return 'O tempo de espera terminou. O trabalho pode continuar; confira o estado antes de reenviar.';
  if(/incerto|fechado antes|uncertain/i.test(text))return 'A conexão terminou antes da confirmação. Confira o estado antes de repetir a tarefa.';
  if(/aprova|interativ/i.test(text))return 'A tarefa precisa de uma aprovação em uma sessão local.';
  if(/network|fetch|rede|websocket|conex/i.test(text))return 'Não foi possível confirmar a conclusão por uma falha de conexão.';
  // Do not read arbitrary stderr or server response bodies aloud.
  return 'Não foi possível concluir a tarefa. Consulte os detalhes do erro na resposta da ponte.';
}
function speechText(task,outcome,env={}) {
  const safeTask={...task,title:shortTitle(cleanSpeech(task?.title??task?.task_name,env))};
  const label=displayTask(safeTask,task?.transport||'supabase').label;
  const ok=outcome.status==='completed'||outcome.status==='succeeded'||outcome.status==='done';
  const header=label+' foi finalizada com '+(ok?'sucesso.':'falha.');
  const detail=ok?(cleanSpeech(outcome.answer??outcome.result,env)||'Não houve resposta textual.'):errorSummary(outcome.error,env);
  return header+'\n\n'+detail;
}
function createSpeaker({spawn=defaultSpawn,setTimeout:timer=setTimeout,clearTimeout:cancel=clearTimeout,env=process.env}={}) {
  return function speak(task,outcome) {
    const text=speechText(task,outcome,env);
    const childEnv={};
    for(const name of ['PATH','HOME','PREFIX','TMPDIR','LANG','LD_LIBRARY_PATH','LD_PRELOAD'])if(env[name])childEnv[name]=env[name];
    return new Promise(resolve=>{
      let child,deadline,done=false;
      const finish=()=>{if(done)return;done=true;if(deadline)cancel(deadline);resolve();};
      try {
        child=spawn('termux-tts-speak',['-l','pt','-n','BR'],{shell:false,stdio:['pipe','ignore','ignore'],env:childEnv});
        child.on('error',finish);child.on('close',finish);child.stdin.on('error',finish);
        deadline=timer(()=>{try{child.kill('SIGKILL');}catch{}finish();},120000);
        // The entire header+body is sent together to actual TTS stdin, never argv/logs.
        child.stdin.end(text);
      }catch{finish();}
    });
  };
}
module.exports={cleanSpeech,errorSummary,speechText,createSpeaker};
