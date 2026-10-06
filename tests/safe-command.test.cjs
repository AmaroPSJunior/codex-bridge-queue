'use strict';

const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createSafeCommandRunner}=require('../executors/safe-command');

function fixture(t,options={}){
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'safe-command-'));

  t.after(()=>{
    fs.rmSync(cwd,{recursive:true,force:true});
  });

  fs.writeFileSync(
    path.join(cwd,'package.json'),
    JSON.stringify({
      scripts:{
        test:'node test-script.js',
        hello:'node hello.js'
      }
    })
  );

  fs.writeFileSync(
    path.join(cwd,'test-script.js'),
    "console.log('TEST_OK')\n"
  );

  fs.writeFileSync(
    path.join(cwd,'hello.js'),
    "console.log('HELLO_OK')\n"
  );

  return {
    cwd,
    run:createSafeCommandRunner({
      cwd,
      env:process.env,
      timeoutMs:15000,
      ...options
    })
  };
}

test('executa npm test no workspace',async t=>{
  const f=fixture(t);

  const r=await f.run({
    command:'npm',
    args:['test']
  });

  assert.equal(r.code,0);
  assert.match(r.output,/TEST_OK/);
});

test('executa node somente em arquivo relativo do workspace',async t=>{
  const f=fixture(t);

  const r=await f.run({
    command:'node',
    args:['hello.js']
  });

  assert.equal(r.code,0);
  assert.match(r.output,/HELLO_OK/);

  await assert.rejects(
    ()=>f.run({
      command:'node',
      args:['-e','require("fs").writeFileSync("/tmp/x","x")']
    }),
    /Opção node recusada/
  );
});

test('recusa shell e comandos fora da whitelist',async t=>{
  const f=fixture(t);

  await assert.rejects(
    ()=>f.run({
      command:'bash',
      args:['-c','echo x']
    }),
    /Comando recusado/
  );

  await assert.rejects(
    ()=>f.run({
      command:'npm',
      args:['test','&&','rm','-rf','/']
    }),
    /Sintaxe de shell recusada/
  );
});

test('git push e commit ficam bloqueados por padrão',async t=>{
  const f=fixture(t);

  await assert.rejects(
    ()=>f.run({
      command:'git',
      args:['push']
    }),
    /Comando git recusado/
  );

  await assert.rejects(
    ()=>f.run({
      command:'git',
      args:['commit','-m','teste']
    }),
    /Comando git recusado/
  );
});

test('git commit pode ser habilitado explicitamente',async t=>{
  const f=fixture(t,{allowGitCommit:true});

  // A política aceita o comando; o git pode retornar != 0
  // porque o fixture não é necessariamente um repositório.
  const r=await f.run({
    command:'git',
    args:['commit','-m','teste']
  });

  assert.equal(typeof r.code,'number');
});

test('npx é forçado para --no-install',async t=>{
  const f=fixture(t);

  const r=await f.run({
    command:'npx',
    args:['definitely-not-installed-package']
  });

  assert.notEqual(r.code,0);
});
