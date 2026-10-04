'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const c = require('../executors/contract');
function result(status = 'completed') {
  return {provider:'codex',session:{provider:'codex',id:null,state:status},status,answer:'Resposta',
    error:status === 'completed' ? null : {code:'execution',message:'Falhou',retryable:false}};
}
test('contract accepts provider-neutral terminal states without changing queue vocabulary', () => {
  for (const status of c.RESULT_STATES) assert.equal(c.validateResult(result(status)).status,status);
  assert.throws(() => c.validateResult({...result(),status:'succeeded'}),TypeError);
  for (const state of c.SESSION_STATES) c.validateSession({provider:'local_model',id:'session',state});
});
test('contract preserves literal input, partial answers and session identity', async () => {
  const instruction = '  $(touch forbidden)\ntexto  ';
  const expected = result(); expected.session.id = 'opaque-session';
  const executor = c.defineExecutor({version:1,provider:{id:'codex'},async execute(input) {
    assert.equal(input.instruction,instruction); return expected;
  }});
  assert.equal(await executor.execute({instruction}),expected);
  const failed = result('failed'); assert.equal(c.validateResult(failed).answer,'Resposta');
});
test('contract rejects invalid input without echoing sensitive values', () => {
  for (const input of [null,[],{}, {instruction:''},{instruction:'  '},{instruction:42},{instruction:'ok',signal:{}},{instruction:'ok',onProgress:true}])
    assert.throws(() => c.validateInput(input),TypeError);
  assert.throws(() => c.validateSession({provider:'SECRET TOKEN',id:null,state:'running'}),e => !e.message.includes('SECRET'));
  const signal = new AbortController().signal;
  assert.equal(c.validateInput({instruction:'ok',signal}).signal,signal);
});
test('contract rejects inconsistent results and unstructured errors', () => {
  for (const bad of [null,{...result(),provider:'other'},{...result(),answer:null},{...result(),error:'secret'},
    {...result(),session:{provider:'codex',id:null,state:'running'}},{...result('failed'),error:null},
    {...result('failed'),error:{code:'unknown',message:'x',retryable:'yes'}}])
    assert.throws(() => c.validateResult(bad),TypeError);
  for (const code of c.ERROR_CODES) c.validateError({code,message:'safe message',retryable:false});
});
test('executor awaits ordered progress and checks command completion including nonzero exit', async () => {
  const received=[];
  const events=[{type:'output',text:'line\n',stream:'stdout'},{type:'output',text:'error',stream:'stderr'},
    {type:'stage',text:'Validando'},{type:'command_end',code:3},{type:'command_end',code:null}];
  const executor=c.defineExecutor({version:1,provider:{id:'codex'},async execute(input) {
    for (const event of events) {await input.onProgress(event);assert.equal(received.at(-1),event);}
    return result();
  }});
  await executor.execute({instruction:'ok',onProgress:async event=>{await Promise.resolve();received.push(event);}});
  assert.deepEqual(received,events);
  for (const bad of [{type:'output',text:'x',stream:'invalid'},{type:'command_end',code:'0'},{type:'stage',text:null},{type:'unknown'}])
    assert.throws(()=>c.validateProgress(bad),TypeError);
});
test('executor rejects invalid progress even without a subscriber', async () => {
  const executor=c.defineExecutor({version:1,provider:{id:'codex'},async execute(input) {
    await input.onProgress({type:'invalid'});return result();
  }});
  await assert.rejects(executor.execute({instruction:'ok'}),TypeError);
});
test('contract does not retry exceptions or convert uncertainty to success', async () => {
  let calls=0;
  const adapter={version:1,provider:{id:'codex'},async execute(){calls++;throw Error('transport');}};
  await assert.rejects(c.defineExecutor(adapter).execute({instruction:'ok'}),/transport/);
  assert.equal(calls,1);
  adapter.execute=async()=>result('uncertain');
  assert.equal((await c.defineExecutor(adapter).execute({instruction:'ok'})).status,'uncertain');
});
test('executor checks version/provider, remains immutable, and rejects provider mismatch', async () => {
  assert.throws(()=>c.defineExecutor({version:2,provider:{id:'codex'},execute(){}}),TypeError);
  assert.throws(()=>c.defineExecutor({version:1,provider:{id:'codex'}}),TypeError);
  const e=c.defineExecutor({version:1,provider:{id:'local'},async execute(){return result();}});
  assert.ok(Object.isFrozen(e));assert.ok(Object.isFrozen(e.provider));
  await assert.rejects(e.execute({instruction:'ok'}),TypeError);
});
