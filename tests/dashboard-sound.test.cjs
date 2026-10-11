'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const load=()=>import('../dashboard/sound.mjs');
const row=(status,extra={})=>({id:'task',project_id:'project',status,progress_seq:'1',updated_at:'2026-10-11T12:00:00Z',...extra});
function audio(){
 const store=new Map(),notes=[],changes=[];
 let resumes=0,created=0,fail=false;
 const context={state:'suspended',currentTime:0,destination:{},async resume(){resumes++;if(fail)throw Error('autoplay denied');this.state='running';},createOscillator(){return {frequency:{setValueAtTime:f=>notes.push(f)},connect(){},disconnect(){},start(){},stop(){}};},createGain(){return {gain:{setValueAtTime(){},linearRampToValueAtTime(){},exponentialRampToValueAtTime(){}},connect(){},disconnect(){}};}};
 return {store,notes,context,changes,get resumes(){return resumes;},get created(){return created;},deny(){fail=true;},options:{storage:{getItem:k=>store.get(k),setItem:(k,v)=>store.set(k,v)},createContext:()=>{created++;return context;},onChange:s=>changes.push(s)}};
}
test('terminal initial snapshots and unseen history are silent, including after reload',async()=>{
 const {createCompletionTracker}=await load();
 for(const status of ['succeeded','failed','cancelled']){
  const tracker=createCompletionTracker();assert.deepEqual(tracker.observe([row(status)]),[]);
  assert.deepEqual(tracker.observe([row(status)]),[]);
  assert.deepEqual(createCompletionTracker().observe([row(status)]),[]);
 }
});
test('only real terminal transitions fire once across polls, reconnects and stale re-renders',async()=>{
 const {createCompletionTracker}=await load();
 for(const terminal of ['succeeded','failed','cancelled']){
  const tracker=createCompletionTracker();assert.equal(tracker.observe([row('queued')]).length,0);
  assert.equal(tracker.observe([row('running',{progress_percent:100})]).length,0);
  const final=row(terminal,{progress_seq:'2',progress_percent:null});assert.deepEqual(tracker.observe([final]),[final]);
  for(let i=0;i<5;i++){assert.equal(tracker.observe([final]).length,0);assert.equal(tracker.observe([row('running')]).length,0);}
  assert.equal(tracker.observe([final,row(terminal,{id:'unseen'})]).length,0);
 }
});
test('rejects stale revisions and unknown statuses, keeps identities across projects and missing pages',async()=>{
 const {createCompletionTracker}=await load();const tracker=createCompletionTracker();
 tracker.observe([row('running',{progress_seq:'9007199254740993'})]);
 assert.equal(tracker.observe([row('failed',{progress_seq:'2'})]).length,0);
 assert.equal(tracker.observe([row('failed',{progress_seq:'9007199254740993',updated_at:'2026-10-10T00:00:00Z'})]).length,0);
 tracker.observe([]);assert.equal(tracker.observe([row('succeeded',{progress_seq:'9007199254740994'})]).length,1);
 assert.equal(tracker.observe([row('failed',{project_id:'different'})]).length,0);
 tracker.observe([row('unknown',{id:'unknown'})]);assert.equal(tracker.observe([row('failed',{id:'unknown'})]).length,0);
});
test('default mute, gesture unlock, tones per outcome, disable and persisted preference',async()=>{
 const {createCompletionSound,SOUND_PREFERENCE}=await load(),f=audio(),sound=createCompletionSound(f.options);
 assert.deepEqual(sound.state(),{enabled:false,ready:false});assert.equal(f.created,0);
 sound.observe([row('running')]);sound.observe([row('succeeded')]);assert.equal(f.notes.length,0);
 await sound.enable();assert.equal(f.resumes,1);assert.equal(f.store.get(SOUND_PREFERENCE),'on');
 sound.observe([row('succeeded')]);assert.equal(f.notes.length,0,'no delayed notification');
 for(const [status,id] of [['succeeded','success'],['failed','failure'],['cancelled','cancel']]){sound.observe([row('running',{id})]);sound.observe([row(status,{id})]);sound.observe([row(status,{id})]);}
 assert.deepEqual(f.notes,[660,880,440,330,440]);
 sound.disable();assert.equal(f.store.get(SOUND_PREFERENCE),'off');sound.observe([row('queued',{id:'muted'})]);sound.observe([row('failed',{id:'muted'})]);assert.equal(f.notes.length,5);
 await sound.enable();sound.observe([row('failed',{id:'muted'})]);assert.equal(f.notes.length,5);
 const reloaded=createCompletionSound(f.options);assert.deepEqual(reloaded.state(),{enabled:true,ready:false});assert.equal(f.created,1);
 reloaded.observe([row('running',{id:'new'})]);reloaded.observe([row('succeeded',{id:'new'})]);assert.equal(f.notes.length,5);
});
test('autoplay denial, suspended context and unavailable storage never retry old completions',async()=>{
 const {createCompletionSound}=await load(),f=audio();f.deny();const sound=createCompletionSound(f.options);
 assert.equal(await sound.enable(),false);sound.observe([row('running')]);sound.observe([row('succeeded')]);assert.equal(f.notes.length,0);assert.equal(f.resumes,1);sound.disable();assert.equal(sound.state().enabled,false);
 const g=audio(),active=createCompletionSound(g.options);await active.enable();active.observe([row('running')]);g.context.state='suspended';active.observe([row('failed')]);assert.equal(active.state().ready,false);assert.equal(g.resumes,1);await active.enable();active.observe([row('failed')]);assert.equal(g.notes.length,0);
 const unavailable=createCompletionSound({storage:{getItem(){throw Error('blocked');},setItem(){throw Error('blocked');}},createContext(){throw Error('unsupported');}});
 assert.equal(await unavailable.enable(),false);unavailable.disable();assert.deepEqual(unavailable.state(),{enabled:false,ready:false});
});
test('disabling during an outstanding resume cannot reactivate sound',async()=>{
 const {createCompletionSound}=await load();let finish;
 const context={state:'suspended',resume:()=>new Promise(r=>{finish=()=>{context.state='running';r();};})};
 const sound=createCompletionSound({createContext:()=>context});const enabling=sound.enable();sound.disable();finish();assert.equal(await enabling,false);assert.deepEqual(sound.state(),{enabled:false,ready:false});
});
