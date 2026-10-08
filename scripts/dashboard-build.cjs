'use strict';
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),dir=path.join(root,'dashboard');
function generated(){
 const identity=fs.readFileSync(path.join(root,'task-display.js'),'utf8').replace("'use strict';",'').replace(/module\.exports=\{([^}]+)\};/, 'export {$1};');
 const m=fs.readFileSync(path.join(root,'task-progress.js'),'utf8').match(/MAX_LINES=(\d+),MAX_BYTES=(\d+)\*1024,INTERVAL=(\d+),FLUSH_LINES=(\d+)/);
 if(!m)throw Error('Review progress limits before building dashboard');
 return '// Generated from task-display.js and task-progress.js; npm run dashboard:generate\n'+identity+'\nexport const LIMITS='+JSON.stringify({lines:+m[1],bytes:+m[2]*1024,intervalMs:+m[3],flushLines:+m[4],commandEnd:true})+';\n';
}
function config(){
 const url=process.env.PUBLIC_SUPABASE_URL||'https://pqskisosukkiurddlodw.supabase.co';
 const key=process.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY||'';
 const u=new URL(url);if(u.protocol!=='https:'||!u.hostname.endsWith('.supabase.co')||u.username||u.password||u.search||u.hash||u.pathname!=='/')throw Error('Invalid public Supabase origin');
 if(key&&!/^sb_publishable_[A-Za-z0-9_-]+$/.test(key))throw Error('Only a publishable key is allowed; no JWT/service/secret key');
 return {supabaseUrl:u.origin,publishableKey:key,...(process.env.PUBLIC_DASHBOARD_MODE==='public'?{publicSummaryPath:'./public-summary.json'}:{})};
}
const mode=process.argv[2];
if(mode==='--generate'){fs.writeFileSync(path.join(dir,'shared.mjs'),generated());console.log('Dashboard shared contract generated.');}
else if(mode==='--check'){if(fs.readFileSync(path.join(dir,'shared.mjs'),'utf8')!==generated())throw Error('Dashboard contract stale: npm run dashboard:generate');console.log('Dashboard contract current.');}
else build().catch(error=>{console.error(error.message);process.exitCode=1;});
async function build(){
 const publicConfig=config();
 let snapshot;
 if(publicConfig.publicSummaryPath){const file=path.join(dir,'public-summary.json');const st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.size>65536)throw Error('Invalid public aggregate snapshot');snapshot=JSON.parse(fs.readFileSync(file,'utf8'));(await import('../dashboard/data.mjs')).publicSummary(snapshot);}
 const names=['presentation.mjs','index.html','styles.css','app.mjs','core.mjs','data.mjs','charts.mjs','demo.mjs','shared.mjs','favicon.svg'];
 const allowed=new Set([...names,'public-config.json','public-summary.json','.nojekyll']);
 const out=path.join(dir,'dist');
 if(fs.existsSync(out)&&(!fs.lstatSync(out).isDirectory()||fs.lstatSync(out).isSymbolicLink()))throw Error('Output must be a regular directory');
 if(fs.existsSync(out)&&fs.readdirSync(out).some(name=>!allowed.has(name)||!fs.lstatSync(path.join(out,name)).isFile()||fs.lstatSync(path.join(out,name)).isSymbolicLink()))throw Error('Unexpected output file: review dist before building; nothing removed');
 for(const name of names)if(!fs.lstatSync(path.join(dir,name)).isFile()||fs.lstatSync(path.join(dir,name)).isSymbolicLink())throw Error('Build assets must be regular source files');
 if(fs.readFileSync(path.join(dir,'shared.mjs'),'utf8')!==generated())throw Error('Dashboard contract stale');
 fs.mkdirSync(out,{recursive:true});
 for(const name of names)fs.copyFileSync(path.join(dir,name),path.join(out,name));
 const crypto=require('node:crypto');
 const releaseVersion=crypto.createHash('sha256').update(names.map(name=>fs.readFileSync(path.join(dir,name))).join('')).digest('hex').slice(0,12);
 // GitHub Pages/browser caches module dependencies independently. Version every local
 // module import with the same release id so app/core/data/shared can never mix releases.
 for(const name of names.filter(name=>name.endsWith('.mjs'))){
  const target=path.join(out,name);
  const source=fs.readFileSync(target,'utf8').replace(/(from\s+['"])(\.\/[^'"]+\.mjs)(['"])/g,(_,a,s,b)=>a+s+'?v='+releaseVersion+b);
  fs.writeFileSync(target,source);
 }
 const indexPath=path.join(out,'index.html');
 const buildNumber=String(process.env.DASHBOARD_BUILD_NUMBER||'0');
 if(!/^\d{1,9}$/.test(buildNumber))throw Error('Invalid dashboard build number');
 fs.writeFileSync(indexPath,fs.readFileSync(indexPath,'utf8')
  .replace('id="app-version">v1.0.0','id="app-version">v1.0.'+Number(buildNumber))
  .replace('./app.mjs','./app.mjs?v='+releaseVersion)
  .replace('./styles.css','./styles.css?v='+releaseVersion));
 fs.writeFileSync(path.join(out,'public-config.json'),JSON.stringify(publicConfig,null,2)+'\n');
 if(snapshot)fs.writeFileSync(path.join(out,'public-summary.json'),JSON.stringify(snapshot)+'\n');
 else if(fs.existsSync(path.join(out,'public-summary.json')))fs.unlinkSync(path.join(out,'public-summary.json'));
 fs.writeFileSync(path.join(out,'.nojekyll'),'');
 console.log('Static dashboard built: dashboard/dist (public config only).');
}
