const {test}=require('node:test'),assert=require('node:assert/strict');
const config={supabaseUrl:'https://example.supabase.co',publishableKey:'sb_publishable_fixture'};
async function fixture(store={session:null}){
 const {createData}=await import('../dashboard/data.mjs');let listener,options,logoutScope,lost=0,channelCount=0,authToken;
 const client={auth:{
  onAuthStateChange:fn=>{listener=fn;return {data:{subscription:{unsubscribe(){}}}};},
  signInWithPassword:async()=>{store.session={access_token:'fixture-access',refresh_token:'fixture-refresh',expires_at:Math.floor(Date.now()/1000)+3600};return {};},
  getSession:async()=>({data:{session:store.session}}),getUser:async()=>({data:{user:store.session?{id:'fixture'}:null}}),
  signOut:async opts=>{logoutScope=opts.scope;store.session=null;listener('SIGNED_OUT');return {};}
 },rpc:async name=>({data:name==='bridge_dashboard_detail'?{output_available:false,recent_output:null}:[]}),
 realtime:{setAuth:async token=>{authToken=token;}},channel:()=>{channelCount++;return {on(){return this;},subscribe(fn){fn('SUBSCRIBED');return this;}};},removeChannel:async()=>{}};
 const api=await createData(config,{load:async()=>({createClient:(u,k,o)=>{options=o;return client;}}),onAuthLost:()=>lost++,onState:()=>{},onRefresh:()=>{}});
 return {api,client,options,store,event:(...args)=>listener(...args),get lost(){return lost;},get scope(){return logoutScope;},get channels(){return channelCount;},get token(){return authToken;}};
}
test('login, dispose, reload restoration, navigation/logs and explicit local logout',async()=>{
 const store={session:null},first=await fixture(store);assert.equal(first.options.auth.persistSession,true);assert.equal(first.options.auth.autoRefreshToken,true);
 assert.equal(await first.api.restore(),false);await first.api.login('user','password');await first.api.close();assert.ok(store.session);
 const reload=await fixture(store);assert.equal(await reload.api.restore(),true);await reload.api.subscribe();assert.equal(reload.token,'fixture-access');
 await reload.api.list({});await reload.api.stats();assert.equal((await reload.api.detail('task')).output_available,false);
 reload.client.rpc=async()=>({data:{output_available:true,recent_output:'safe line'}});assert.equal((await reload.api.detail('task')).recent_output,'safe line');
 await reload.api.logout();assert.equal(reload.scope,'local');assert.equal(store.session,null);const after=await fixture(store);assert.equal(await after.api.restore(),false);await after.api.close();
});
test('temporary verification failure preserves session and disposal never signs out',async()=>{
 const session={access_token:'fixture',refresh_token:'fixture-refresh',expires_at:Math.floor(Date.now()/1000)+3600};const f=await fixture({session});f.client.auth.getUser=async()=>({error:{status:503}});await assert.rejects(f.api.restore(),/sessão preservada/);await f.api.close();assert.ok(f.store.session);
});
test('refresh authenticates realtime and another-tab logout clears consumer',async()=>{
 const f=await fixture({session:{access_token:'fixture',refresh_token:'fixture-refresh',expires_at:Math.floor(Date.now()/1000)+3600}});f.event('TOKEN_REFRESHED',{access_token:'rotated'});await new Promise(r=>setTimeout(r,5));assert.equal(f.token,'rotated');f.event('SIGNED_OUT');await new Promise(r=>setTimeout(r,5));assert.equal(f.lost,1);await f.api.close();
});
test('logout failure stays explicit and does not pretend the session was cleared',async()=>{
 const f=await fixture({session:{access_token:'fixture',refresh_token:'fixture-refresh',expires_at:Math.floor(Date.now()/1000)+3600}});f.client.auth.signOut=async()=>({error:{message:'offline'}});await assert.rejects(f.api.logout(),/novamente/);assert.ok(f.store.session);await f.api.close();
});
