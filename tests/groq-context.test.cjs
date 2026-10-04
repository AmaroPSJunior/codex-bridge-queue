'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {LIMITS,bytes,bounded,prepare}=require('../executors/groq-context');
const base={model:'openai/gpt-oss-20b',tools:[{type:'function',function:{name:'read_file'}}]};
const initial=()=>[{role:'system',content:'SEGURANÇA: não acesse fora da raiz.'},{role:'user',content:'Instrução integral.'}];
function batch(i,text){return [{role:'assistant',content:null,tool_calls:[{id:'call'+i,type:'function',function:{name:'read_file',arguments:'{"path":"example"}'}}]},{role:'tool',tool_call_id:'call'+i,content:text}];}
test('bounded conta JSON UTF8, preserva extremos e marca truncamento',()=>{
 const text='INÍCIO\n'+('á😀"\\\n'.repeat(1000))+'\nFIM';const out=bounded(text,LIMITS.tool);assert.ok(bytes(out)<=LIMITS.tool);assert.match(out,/SAÍDA TRUNCADA/);assert.ok(out.startsWith('INÍCIO'));assert.ok(out.endsWith('FIM'));assert.ok(!out.includes('\ufffd'));assert.equal(bounded('curto',LIMITS.tool),'curto');
});
test('crescimento fica limitado e compactação preserva pares, instrução e tools',()=>{
 const messages=initial();let largest=0;for(let i=0;i<24;i++){messages.push(...batch(i,bounded('linha de teste\n'.repeat(500),LIMITS.tool)));const p=prepare(messages,base,true),parsed=JSON.parse(p.body);largest=Math.max(largest,p.metrics.bytes);assert.ok(p.metrics.bytes<=LIMITS.payload);assert.equal(p.metrics.bytes,Buffer.byteLength(p.body));assert.deepEqual(parsed.messages.slice(0,2),initial());assert.deepEqual(parsed.tools,base.tools);for(const [n,m] of parsed.messages.entries())if(m.role==='tool')assert.equal(parsed.messages[n-1].tool_calls[0].id,m.tool_call_id);assert.ok(messages.filter(m=>m.role==='assistant').length<=2);assert.equal(parsed.messages.at(-1).tool_call_id,'call'+i);}
 assert.ok(largest>2000);
});
test('instrução ou argumentos atuais grandes falham sem truncar dados críticos',()=>{
 const messages=initial();messages[1].content='x'.repeat(LIMITS.instruction+1);assert.throws(()=>prepare(messages,base,false),e=>e.kind==='payload_too_large');assert.equal(messages[1].content.length,LIMITS.instruction+1);
 const other=initial();other.push(...batch(1,'OK'));other[2].tool_calls[0].function.arguments=JSON.stringify({content:'x'.repeat(LIMITS.payload)});const original=other[2].tool_calls[0].function.arguments;assert.throws(()=>prepare(other,base,false),e=>e.kind==='payload_too_large');assert.equal(other[2].tool_calls[0].function.arguments,original);
});
test('métricas não incluem conteúdo e medem payload anterior reproduzível',()=>{
 const messages=initial();messages.push(...batch(1,'linha de teste\n'.repeat(14000)));const original=bytes({...base,messages});messages[3].content=bounded(messages[3].content,LIMITS.tool);const p=prepare(messages,base,true);assert.ok(original>180000);assert.ok(p.metrics.bytes<4096);for(const [k,v] of Object.entries(p.metrics))assert.ok(k==='event'||typeof v==='number');assert.ok(!JSON.stringify(p.metrics).includes('Instrução'));console.log(JSON.stringify({synthetic_before_bytes:original,after_bytes:p.metrics.bytes}));
});
