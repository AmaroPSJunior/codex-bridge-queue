import {Connection} from './core.mjs';
const SDK='https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.91.0/+esm';
export function validateConfig(config){
 const u=new URL(config.supabaseUrl);if(u.protocol!=='https:'||!u.hostname.endsWith('.supabase.co')||u.username||u.password||u.search||u.hash||u.pathname!=='/')throw Error('Configuração pública inválida.');
 if(!/^sb_publishable_[A-Za-z0-9_-]+$/.test(config.publishableKey||''))throw Error('Configure uma chave publicável; nunca use service_role.');return config;
}
export async function createData(config,{onEvent,onState,onRefresh,onAuthLost,load=()=>import(SDK)}={}){
 validateConfig(config);const {createClient}=await load();
 const client=createClient(config.supabaseUrl,config.publishableKey,{auth:{persistSession:false,autoRefreshToken:true,detectSessionInUrl:false},global:{fetch:(url,opts)=>fetch(url,{...opts,signal:AbortSignal.timeout(15000)})}});
 let channel,gate,closed=false,generation=0;const abort=async()=>{generation++;gate?.stop();const previous=channel;channel=null;if(previous)await client.removeChannel(previous);};
 const auth=client.auth.onAuthStateChange((event)=>{if(event==='SIGNED_OUT'&&!closed){abort().catch(()=>{});setTimeout(()=>{if(!closed)onAuthLost?.();},0);}});
 async function rpc(name,args={}){const {data,error}=await client.rpc(name,args);if(error)throw Error('Não foi possível ler o painel. Confira conexão e autorização.');return data;}
 return {
  async login(email,password){const {error}=await client.auth.signInWithPassword({email,password});if(error)throw Error('Login não autorizado. Confira sua conta.');try{await rpc('bridge_dashboard_list',{p_limit:1});}catch(e){await client.auth.signOut();throw e;}},
  list:args=>rpc('bridge_dashboard_list',args), summary:id=>rpc('bridge_dashboard_summary',{p_id:id}), detail:id=>rpc('bridge_dashboard_detail',{p_id:id}),stats:()=>rpc('bridge_dashboard_stats'),
  async subscribe(){await abort();closed=false;const attempt=generation;gate=new Connection({refresh:onRefresh,onState});gate.set('connecting');try{const {data:{session}}=await client.auth.getSession();if(!session?.access_token)throw Error('Sessão ausente');await client.realtime.setAuth(session.access_token);}catch{if(attempt===generation)gate.set('offline');return;}if(closed||attempt!==generation)return;
   channel=client.channel('bridge-dashboard',{config:{private:true}}).on('broadcast',{event:'task_changed'},({payload})=>{if(!closed&&attempt===generation)onEvent?.(payload);}).subscribe(status=>{if(!closed&&attempt===generation)gate.set(status==='SUBSCRIBED'?'live':status==='CLOSED'?'offline':'reconnecting');});
  },
  async close(){closed=true;await abort();auth.data.subscription.unsubscribe();await client.auth.signOut();}
 };
}

// Public mode consumes ONLY an explicitly published aggregate snapshot.
// No access to bridge_tasks, authentication, instructions, results or output.
export function publicSummary(input){
 const countKeys=['queued','running','succeeded','failed','cancelled'];
 if(!input||Object.keys(input).some(k=>!['counts','updated_at','providers'].includes(k))||!input.counts||Object.keys(input.counts).some(k=>!countKeys.includes(k)))throw Error('Resumo público inválido.');
 const counts={};for(const k of countKeys){const n=input.counts[k];if(!Number.isSafeInteger(n)||n<0)throw Error('Contagem pública inválida.');counts[k]=n;}
 if(typeof input.updated_at!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(input.updated_at)||!Number.isFinite(Date.parse(input.updated_at)))throw Error('Data pública inválida.');
 if(input.providers!==undefined&&(!Array.isArray(input.providers)||input.providers.length>5))throw Error('Agentes públicos inválidos.');
 const providers=(input.providers||[]).map(p=>{if(!p||Object.keys(p).some(k=>!['provider','state'].includes(k))||!['codex','groq','antigravity','claude','local'].includes(p.provider)||!['ready','quota_exceeded','auth_error','unavailable'].includes(p.state))throw Error('Agente público inválido.');return {provider:p.provider,state:p.state};});
 const finished=counts.succeeded+counts.failed+counts.cancelled;
 return {counts,providers,updated_at:input.updated_at,total:Object.values(counts).reduce((a,b)=>a+b,0),completionRate:finished?counts.succeeded/finished*100:0,avgWait:null,avgDuration:null,days:[],buckets:[0,0,0,0],names:[]};
}
export function createPublicData({onRefresh=()=>{},onState=()=>{},request=fetch}={}){
 let timer;
 return {list:async()=>[],detail:async()=>null,summary:async()=>null,
  async stats(){const response=await request('./public-summary.json',{cache:'no-store',credentials:'omit',redirect:'error',signal:AbortSignal.timeout(10000)});if(!response.ok)throw Error('Resumo público indisponível');const reader=response.body.getReader();let size=0,text='';const decoder=new TextDecoder();try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>65536)throw Error('Resumo público excessivo');text+=decoder.decode(value,{stream:true});}text+=decoder.decode();}finally{await reader.cancel();reader.releaseLock();}return publicSummary(JSON.parse(text));},
  async subscribe(){clearInterval(timer);onState('public');timer=setInterval(()=>onRefresh(),60000);},
  async close(){clearInterval(timer);}
 };
}
