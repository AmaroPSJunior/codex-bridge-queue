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
