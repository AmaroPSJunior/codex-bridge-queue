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
export function taskActivity(task,now=Date.now(),connection='live',limits={}){
 const attention=Number.isFinite(limits.attentionMs)&&limits.attentionMs>0?limits.attentionMs:120000;
 const stalled=Number.isFinite(limits.stalledMs)&&limits.stalledMs>=attention?limits.stalledMs:Math.max(300000,attention);
 const timestamp=Date.parse(task.last_activity_at||'');
 const age=Number.isFinite(timestamp)?Math.max(0,now-timestamp):null;
 const total=Date.parse(task.claimed_at||'');
 const count=/^\d+$/.test(String(task.activity_seq))?String(task.activity_seq):null;
 const since=age===null?'Atividade indisponível':`Último evento há ${Math.floor(age/1000)}s`;
 const base={since,count,age,total:Number.isFinite(total)?Math.max(0,now-total):null};
 if(task.status!=='running')return {...base,level:'quiet',text:'Execução encerrada',visible:false};
 if(age===null||count===null)return {...base,level:'attention',text:'Telemetria de atividade indisponível',visible:true};
 if(!['live','demo'].includes(connection))return {...base,level:'attention',text:'Conexão em recuperação; atividade não confirmada',visible:true};
 return {...base,visible:true,level:age>=stalled?'stalled':age>=attention?'attention':'normal',text:age>=stalled?'! Possível travamento — não confirma falha':age>=attention?'◷ Atenção: sem atividade recente':'● Atividade recente'};
}
