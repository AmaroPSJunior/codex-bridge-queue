import {taskSummary,statusLabel,LIMITS} from './shared.mjs';
export {statusLabel,LIMITS};
export const STATES=['queued','paused','running','succeeded','failed','cancelled'];
export const TERMINAL=['succeeded','failed','cancelled'];
export const REASONS={lines:'Lote de linhas',timeout:'Intervalo de 60 s',command_end:'Comando finalizado',final:'Finalização'};
export function normalize(row){
 const status=STATES.includes(row.status)?row.status:'unknown';
 const human=taskSummary({...row,title:row.task_name??row.title,status});
 return {...row,...human,id:String(row.id),progress_seq:/^\d+$/.test(String(row.progress_seq))?String(row.progress_seq):'0'};
}
export function filterTasks(rows,{search='',status='all',terminal=false}={}){
 const query=search.toLocaleLowerCase('pt-BR').normalize('NFD').replace(/[\u0300-\u036f]/g,'');
 return rows.filter(r=>(status==='all'||r.status===status)&&(!terminal||TERMINAL.includes(r.status))&&(`${r.task_number||''} ${r.task_name||r.title||''}`.toLocaleLowerCase('pt-BR').normalize('NFD').replace(/[\u0300-\u036f]/g,'').includes(query)));
}
export function seconds(start,end){const a=Date.parse(start),b=Date.parse(end);return Number.isFinite(a)&&Number.isFinite(b)?Math.max(0,(b-a)/1000):null;}
export function duration(value){if(value===null||!Number.isFinite(value))return '—';if(value<60)return Math.floor(value)+' s';if(value<3600)return Math.floor(value/60)+' min '+Math.floor(value%60)+' s';return Math.floor(value/3600)+' h '+Math.floor(value%3600/60)+' min';}
export function date(value){if(!value||!Number.isFinite(Date.parse(value)))return '—';return new Intl.DateTimeFormat('pt-BR',{dateStyle:'short',timeStyle:'short'}).format(new Date(value));}
export function day(value){return value?new Date(value).toLocaleDateString('pt-BR',{day:'2-digit',month:'long',year:'numeric'}):'Data indisponível';}
export function statistics(rows){
 const counts=Object.fromEntries(STATES.map(s=>[s,0]));const waits=[],runs=[],days=new Map(),names=new Map(),buckets=[0,0,0,0];
 for(const r of rows){if(r.status in counts)counts[r.status]++;const wait=seconds(r.created_at,r.claimed_at),run=seconds(r.claimed_at,r.completed_at);if(wait!==null)waits.push(wait);if(run!==null){runs.push(run);buckets[run<60?0:run<300?1:run<900?2:3]++;}
  const key=(r.created_at||'').slice(0,10);if(key)days.set(key,(days.get(key)||0)+1);const name=r.task_name||r.title||'Sem título';names.set(name,(names.get(name)||0)+1);
 }
 const completed=counts.succeeded+counts.failed+counts.cancelled;
 return {counts,total:rows.length,completionRate:completed?counts.succeeded/completed*100:0,avgWait:waits.length?waits.reduce((a,b)=>a+b,0)/waits.length:null,avgDuration:runs.length?runs.reduce((a,b)=>a+b,0)/runs.length:null,days:[...days].sort().map(([day,count])=>({day,count})),buckets,names:[...names].sort((a,b)=>b[1]-a[1]).slice(0,6)};
}
export function hasNewProgress(previous,next){return BigInt(next?.progress_seq||0)>BigInt(previous?.progress_seq||0);}
export function mergeTask(rows,next){const row=normalize(next),old=rows.find(r=>r.id===row.id);if(old&&(BigInt(row.progress_seq)<BigInt(old.progress_seq)||(BigInt(row.progress_seq)===BigInt(old.progress_seq)&&Date.parse(row.updated_at)<Date.parse(old.updated_at))))return rows;return [row,...rows.filter(r=>r.id!==row.id)].sort((a,b)=>(b.created_at||'').localeCompare(a.created_at||'')||b.id.localeCompare(a.id));}
export function applyTaskChange(rows,payload,fresh){if(!payload?.id)return rows;if(String(payload.operation||'').toUpperCase()==='DELETE')return rows.filter(r=>r.id!==String(payload.id));return fresh?mergeTask(rows,fresh):rows;}
export function workerSignal(rows,now=Date.now()){
 const last=Math.max(0,...rows.map(r=>Date.parse(r.last_progress_at)||0));
 return last&&now-last<120000?{label:'Atividade recente',kind:'running',detail:'Inferido por progresso; não é um heartbeat.'}:{label:'Worker não confirmado',kind:'unknown',detail:'A ponte ainda não publica heartbeat. Ausência de progresso não comprova offline.'};
}
export function boundOutput(value){
 const lines=String(value||'').split('\n').slice(-LIMITS.lines),encoder=new TextEncoder();
 const sizes=lines.map(line=>encoder.encode(JSON.stringify(line)).length-2);
 let size=2+sizes.reduce((a,b)=>a+b,0)+Math.max(0,lines.length-1)*2,start=0;
 while(start<lines.length&&size>LIMITS.bytes){size-=sizes[start]+(start<lines.length-1?2:0);start++;}
 return lines.slice(start);
}
export function escape(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
export class Connection {
 constructor({refresh,timer=setTimeout,cancel=clearTimeout,onState=()=>{}}){Object.assign(this,{refresh,timer,cancel,onState});this.state='offline';this.stopped=false;}
 set(state){if(this.stopped)return;this.state=state;this.onState(state);this.cancel(this.handle);this.handle=undefined;if(state!=='live')this.handle=this.timer(async()=>{try{await this.refresh();}catch{}this.set(this.state);},60000);}
 stop(){this.stopped=true;this.cancel(this.handle);}
}
