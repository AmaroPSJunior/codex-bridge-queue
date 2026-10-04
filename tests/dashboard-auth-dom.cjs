// Optional browser-DOM session regression. Mock Auth/storage; no real tokens/network.
const {parseHTML}=require('linkedom'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
(async()=>{
 const root=path.resolve(__dirname,'../dashboard'),actual=await import('../dashboard/data.mjs'),core=await import('../dashboard/core.mjs');
 const store={session:null,logs:false},apis=[];
 const row={id:'fixture-task',task_number:7,task_name:'Consulta segura',status:'succeeded',created_at:'2026-01-01T00:00:00Z',completed_at:'2026-01-01T00:01:00Z'};
 const sdk={createClient:(url,key,opts)=>{assert.equal(opts.auth.persistSession,true);let callback;
  return {auth:{onAuthStateChange:fn=>{callback=fn;return {data:{subscription:{unsubscribe(){}}}};},
   signInWithPassword:async()=>{store.session={access_token:'fixture'};return {};},getSession:async()=>({data:{session:store.session}}),getUser:async()=>({data:{user:store.session?{id:'ordinary-user'}:null}}),
   signOut:async({scope})=>{assert.equal(scope,'local');store.session=null;callback('SIGNED_OUT');return {};}
  },rpc:async(name,args)=>({data:name==='bridge_dashboard_stats'?core.statistics([row]):name==='bridge_dashboard_detail'?{...row,output_available:store.logs,recent_output:store.logs?'sanitized line':null}:name==='bridge_dashboard_summary'?row:args.p_status==='running'?[]:[row]}),
  realtime:{setAuth:async()=>{}},channel:()=>({on(){return this;},subscribe(fn){fn('SUBSCRIBED');return this;}}),removeChannel:async()=>{}};
 }};
 async function browser(){
  const {window}=parseHTML(fs.readFileSync(path.join(root,'index.html'),'utf8')),document=window.document,location={hash:'#tasks'};
  for(const d of document.querySelectorAll('dialog')){d.showModal=()=>d.setAttribute('open','');d.close=()=>d.removeAttribute('open');}
  const form=document.querySelector('#login-form');form.elements={email:form.querySelector('[name=email]'),password:form.querySelector('[name=password]')};
  const context=vm.createContext({document,window,location,console,URL,TextEncoder,AbortSignal,Intl,Date,setTimeout,clearTimeout,setInterval:()=>0,fetch:async()=>({ok:true,json:async()=>({supabaseUrl:'https://example.supabase.co',publishableKey:'sb_publishable_fixture'})})});
  const modules=new Map();for(const name of fs.readdirSync(root).filter(x=>x.endsWith('.mjs')&&x!=='data.mjs')){const file=path.join(root,name);modules.set(file,new vm.SourceTextModule(fs.readFileSync(file,'utf8'),{context,identifier:file}));}
  modules.set(path.join(root,'data.mjs'),new vm.SyntheticModule(['createData','createPublicData'],function(){this.setExport('createData',async(c,o)=>{const a=await actual.createData(c,{...o,load:async()=>sdk});apis.push(a);return a;});this.setExport('createPublicData',actual.createPublicData);},{context}));
  const app=modules.get(path.join(root,'app.mjs'));await app.link((s,r)=>modules.get(path.resolve(path.dirname(r.identifier),s)));await app.evaluate();return {document,window,location,form};
 }
 async function until(check){for(let i=0;i<500;i++){if(check())return;await new Promise(r=>setTimeout(r,2));}throw Error('DOM state did not settle');}
 let page=await browser();const account=()=>page.document.querySelector('#account');await until(()=>!account().disabled);assert.equal(account().textContent,'Conectar');account().click();page.form.elements.email.value='fixture@example.test';page.form.elements.password.value='fixture-password';page.form.dispatchEvent(new page.window.Event('submit',{bubbles:true,cancelable:true}));await until(()=>account().textContent==='Sair');await until(()=>page.document.querySelector('[data-task]'));
 assert.equal(page.form.elements.password.value,'');await apis.at(-1).close();assert.ok(store.session);
 page=await browser();await until(()=>account().textContent==='Sair'&&!account().disabled);await until(()=>page.document.querySelector('[data-task]'));
 for(const route of ['overview','tasks','history','settings']){page.location.hash='#'+route;page.window.dispatchEvent(new page.window.Event('hashchange'));assert.equal(page.document.querySelectorAll('#nav a').length,4);}
 page.location.hash='#tasks';page.window.dispatchEvent(new page.window.Event('hashchange'));await until(()=>page.document.querySelector('[data-task]'));page.document.querySelector('[data-task]').click();await until(()=>page.document.querySelector('#detail-body').textContent.includes('Logs indisponíveis'));
 store.logs=true;page.document.querySelector('[data-task]').click();await until(()=>page.document.querySelector('#detail-body').textContent.includes('sanitized line'));
 account().click();await until(()=>account().textContent==='Conectar'&&!account().disabled);assert.equal(store.session,null);assert.equal(page.document.querySelector('#detail-body').textContent,'');
 page=await browser();await until(()=>!account().disabled);assert.equal(account().textContent,'Conectar');for(const a of apis)await a.close();
 console.log('Dashboard Auth DOM passed: login, reload, ordinary-user navigation, protected/authorized logs, logout and reload after logout.');
})().catch(e=>{console.error(e);process.exitCode=1;});
