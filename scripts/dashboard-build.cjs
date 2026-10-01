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
 return {supabaseUrl:u.origin,publishableKey:key};
}
const mode=process.argv[2];
if(mode==='--generate'){fs.writeFileSync(path.join(dir,'shared.mjs'),generated());console.log('Dashboard shared contract generated.');}
else if(mode==='--check'){if(fs.readFileSync(path.join(dir,'shared.mjs'),'utf8')!==generated())throw Error('Dashboard contract stale: npm run dashboard:generate');console.log('Dashboard contract current.');}
else{
 const publicConfig=config();
 const names=['index.html','styles.css','app.mjs','core.mjs','data.mjs','charts.mjs','demo.mjs','shared.mjs','favicon.svg'];
 const allowed=new Set([...names,'public-config.json','.nojekyll']);
 const out=path.join(dir,'dist');
 if(fs.existsSync(out)&&(!fs.lstatSync(out).isDirectory()||fs.lstatSync(out).isSymbolicLink()))throw Error('Output must be a regular directory');
 if(fs.existsSync(out)&&fs.readdirSync(out).some(name=>!allowed.has(name)||!fs.lstatSync(path.join(out,name)).isFile()||fs.lstatSync(path.join(out,name)).isSymbolicLink()))throw Error('Unexpected output file: review dist before building; nothing removed');
 for(const name of names)if(!fs.lstatSync(path.join(dir,name)).isFile()||fs.lstatSync(path.join(dir,name)).isSymbolicLink())throw Error('Build assets must be regular source files');
 if(fs.readFileSync(path.join(dir,'shared.mjs'),'utf8')!==generated())throw Error('Dashboard contract stale');
 fs.mkdirSync(out,{recursive:true});
 for(const name of names)fs.copyFileSync(path.join(dir,name),path.join(out,name));
 fs.writeFileSync(path.join(out,'public-config.json'),JSON.stringify(publicConfig,null,2)+'\n');
 fs.writeFileSync(path.join(out,'.nojekyll'),'');
 console.log('Static dashboard built: dashboard/dist (public config only).');
}
