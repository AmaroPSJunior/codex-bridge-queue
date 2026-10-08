// Generated from task-display.js and task-progress.js; npm run dashboard:generate

// Presentation only: UUID/task_id remains the execution and idempotency key.
function shortTitle(value, fallback='Tarefa sem título') {
  if (typeof value!=='string' || !value.trim()) return fallback;
  return Array.from(value.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,'').replace(/[\x00-\x1f\x7f\s]+/gu,' ').trim()).slice(0,80).join('') || fallback;
}
function taskNumber(value) {
  if(typeof value==='number') return Number.isSafeInteger(value)&&value>0?String(value):null;
  if(typeof value==='string' && /^[1-9][0-9]*$/.test(value))return value;
  return null;
}
function displayTask(task={},transport='supabase') {
  const number=taskNumber(transport==='github'?(task.number??task.issue):task.task_number);
  // Never infer a title from instructions: they can contain sensitive data.
  const title=shortTitle(task.title??task.task_name);
  return {number,title,label:`Tarefa ${number||'legada'} — ${title}`};
}
function markdownLabel(task,transport='supabase') {
  return displayTask(task,transport).label.replace(/[\\`*_{}\[\]()<>#!|]/g,'\\$&');
}
const STATUS_PT=Object.freeze({queued:'na fila',running:'em execução',succeeded:'concluída',failed:'falhou',cancelled:'cancelada',uncertain:'resultado incerto',duplicate:'duplicada',rejected:'rejeitada'});
function statusLabel(status){return Object.hasOwn(STATUS_PT,status)?STATUS_PT[status]:'estado desconhecido';}
function inferTitle(instruction,number=null){
  const text=typeof instruction==='string'?instruction.toLowerCase():'';
  // Classification only: never copy arbitrary instruction/result text into public names.
  if(/diagnóstico adb|adb diagnostic/.test(text))return 'Diagnóstico ADB do BYD';
  if(/live.progress|monitoramento de progresso/.test(text))return 'Monitoramento de progresso';
  if(/teste da ponte|teste de integração|test.*bridge/.test(text))return 'Teste da ponte';
  return number?'Tarefa '+number:'Nova tarefa';
}
function taskSummary(task={},transport='supabase'){
  const human=displayTask(task,transport),status=task.status??task.outcome??'unknown';
  const presentationStatus=transport==='github'?({done:'succeeded',error:'failed'}[status]||status):status;
  const status_label=statusLabel(presentationStatus);
  return {...human,task_number:human.number,task_name:human.title,status,status_label,summary:human.label+' — '+status_label};
}
export {shortTitle,taskNumber,displayTask,markdownLabel,STATUS_PT,statusLabel,inferTitle,taskSummary};

export const LIMITS={"lines":500,"bytes":524288,"intervalMs":1000,"flushLines":30,"commandEnd":true};
