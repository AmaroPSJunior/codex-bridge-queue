export const NAV={overview:['Visão Geral','◫'],tasks:['Tarefas','☷'],history:['Histórico','◷'],settings:['Sistema','⚙']};
export const STATUS_COPY={queued:['◷','Aguardando'],running:['▶','Em execução'],succeeded:['✓','Concluída'],failed:['!','Falhou — ver motivo'],cancelled:['−','Cancelada']};
export function progressValue(task){if(task.status==='succeeded')return 100;const n=task.progress_percent;return typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=100?n:null;}
export function providerName(id){return ({codex:'Codex',groq:'Groq',antigravity:'Antigravity',claude:'Claude',local:'IA local'})[id]||'Agente não informado';}
export function providerHealth(value){return ({ready:['✓','Disponível'],quota_exceeded:['◷','Limite atingido'],auth_error:['!','Conexão precisa de atenção'],unavailable:['!','Indisponível']})[value]||['○','Sem informação recente'];}
export function stages(task){const current=task.status==='queued'?0:task.status==='running'?1:2;return ['Na fila','Em execução','Resultado'].map((label,i)=>({label,state:i<current?'done':i===current?'current':'next'}));}
export function quotaLabel(task){return typeof task.quota_remaining_percent==='number'&&task.quota_remaining_percent>=0&&task.quota_remaining_percent<=100?task.quota_remaining_percent+'% disponível':'Não informada';}
