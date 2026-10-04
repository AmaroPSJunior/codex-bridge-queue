#!/usr/bin/env node
'use strict';
const {createGroqExecutor}=require('../executors/groq');
(async()=>{
 try{
  const status=await createGroqExecutor().healthCheck();
  console.log(JSON.stringify(status));if(!status.healthy)process.exitCode=1;
 }catch{console.error('Configuração Groq ausente ou inválida. Verifique o ambiente privado do processo.');process.exitCode=1;}
})();
