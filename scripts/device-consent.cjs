#!/usr/bin/env node
'use strict';
const store=require('../integrations/device-consent/store.cjs');
if(process.argv[2]==='serve'){
 try{const {createServer}=require('../integrations/device-consent/server.cjs');const server=createServer({home:process.env.HOME});server.on('error',()=>{console.error('Emissor indisponível; verifique configuração/porta.');process.exitCode=1;});server.listen(8790,'127.0.0.1',()=>console.log('Consentimento local: http://127.0.0.1:8790 (usuário owner).'));}catch{console.error('Configuração privada ausente ou inválida. Execute setup presencialmente.');process.exitCode=1;}
}else if(process.argv[2]==='setup'){
 if(!process.stdin.isTTY||!process.stdout.isTTY){console.error('Setup exige terminal presencial; não fornecer senha em argumentos/env.');process.exitCode=1;}
 else{
  let password='';process.stdout.write('Nova senha exclusiva (mínimo 16 caracteres, entrada oculta): ');process.stdin.setRawMode(true);process.stdin.resume();
  process.stdin.on('data',chunk=>{for(const c of chunk.toString()){
   if(c==='\u0003'){process.stdin.setRawMode(false);process.exit(1);}
   if(c==='\r'||c==='\n'){process.stdin.setRawMode(false);process.stdin.pause();try{store.setup(process.env.HOME,password);console.log('\nConfiguração privada criada; nenhuma ação autorizada.');}catch{console.error('\nSetup recusado: senha curta, configuração existente ou permissões inseguras.');process.exitCode=1;}return;}
   if(c==='\u007f')password=password.slice(0,-1);else if(c>=' '&&password.length<256)password+=c;
  }});
 }
}else{console.error('Uso: node scripts/device-consent.cjs setup|serve');process.exitCode=1;}
