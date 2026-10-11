'use strict';
const crypto=require('node:crypto');
// Compact checkpoint only; raw output and secrets are never persisted here.
function createActivity({initial={},save=()=>{},now=Date.now}={}){
 let seq=BigInt(initial.activity_seq||0),at=initial.last_activity_at||null,max=Number(initial.activity_max_gap_ms||0);
 const seen=new Set(initial.fingerprints||[]);
 function snapshot(){return {activity_seq:String(seq),last_activity_at:at,activity_max_gap_ms:max};}
 function record(kind,value){
  if(!['output','command_end','stage'].includes(kind)||!String(value||'').trim())return false;
  if(kind==='output'&&/^(?:heartbeat|ping|pong|keepalive|still alive)(?:\s|$|:)/i.test(String(value).trim()))return false;
  const hash=crypto.createHash('sha256').update(kind+'\0'+String(value)).digest('hex');
  if(seen.has(hash)||seen.size>=10000)return false;
  seen.add(hash);const time=now();if(at)max=Math.max(max,time-Date.parse(at));at=new Date(time).toISOString();seq++;
  save({...snapshot(),fingerprints:[...seen]});return true;
 }
 return {record,snapshot};
}
module.exports={createActivity};
