'use strict';

const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createAgent}=require('../executors/local-agent');

const call=(name,args)=>({
  choices:[{
    finish_reason:'tool_calls',
    message:{
      content:null,
      tool_calls:[{
        id:'t',
        type:'function',
        function:{
          name,
          arguments:JSON.stringify(args)
        }
      }]
    }
  }]
});

const done={
  choices:[{
    finish_reason:'stop',
    message:{content:'RECEIPT FIX OK'}
  }]
};

async function fixture(t,steps,instruction='Verifique se executors/result-receipt.js existe.'){
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'local-agent-'));
  t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));

  fs.mkdirSync(path.join(cwd,'executors'));
  fs.writeFileSync(
    path.join(cwd,'executors','result-receipt.js'),
    "'use strict';\n"
  );

  const requests=[];
  const events=[];

  const executor=createAgent({
    cwd,
    env:{
      PATH:process.env.PATH,
      PREFIX:process.env.PREFIX,
      TMPDIR:os.tmpdir(),
      LOCAL_AI_TRUSTED_WORKSPACE:'1'
    },
    model:'qwen-test',
    baseUrl:'http://127.0.0.1:18080',
    fetch:async(url,o)=>{
      requests.push(JSON.parse(o.body));
      return new Response(JSON.stringify(steps.shift()||done));
    }
  });

  const run=()=>executor.execute({
    instruction,
    onProgress:async e=>events.push(e)
  });

  return {cwd,requests,events,run};
}

test('local agent recupera de list_files usado em arquivo e tenta read_file',async t=>{
  const f=await fixture(t,[
    call('list_files',{path:'executors/result-receipt.js'}),
    call('read_file',{path:'executors/result-receipt.js'}),
    done
  ]);

  const r=await f.run();

  assert.equal(r.status,'completed');
  assert.equal(r.answer,'RECEIPT FIX OK');
  assert.equal(f.requests.length,3);

  const second=f.requests[1];
  const toolError=second.messages.find(
    m=>m.role==='tool' &&
       typeof m.content==='string' &&
       m.content.includes('ERRO_TOOL:')
  );

  assert.ok(toolError);
  assert.match(
    toolError.content,
    /Caminho incompatível com a ferramenta escolhida/
  );

  const third=f.requests[2];
  const successfulRead=third.messages.filter(m=>m.role==='tool').at(-1);

  assert.equal(successfulRead.content,"'use strict';\n");
  assert.equal(
    fs.existsSync(path.join(f.cwd,'.bridge-workspace-lock')),
    false
  );
});

test('local agent nunca aceita aviso interno de compactação como resposta final',async t=>{
  const compact={
    choices:[{
      finish_reason:'stop',
      message:{
        content:'Histórico antigo compactado: 1 lotes omitidos. Releia arquivos necessários. Testes após última edição: pendentes.'
      }
    }]
  };

  const f=await fixture(t,[compact,done]);
  const r=await f.run();

  assert.equal(r.status,'completed');
  assert.equal(r.answer,'RECEIPT FIX OK');
  assert.equal(f.requests.length,2);

  assert.ok(
    f.requests[1].messages.some(
      m=>m.role==='system' &&
         typeof m.content==='string' &&
         m.content.includes('não conclui a tarefa')
    )
  );

  assert.ok(
    !f.events.some(
      e=>e.type==='output' &&
         typeof e.text==='string' &&
         e.text.startsWith('Histórico antigo compactado:')
    )
  );
});

test('local agent edita arquivo e valida usando run_command npm test',async t=>{
  const f=await fixture(t,[
    call('write_file',{
      path:'example.js',
      content:"module.exports='QWEN_OK';\n"
    }),
    call('run_command',{
      command:'npm',
      args:['test']
    }),
    done
  ],'Edite example.js e execute npm test para validar a alteração.');

  fs.writeFileSync(
    path.join(f.cwd,'package.json'),
    JSON.stringify({
      scripts:{
        test:'node check.js'
      }
    })
  );

  fs.writeFileSync(
    path.join(f.cwd,'check.js'),
    `
const assert=require('node:assert/strict');
assert.equal(require('./example.js'),'QWEN_OK');
console.log('RUN_COMMAND_TEST_OK');
`
  );

  const r=await f.run();

  assert.equal(r.status,'completed');
  assert.equal(r.answer,'RECEIPT FIX OK');

  assert.equal(
    fs.readFileSync(path.join(f.cwd,'example.js'),'utf8'),
    "module.exports='QWEN_OK';\n"
  );

  assert.ok(
    f.events.some(
      e=>e.type==='output' &&
         typeof e.text==='string' &&
         e.text.includes('RUN_COMMAND_TEST_OK')
    )
  );

  assert.ok(
    f.events.some(
      e=>e.type==='command_end' &&
         e.code===0
    )
  );
});

test('local agent não permite comando fora da whitelist em run_command',async t=>{
  const f=await fixture(t,[
    call('run_command',{
      command:'bash',
      args:['-c','echo proibido']
    })
  ]);

  const r=await f.run();

  assert.equal(r.status,'failed');
  assert.equal(r.error.code,'permission');
});

test('router restringe ferramentas em tarefa somente de leitura',async t=>{
  const f=await fixture(t,[done],'Leia executors/result-receipt.js.');

  const r=await f.run();
  assert.equal(r.status,'completed');

  const names=f.requests[0].tools.map(x=>x.function.name);

  assert.ok(names.includes('read_file'));
  assert.ok(names.includes('list_files'));
  assert.ok(names.includes('search'));
  assert.ok(!names.includes('write_file'));
  assert.ok(!names.includes('run_command'));
  assert.ok(!names.includes('set_package_script'));
});

test('router libera escrita e comando quando a tarefa exige edição e teste',async t=>{
  const f=await fixture(
    t,
    [done],
    'Edite example.js e execute npm test para validar.'
  );

  const r=await f.run();
  assert.equal(r.status,'completed');

  const names=f.requests[0].tools.map(x=>x.function.name);

  assert.ok(names.includes('write_file'));
  assert.ok(names.includes('run_command'));
  assert.ok(names.includes('read_file'));
});


test('router informa raiz e inventário real ao modelo',async t=>{
  const f=await fixture(t,[done],'Leia executors/result-receipt.js.');
  const r=await f.run();

  assert.equal(r.status,'completed');

  const systems=f.requests[0].messages
    .filter(m=>m.role==='system')
    .map(m=>m.content)
    .join('\n');

  assert.match(systems,/A raiz do workspace é "\."/);
  assert.match(systems,/Inventário inicial:/);
  assert.match(systems,/executors\//);
});

test('preflight de caminho inexistente oferece raiz e entradas válidas',async t=>{
  const f=await fixture(t,[
    call('list_files',{path:'tmp'}),
    done
  ],'Inspecione os arquivos do projeto.');

  const r=await f.run();
  assert.equal(r.status,'completed');

  const toolError=f.requests[1].messages.find(
    m=>m.role==='tool' &&
       typeof m.content==='string' &&
       m.content.includes('Caminho inexistente: tmp')
  );

  assert.ok(toolError);
  assert.match(toolError.content,/raiz do workspace é "\."/);
  assert.match(toolError.content,/executors\//);
});
