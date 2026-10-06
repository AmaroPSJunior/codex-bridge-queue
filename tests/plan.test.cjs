'use strict';

const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');

const {
  validate,
  executePlan
}=require('../executors/plan');

function workspace(t){
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-plan-'));
  t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));
  return cwd;
}

test('plan valida gramática fechada',()=>{
  assert.deepEqual(
    validate({
      version:1,
      steps:[
        {type:'write_file',path:'x.js',content:'ok'},
        {type:'run_command',command:'npm',args:['test']}
      ]
    }).steps.length,
    2
  );

  assert.throws(()=>validate({version:2,steps:[]}));
  assert.throws(()=>validate({
    version:1,
    steps:[{type:'shell',command:'sh'}]
  }));
});

test('plan escreve arquivo determinísticamente',async t=>{
  const cwd=workspace(t);

  const r=await executePlan({
    version:1,
    steps:[
      {
        type:'write_file',
        path:'example.js',
        content:"module.exports='OK';\n"
      }
    ]
  },{
    cwd,
    env:{}
  });

  assert.equal(r.code,0);
  assert.equal(
    fs.readFileSync(path.join(cwd,'example.js'),'utf8'),
    "module.exports='OK';\n"
  );
  assert.equal(r.planResult.steps.length,1);
});

test('plan executa comando pela política safe-command',async t=>{
  const cwd=workspace(t);
  let received;

  const r=await executePlan({
    version:1,
    steps:[
      {
        type:'run_command',
        command:'npm',
        args:['test']
      }
    ]
  },{
    cwd,
    env:{},
    runSafeCommand:async spec=>{
      received=spec;
      return {code:0,output:'TEST OK\n'};
    }
  });

  assert.equal(r.code,0);
  assert.equal(received.command,'npm');
  assert.deepEqual(received.args,['test']);
  assert.equal(r.planResult.steps[0].exit_code,0);
});

test('plan para no primeiro comando com falha',async t=>{
  const cwd=workspace(t);

  const r=await executePlan({
    version:1,
    steps:[
      {type:'run_command',command:'npm',args:['test']},
      {type:'write_file',path:'nao-deve-existir.js',content:'x'}
    ]
  },{
    cwd,
    env:{},
    runSafeCommand:async()=>({code:2,output:'FAIL\n'})
  });

  assert.equal(r.code,1);
  assert.equal(r.planResult.status,'failed');
  assert.equal(
    fs.existsSync(path.join(cwd,'nao-deve-existir.js')),
    false
  );
});

test('plan bloqueia traversal e arquivo sensível',async t=>{
  const cwd=workspace(t);

  for(const file of ['../escape.js','.env','logs/x.js']){
    const r=await executePlan({
      version:1,
      steps:[
        {type:'write_file',path:file,content:'x'}
      ]
    },{
      cwd,
      env:{}
    });

    assert.equal(r.code,1);
  }
});
