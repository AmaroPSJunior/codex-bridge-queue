#!/usr/bin/env node
'use strict';
const path=require('node:path');
const {loadLocal}=require('./client.cjs');
const root=path.resolve(__dirname,'../..');
try{
 loadLocal(root);
 console.log('Configuração local e permissões OK. Nenhuma conexão de rede ou leitura de tarefas realizada.');
 console.log('No terminal, com Gemini CLI já instalado, registre a extensão:');
 const quote=s=>"'"+s.replace(/'/g,"'\"'\"'")+"'";
 console.log('python3 '+quote(path.join(__dirname,'run-gemini.py'))+' extensions link '+quote(__dirname));
 console.log('Informe a pasta do projeto se solicitado; nunca informe a chave. Reinicie apenas a sessão Gemini e use /mcp.');
}catch{console.error('Setup incompleto: confira URL em remote-config.json e credencial privada 0700/0600 em ~/.config/codex-bridge. Não cole a chave no Gemini.');process.exitCode=1;}
