'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {executePlan,validate}=require('../executors/plan');
function ws(t){const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-autopilot-'));fs.mkdirSync(path.join(cwd,'supabase-state'));t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));return cwd;}
test('retry automático conclui sem intervenção',async t=>{
 const cwd=ws(t);let calls=0;
 const r=await executePlan({version:1,policy:{max_retries:2},steps:[{type:'run_command',command:'npm',args:['test']}]},{cwd,taskId:'retry',runSafeCommand:async()=>({code:++calls<3?1:0,output:calls<3?'FAIL\\n':'OK\\n'})});
 assert.equal(r.code,0);assert.equal(calls,3);assert.equal(r.planResult.steps[0].attempts,3);
});
test('rollback restaura arquivo após falha',async t=>{
 const cwd=ws(t),file=path.join(cwd,'x.js');fs.writeFileSync(file,'before');
 const r=await executePlan({version:1,policy:{max_retries:0},steps:[{type:'write_file',path:'x.js',content:'after'},{type:'run_command',command:'npm',args:['test']}]},{cwd,taskId:'rollback',runSafeCommand:async()=>({code:1,output:'FAIL\\n'})});
 assert.equal(r.code,1);assert.equal(r.planResult.rolled_back,true);assert.equal(fs.readFileSync(file,'utf8'),'before');
});
test('resume continua do checkpoint',async t=>{
 const cwd=ws(t),spec={version:1,policy:{max_retries:0,rollback_on_failure:false},steps:[{type:'write_file',path:'x.js',content:'ok'},{type:'run_command',command:'npm',args:['test']}]};
 const a=await executePlan(spec,{cwd,taskId:'resume',runSafeCommand:async()=>({code:1,output:'FAIL\\n'})});assert.equal(a.code,1);
 let second=0;const b=await executePlan(spec,{cwd,taskId:'resume',runSafeCommand:async()=>{second++;return {code:0,output:'OK\\n'};}});
 assert.equal(b.code,0);assert.equal(b.planResult.resumed,true);assert.equal(second,1);assert.equal(b.planResult.steps.filter(x=>x.type==='write_file').length,1);
});
test('policy continua fechada',()=>{
 assert.throws(()=>validate({version:1,policy:{max_retries:99},steps:[{type:'run_command',command:'npm',args:['test']}]}));
 assert.throws(()=>validate({version:1,policy:{shell:true},steps:[{type:'run_command',command:'npm',args:['test']}]}));
});
