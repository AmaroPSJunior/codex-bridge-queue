const {test}=require('node:test');
const assert=require('node:assert/strict');
const {harness}=require('./harness.cjs');

async function execute(t,env={},output='{"status":"SUCCESS","response":"ok"}',code=0){
  const h=harness(t,'supabase-worker.js',{env});
  const pending=h.run("execute('prompt literal',{id:'task-1'})");
  const child=h.calls[0].child;
  if(output!==undefined)child.stdout.emit('data',output);
  child.emit('close',code);
  return {h,result:await pending};
}

test('provider ausente mantém Codex como padrão',async t=>{
  const {h}=await execute(t,{});
  assert.match(h.calls[0].command,/codex-bridge$/);
  assert.deepEqual(Array.from(h.calls[0].args),['prompt literal']);
});

test('AI_PROVIDER=codex usa Codex',async t=>{
  const {h}=await execute(t,{AI_PROVIDER:'codex'});
  assert.match(h.calls[0].command,/codex-bridge$/);
});

test('AI_PROVIDER=antigravity chama agy com JSON headless no workspace',async t=>{
  const {h,result}=await execute(t,{AI_PROVIDER:'antigravity'});
  assert.equal(h.calls[0].command,'agy');
  assert.deepEqual(Array.from(h.calls[0].args),['--print=prompt literal','--output-format','json']);
  assert.equal(h.calls[0].opts.shell,false);
  assert.equal(h.calls[0].opts.cwd,h.context.__dirname);
  assert.equal(result.code,0);
});

test('agy SUCCESS converte para completed e response vira answer',async t=>{
  const {result}=await execute(t,{AI_PROVIDER:'antigravity'},JSON.stringify({status:'SUCCESS',response:'Resposta agy',conversation_id:'private-id'}));
  assert.deepEqual(JSON.parse(result.stdout),{status:'completed',answer:'Resposta agy',error:null});
});

test('agy status de erro converte para failed e preserva erro',async t=>{
  const {result}=await execute(t,{AI_PROVIDER:'antigravity'},JSON.stringify({status:'ERROR',response:'parcial',error:'falha controlada'}),1);
  assert.deepEqual(JSON.parse(result.stdout),{status:'failed',answer:'parcial',error:'falha controlada'});
  assert.equal(result.code,1);
});

test('agy com stdout JSON inválido falha sem travar',async t=>{
  const {result}=await execute(t,{AI_PROVIDER:'antigravity'},'not json',0);
  assert.deepEqual(JSON.parse(result.stdout),{status:'failed',answer:'',error:'Resposta JSON inválida do agy.'});
  assert.equal(result.code,1);
});

test('erro de spawn do agy vira failed',async t=>{
  const h=harness(t,'supabase-worker.js',{env:{AI_PROVIDER:'antigravity'}});
  const pending=h.run("execute('prompt')");
  h.calls[0].child.emit('error',Error('agy ausente'));
  const result=await pending;
  assert.equal(result.code,1);
  assert.deepEqual(JSON.parse(result.stdout),{status:'failed',answer:'',error:'agy ausente'});
});

test('cancelamento do executor encerra agy e não chama git push',async t=>{
  const h=harness(t,'supabase-worker.js',{env:{AI_PROVIDER:'antigravity'}});
  h.run("runPromise=execute('prompt')");
  const execution=h.calls[0];
  h.run('runPromise.cancel()');
  assert.equal(execution.child.killed,'SIGTERM');
  execution.child.emit('close',143);
  await h.run('runPromise');
  assert.equal(h.calls.some(c=>c.command==='git'&&c.args.includes('push')),false);
});
