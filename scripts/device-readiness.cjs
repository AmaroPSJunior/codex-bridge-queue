'use strict';
// Read-only Termux readiness probe. No credentials, shell, ADB or car APIs.
const os=require('node:os');
const net=require('node:net');
async function inspect(env=process.env){
 const result={
  platform:process.platform,architecture:process.arch,
  node:process.version,homePresent:!!env.HOME,
  termuxPrefixPresent:typeof env.PREFIX==='string'&&env.PREFIX.includes('com.termux'),
  android:typeof env.ANDROID_ROOT==='string'||process.platform==='android'
 };
 if(env.CODEX_SUPABASE_URL){
  let target;
  try{target=new URL(env.CODEX_SUPABASE_URL)}catch{return {...result,supabaseHttps:false};}
  result.supabaseHttps=target.protocol==='https:';
  if(!result.supabaseHttps)return result;
  try{
   const response=await fetch(new URL('/rest/v1/',target.origin),{signal:AbortSignal.timeout(7000)});
   // 401, 404 and 200 all prove HTTPS reachability without credentials.
   result.supabaseReachable=response.status>=200&&response.status<500;
  }catch{result.supabaseReachable=false}
 }
 return result;
}
if(require.main===module)inspect().then(x=>console.log(JSON.stringify(x))).catch(()=>{console.error('Readiness probe failed');process.exitCode=1;});
module.exports={inspect};
