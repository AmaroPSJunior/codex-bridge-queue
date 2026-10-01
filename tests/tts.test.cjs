const {test}=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process');
const {speechText,createSpeaker}=require('../task-tts');
const {harness}=require('./harness.cjs');
const uuid='12345678-1234-1234-1234-123456789abc';
test('TTS success starts with human number/title before answer',()=>{
 assert.equal(speechText({task_number:7,title:'Revisar testes',id:uuid},{status:'completed',answer:'Tudo certo.'}),'Tarefa 7 — Revisar testes foi finalizada com sucesso.\n\nTudo certo.');
});
test('TTS failure begins with human label and clear error summary',()=>{
 assert.equal(speechText({task_number:8,title:'Consultar fila'},{status:'failed',error:'timeout'}),'Tarefa 8 — Consultar fila foi finalizada com falha.\n\nO tempo de espera terminou. O trabalho pode continuar; confira o estado antes de reenviar.');
});
test('TTS legacy never uses UUID or instruction as task name',()=>{
 const text=speechText({id:uuid,instruction:'private instruction'},{status:'completed',answer:'Resposta '+uuid});
 assert.ok(text.startsWith('Tarefa legada — Tarefa sem título foi finalizada com sucesso.'));
 assert.ok(!text.includes(uuid));assert.ok(!text.includes('private instruction'));
});
test('TTS uses GitHub issue number and cleans technical IDs in titles',()=>{
 assert.ok(speechText({transport:'github',issue:12,title:'Analisar '+uuid},{status:'done',result:'Pronto'}).startsWith('Tarefa 12 — Analisar foi finalizada com sucesso.'));
});
test('TTS redacts known credentials and does not read raw error bodies',()=>{
 const env={CODEX_SUPABASE_SERVICE_ROLE_KEY:'synthetic-private-value'};
 const text=speechText({task_number:1,title:'synthetic-private-value'},{status:'succeeded',answer:'synthetic-private-value'},env);
 assert.ok(!text.includes(env.CODEX_SUPABASE_SERVICE_ROLE_KEY));
 assert.ok(!speechText({},{status:'failed',error:'raw secret backend stacktrace'}).includes('raw secret'));
});
test('TTS sends complete text through actual child stdin without shell or secret environment',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-tts-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const receiver=path.join(dir,'receiver.cjs'),capture=path.join(dir,'capture');
 fs.writeFileSync(receiver,"let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>require('fs').writeFileSync(process.env.HOME+'/capture',JSON.stringify({text:s,key:process.env.CODEX_SUPABASE_SERVICE_ROLE_KEY||null})));\n");
 let observed;
 const speaker=createSpeaker({env:{HOME:dir,CODEX_SUPABASE_SERVICE_ROLE_KEY:'synthetic-only'},spawn:(command,args,opts)=>{observed={command,args,opts};return spawn(process.execPath,[receiver],opts);}});
 await speaker({task_number:3,title:'Conferir ponte'},{status:'completed',answer:'Resposta original.'});
 const result=JSON.parse(fs.readFileSync(capture,'utf8'));
 assert.equal(observed.command,'termux-tts-speak');assert.equal(observed.opts.shell,false);assert.equal(result.key,null);
 assert.equal(result.text,'Tarefa 3 — Conferir ponte foi finalizada com sucesso.\n\nResposta original.');
 assert.ok(!observed.args.includes('Resposta original.'));
});
test('TTS missing service does not reject task or leak error',async()=>{
 const speaker=createSpeaker({spawn:()=>{throw Error('service missing');}});
 await assert.doesNotReject(speaker({},{status:'completed',answer:'OK'}));
});
test('TTS timeout kills only its speech child and clears timer',async()=>{
 let fn,cancelled=false,killed=false;const child=new EventEmitter();child.stdin=new EventEmitter();child.stdin.end=()=>{};child.kill=()=>{killed=true;};
 const speaker=createSpeaker({spawn:()=>child,setTimeout:f=>{fn=f;return 1;},clearTimeout:()=>{cancelled=true;}});
 const result=speaker({},{status:'completed',answer:'OK'});fn();await result;assert.ok(killed&&cancelled);
});
test('Supabase passes claimed human metadata to bridge environment',async t=>{
 const h=harness(t,'supabase-worker.js');const pending=h.run("execute('hello',{id:'uuid',task_number:17,title:'Título da fila'})");
 const c=h.calls[0];assert.equal(c.opts.env.CODEX_BRIDGE_TASK_NUMBER,'17');assert.equal(c.opts.env.CODEX_BRIDGE_TASK_TITLE,'Título da fila');assert.equal(c.opts.env.CODEX_BRIDGE_TASK_TRANSPORT,'supabase');
 c.child.emit('close',0);await pending;
});
