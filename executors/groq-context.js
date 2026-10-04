'use strict';
// Bounds are serialized UTF-8 bytes, not provider tokens or account rate limits.
const LIMITS=Object.freeze({payload:12*1024,instruction:8*1024,tool:2*1024,assistant:1024,exchanges:2});
const bytes=value=>Buffer.byteLength(JSON.stringify(value));
const oversized=()=>Object.assign(new Error('Payload Groq excede o limite local; reduza a instrução ou a ação atual.'),{kind:'payload_too_large'});
function bounded(text,limit){
 if(bytes(text)<=limit)return text;
 const chars=Array.from(text),marker='\n[SAÍDA TRUNCADA: trecho central omitido; consulte read_file com offset/length para ler arquivos por partes.]\n';
 let low=0,high=chars.length;
 const sample=n=>chars.slice(0,Math.ceil(n/2)).join('')+marker+chars.slice(chars.length-Math.floor(n/2)).join('');
 while(low<high){const mid=Math.ceil((low+high)/2);if(bytes(sample(mid))<=limit)low=mid;else high=mid-1;}
 return sample(low);
}
function prepare(messages,base,validated){
 if(bytes(messages[1].content)>LIMITS.instruction)throw oversized();
 // Remove complete oldest assistant/tool exchanges; never leave orphan tool results.
 let dropped=0;
 const starts=()=>messages.reduce((a,m,i)=>{if(i>=2&&m.role==='assistant')a.push(i);return a;},[]);
 const payload=()=>({...base,messages:[...messages.slice(0,2),...(dropped?[{role:'system',content:`Histórico antigo compactado: ${dropped} lotes omitidos. Releia arquivos necessários. Testes após última edição: ${validated?'aprovados':'pendentes'}.`}]:[]),...messages.slice(2)]});
 while(true){const indices=starts();if(indices.length<=1||indices.length<=LIMITS.exchanges&&bytes(payload())<=LIMITS.payload)break;messages.splice(indices[0],indices[1]-indices[0]);dropped++;}
 const body=JSON.stringify(payload());if(Buffer.byteLength(body)>LIMITS.payload)throw oversized();
 return {body,metrics:{event:'groq_payload',bytes:Buffer.byteLength(body),messages:JSON.parse(body).messages.length,tool_result_bytes:messages.filter(m=>m.role==='tool').reduce((n,m)=>n+bytes(m.content),0),tool_schema_bytes:bytes(base.tools),system_bytes:bytes(messages[0].content),instruction_bytes:bytes(messages[1].content),compacted_exchanges:dropped}};
}
module.exports={LIMITS,bytes,bounded,prepare};
