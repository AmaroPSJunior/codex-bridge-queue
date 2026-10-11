const {test}=require('node:test'),assert=require('node:assert/strict');
const {createActivity}=require('../task-activity');
test('Activity persists sequence, deduplicates replay after reload and excludes heartbeat',()=>{
 let checkpoint,time=0;const a=createActivity({now:()=>time,save:s=>checkpoint=s});
 assert.equal(a.record('output','a'),true);time=200000;
 assert.equal(a.record('output','a'),false);assert.equal(a.record('heartbeat','alive'),false);
 assert.equal(a.snapshot().activity_seq,'1');assert.equal(a.record('command_end','cmd:0'),true);
 const b=createActivity({initial:checkpoint,now:()=>300000});
 assert.equal(b.record('output','a'),false);assert.equal(b.snapshot().activity_max_gap_ms,200000);
 assert.equal(b.record('output','b'),true);assert.equal(b.snapshot().activity_seq,'3');
 assert.ok(!JSON.stringify(checkpoint).includes('cmd:0'));
});
test('Dashboard uses persisted activity only, including refresh, all thresholds and terminal states',async()=>{
 const {taskActivity}=await import('../dashboard/presentation.mjs');
 const t={status:'running',activity_seq:'123',last_activity_at:new Date(1000).toISOString(),claimed_at:new Date(0).toISOString(),last_progress_at:new Date(999999).toISOString()};
 assert.equal(taskActivity(t,121000).level,'attention');assert.equal(taskActivity(t,301000).level,'stalled');
 assert.equal(taskActivity(JSON.parse(JSON.stringify(t)),301000).count,'123');
 assert.equal(taskActivity(t,11000,'live',{attentionMs:5000,stalledMs:9000}).level,'stalled');
 assert.equal(taskActivity({...t,status:'succeeded'},999999).visible,false);
 assert.equal(taskActivity({status:'running',progress_seq:'555'},1000).count,null);
});
