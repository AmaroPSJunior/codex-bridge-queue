const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
test('Real dashboard renders running activity across all task surfaces, hides it for terminal rows',async()=>{
 const core=await import('../dashboard/core.mjs'),presentation=await import('../dashboard/presentation.mjs');
 const elements=new Map();const element=id=>{if(!elements.has(id))elements.set(id,{innerHTML:'',textContent:'',querySelectorAll:()=>[],showModal(){}});return elements.get(id);};
 const document={querySelector:selector=>selector==='#project-form'?null:element(selector),querySelectorAll:()=>[]};
 let source=fs.readFileSync('dashboard/app.mjs','utf8').replace(/^import .*;$/gm,'');
 source=source.slice(0,source.indexOf("window.addEventListener('hashchange'"));
 const ctx={...core,...presentation,e:core.escape,document,Date,console,createData(){},createPublicData(){},setTimeout,clearTimeout,location:{hash:''}};
 vm.createContext(ctx);vm.runInContext(source+`;globalThis.api={state,hero,livePage,taskRows,openDetail,render};`,ctx);
 const row={id:'fixture',status:'running',task_number:1,title:'Testar',activity_seq:'9',last_activity_at:new Date().toISOString(),claimed_at:new Date().toISOString()};
 ctx.api.state.rows=[row];ctx.api.state.connection='live';
 for(const fn of ['hero','livePage','taskRows'])assert.match(ctx.api[fn](),/9 eventos/);
 await ctx.api.openDetail(row.id);assert.match(element('#detail-body').innerHTML,/data-monitor/);
 for(const route of ['overview','live','tasks','history','settings']){ctx.api.state.route=route;ctx.api.render();assert.ok(element('#main').innerHTML.length>40);}
 row.status='succeeded';assert.doesNotMatch(ctx.api.taskRows(),/data-monitor/);assert.doesNotMatch(ctx.api.livePage(),/data-monitor/);
});
