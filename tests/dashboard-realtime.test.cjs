'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');

test('realtime reducer applies insert/update/delete and rejects stale progress',async()=>{
  const {normalize,applyTaskChange}=await import('../dashboard/core.mjs');
  let rows=[];
  const first=normalize({id:'a',task_number:1,title:'Nova',status:'queued',created_at:'2026-10-06T08:00:00Z',updated_at:'2026-10-06T08:00:00Z',progress_seq:'0'});
  rows=applyTaskChange(rows,{id:'a',operation:'INSERT'},first);
  assert.equal(rows.length,1);
  const running=normalize({...first,status:'running',updated_at:'2026-10-06T08:01:00Z',progress_seq:'1'});
  rows=applyTaskChange(rows,{id:'a',operation:'UPDATE'},running);
  assert.equal(rows.length,1);
  assert.equal(rows[0].status,'running');
  const stale=normalize({...first,status:'queued',updated_at:'2026-10-06T07:59:00Z',progress_seq:'0'});
  rows=applyTaskChange(rows,{id:'a',operation:'UPDATE'},stale);
  assert.equal(rows[0].status,'running');
  rows=applyTaskChange(rows,{id:'a',operation:'DELETE'},null);
  assert.equal(rows.length,0);
});

test('authenticated realtime performs catch-up on initial subscribe and reconnect',async()=>{
  const {createData}=await import('../dashboard/data.mjs');
  const config={supabaseUrl:'https://example.supabase.co',publishableKey:'sb_publishable_fixture'};
  let subscription,refreshes=0;
  const channel={on(){return this;},subscribe(fn){subscription=fn;return this;}};
  const client={
    auth:{
      onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),
      getSession:async()=>({data:{session:{access_token:'token',refresh_token:'refresh',expires_at:Math.floor(Date.now()/1000)+3600}}}),
      signInWithPassword:async()=>({}),
      signOut:async()=>({})
    },
    realtime:{setAuth:async()=>{}},
    rpc:async()=>({data:[]}),
    channel:()=>channel,
    removeChannel:async()=>{}
  };
  const api=await createData(config,{load:async()=>({createClient:()=>client}),onRefresh:()=>{refreshes++;},onState:()=>{}});
  await api.subscribe();
  subscription('SUBSCRIBED');
  await new Promise(r=>setTimeout(r,0));
  assert.equal(refreshes,1);
  subscription('CHANNEL_ERROR');
  subscription('SUBSCRIBED');
  await new Promise(r=>setTimeout(r,0));
  assert.equal(refreshes,2);
  await api.close();
});
