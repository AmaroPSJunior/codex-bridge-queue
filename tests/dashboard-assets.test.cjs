'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const cp=require('node:child_process');

test('dashboard build versions app, css and every local module import with one release id',()=>{
  const root=path.resolve(__dirname,'..');
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-assets-'));
  try{
    fs.mkdirSync(path.join(temp,'scripts'));
    fs.cpSync(path.join(root,'dashboard'),path.join(temp,'dashboard'),{recursive:true,filter:p=>!p.includes('/dist')});
    fs.copyFileSync(path.join(root,'scripts/dashboard-build.cjs'),path.join(temp,'scripts/dashboard-build.cjs'));
    for(const name of ['task-display.js','task-progress.js'])fs.copyFileSync(path.join(root,name),path.join(temp,name));
    cp.execFileSync(process.execPath,['scripts/dashboard-build.cjs'],{cwd:temp,env:{PATH:process.env.PATH}});
    const dist=path.join(temp,'dashboard','dist');
    const html=fs.readFileSync(path.join(dist,'index.html'),'utf8');
    const app=fs.readFileSync(path.join(dist,'app.mjs'),'utf8');
    const core=fs.readFileSync(path.join(dist,'core.mjs'),'utf8');
    const v=html.match(/app\.mjs\?v=([a-f0-9]{12})/);
    assert.ok(v);
    assert.ok(html.includes('styles.css?v='+v[1]));
    assert.ok(app.includes("./core.mjs?v="+v[1]));
    assert.ok(app.includes("./presentation.mjs?v="+v[1]));
    assert.ok(app.includes("./data.mjs?v="+v[1]));
    assert.ok(core.includes("./shared.mjs?v="+v[1]));
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
