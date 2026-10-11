'use strict';
// Start the isolated Android device worker using only an owner-private JSON file.
// No shell commands; no credentials in arguments/logs.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {main}=require('./device-worker-pilot.cjs');
function loadPrivate(file,env=process.env){
 const home=fs.realpathSync(os.homedir());
 const safeRoot=path.join(home,'.config','codex-bridge');
 const resolved=path.resolve(file);
 const root=fs.realpathSync(safeRoot);
 if(resolved!==path.join(root,path.basename(resolved)))throw Error('Private config must be in dedicated directory');
 const dirStat=fs.lstatSync(root);
 if(!dirStat.isDirectory()||(dirStat.mode&0o077)!==0)throw Error('Private directory must be owner-only');
 const st=fs.lstatSync(resolved);
 if(!st.isFile()||(st.mode&0o077)!==0||st.size>2048||st.size<40)
  throw Error('Private config must be a small owner-only regular file');
 if(typeof process.getuid==='function' && st.uid!==process.getuid())throw Error('Private config owner mismatch');
 const data=JSON.parse(fs.readFileSync(resolved,'utf8'));
 if(typeof data.device_id!=='string'||typeof data.token!=='string')throw Error('Private config fields invalid');
 if(!env.CODEX_SUPABASE_URL||!env.CODEX_SUPABASE_ANON_KEY)
  throw Error('Missing public endpoint configuration');
 return {...env,CODEX_DEVICE_ID:data.device_id,CODEX_DEVICE_TOKEN:data.token,
  CODEX_DEVICE_WORKER_ENABLED:'1'};
}
if(require.main===module){
 try{
  if(process.argv.length!==3)throw Error('Expected private config path');
  const env=loadPrivate(process.argv[2]);
  Object.assign(process.env,env);
  main().catch(()=>{console.error('Device worker stopped');process.exitCode=1;});
 }catch{console.error('Device worker startup rejected: check private configuration');process.exitCode=1;}
}
module.exports={loadPrivate};
