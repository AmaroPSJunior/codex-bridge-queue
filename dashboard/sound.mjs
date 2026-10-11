// Terminal status is authoritative. No task data is persisted in browser storage.
import {taskProgress} from './presentation.mjs';
const TERMINAL=new Set(['succeeded','failed','cancelled']);
const ACTIVE=new Set(['queued','paused','running']);
export const SOUND_PREFERENCE='bridge.dashboard.completion-sound.v1';

export function createCompletionTracker(){
 const seen=new Map();
 return {observe(rows){
  const completed=[];
  for(const row of rows){
   if(!row?.id||!TERMINAL.has(row.status)&&!ACTIVE.has(row.status))continue;
   const key=JSON.stringify([row.project_id||'',String(row.id)]),previous=seen.get(key);
   // A terminal task stays consumed, including stale reconnect/poll responses.
   if(previous?.terminal)continue;
   const seq=/^\d+$/.test(String(row.progress_seq))?BigInt(row.progress_seq):0n;
   const updated=Date.parse(row.updated_at)||0;
   if(previous&&(seq<previous.seq||seq===previous.seq&&updated<previous.updated))continue;
   const terminal=TERMINAL.has(row.status);
   seen.set(key,{terminal,seq,updated});
   // First sight of a finished task is a baseline, never a notification.
   if(terminal&&previous&&taskProgress(row).value===100)completed.push(row);
  }
  return completed;
 }};
}

export function createCompletionSound({storage,createContext,onChange=()=>{}}={}){
 const tracker=createCompletionTracker();
 let enabled=false,ready=false,context=null,activation=0;
 try{enabled=storage?.getItem(SOUND_PREFERENCE)==='on';}catch{}
 const state=()=>({enabled,ready});
 const change=()=>onChange(state());
 function preference(value){enabled=value;try{storage?.setItem(SOUND_PREFERENCE,value?'on':'off');}catch{}}
 function disable(){activation++;preference(false);ready=false;change();}
 async function enable(){
  const attempt=++activation;
  preference(true);
  try{
   // Call from a user click/key activation, never during startup or polling.
   context ||= createContext();
   await context.resume();
   if(attempt!==activation)return false;
   ready=context.state==='running';
  }catch{if(attempt===activation)ready=false;}
  if(attempt===activation)change();
  return ready&&enabled;
 }
 function play(status){
  if(!enabled||!ready)return false;
  if(context?.state!=='running'){ready=false;change();return false;}
  try{
   const notes=status==='succeeded'?[660,880]:status==='failed'?[440,330]:[440];
   for(const [i,frequency] of notes.entries()){
    const start=context.currentTime+i*.16,oscillator=context.createOscillator(),gain=context.createGain();
    oscillator.type='sine';oscillator.frequency.setValueAtTime(frequency,start);
    gain.gain.setValueAtTime(0,start);gain.gain.linearRampToValueAtTime(.12,start+.015);gain.gain.exponentialRampToValueAtTime(.001,start+.13);
    oscillator.connect(gain);gain.connect(context.destination);
    oscillator.onended=()=>{oscillator.disconnect();gain.disconnect();};
    oscillator.start(start);oscillator.stop(start+.14);
   }
   return true;
  }catch{ready=false;change();return false;}
 }
 return {state,enable,disable,observe(rows){
  // Consume before playing, including while muted/blocked. Never queue old sounds.
  const completed=tracker.observe(rows);
  for(const row of completed)play(row.status);
  return completed.length;
 }};
}
