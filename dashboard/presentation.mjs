export const NAV={overview:['Visão Geral','◫'],live:['Ao vivo','●'],tasks:['Tarefas','☷'],history:['Histórico','◷'],settings:['Sistema','⚙']};
export const STATUS_COPY={queued:['◷','Aguardando'],running:['▶','Em execução'],succeeded:['✓','Concluída'],failed:['!','Falhou — ver motivo'],cancelled:['−','Cancelada']};
export function progressValue(task){if(task.status==='succeeded')return 100;const n=task.progress_percent;return typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=100?n:null;}
export function providerName(id){return ({codex:'Codex',groq:'Groq',antigravity:'Antigravity',claude:'Claude',local:'IA local'})[id]||'Agente não informado';}
export function providerHealth(value){return ({ready:['✓','Disponível'],quota_exceeded:['◷','Limite atingido'],auth_error:['!','Conexão precisa de atenção'],unavailable:['!','Indisponível']})[value]||['○','Sem informação recente'];}
export function stages(task){const current=task.status==='queued'?0:task.status==='running'?1:2;return ['Na fila','Em execução','Resultado'].map((label,i)=>({label,state:i<current?'done':i===current?'current':'next'}));}
export function quotaLabel(task){return typeof task.quota_remaining_percent==='number'&&task.quota_remaining_percent>=0&&task.quota_remaining_percent<=100?task.quota_remaining_percent+'% disponível':'Não informada';}

// Estimates use only existing sanitized stage messages, never token-consuming inference.
export function taskProgress(task){
 const terminal={succeeded:'Concluída',failed:'Execução interrompida por falha',cancelled:'Cancelada'};
 if(terminal[task.status])return {value:task.status==='succeeded'?100:null,label:terminal[task.status],estimated:false};
 if(task.status==='queued')return {value:0,label:'Aguardando início',estimated:true};
 const message=String(task.progress_message||'').toLowerCase();
 const stage=[[/finalizando|finalizing/,95,'Finalizando'],[/git push|publicando|publishing/,90,'Publicando no GitHub'],[/git commit|fazendo commit|committing/,80,'Fazendo commit'],[/executando testes|running tests|npm test|validando testes/,65,'Executando testes'],[/preparando|preparing/,10,'Preparando execução']].find(([pattern])=>pattern.test(message));
 const reported=progressValue(task);
 return {value:reported===null?(stage?.[1]??25):Math.min(99,reported),label:stage?.[2]??'Executando a tarefa',estimated:reported===null};
}
export function taskActivity(task,now=Date.now(),connection='live'){
 const timestamp=Date.parse(task.last_progress_at||task.claimed_at||'');
 const age=Number.isFinite(timestamp)?Math.max(0,Math.floor((now-timestamp)/1000)):null;
 const since=age===null?'Sem atualização confirmada':age<60?`Atualização há ${age}s`:`Atualização há ${Math.floor(age/60)} min`;
 if(task.status!=='running')return {level:'quiet',text:'○ Execução não está em andamento',since};
 if(!['live','demo'].includes(connection))return {level:'attention',text:'! Conexão em recuperação — atividade não confirmada',since};
 if(age===null)return {level:'attention',text:'! Aguardando sinal de atividade',since};
 if(age>=300)return {level:'stalled',text:'! Possível travamento — sem novidades; não confirma falha',since};
 if(age>=120)return {level:'attention',text:'◷ Sem novidades recentes — a tarefa pode continuar trabalhando',since};
 return {level:'normal',text:'● Atividade recente',since};
}

export function canDeleteTask(task,mode='live'){return mode==='live'&&task?.status!=='running';}
export function confirmTaskDeletion(confirmFn,task,mode,labelFn){
 if(!canDeleteTask(task,mode))return false;
 return !!confirmFn('Excluir '+labelFn(task)+'? Esta ação não pode ser desfeita.');
}
export function removeTaskRows(rows,id){return rows.filter(row=>row.id!==id);}
export function queuePageArgs({status='all',search='',cursor=null,limit=12}={}){
 return {p_limit:limit+1,p_status:status==='all'?null:status,p_query:search||null,p_before_created:cursor?.created_at||null,p_before_id:cursor?.id||null};
}
export function queuePageResult(rows=[],limit=12){
 const visible=rows.slice(0,limit);
 return {rows:visible,hasNext:rows.length>limit,nextCursor:visible.length?{created_at:visible.at(-1).created_at,id:visible.at(-1).id}:null};
}
export function buildReleaseState(runs=[]){
 const active=new Set(['queued','in_progress','pending','waiting','requested']);
 // Every workflow run matters, including checks started for other commits.
 const running=runs.find(r=>active.has(r.status));
 if(running)return {status:'running',sha:String(running.id||running.head_sha||'active')};
 const latest=runs.find(r=>r.status==='completed');
 if(!latest)return {status:'hidden',sha:null};
 const failed=new Set(['failure','timed_out','action_required','startup_failure','stale']);
 const sameRelease=runs.filter(r=>r.status==='completed'&&r.head_sha===latest.head_sha);
 return {status:sameRelease.some(r=>failed.has(r.conclusion))?'failed':'success',sha:String(latest.id||latest.head_sha||'completed')};
}
