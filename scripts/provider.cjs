#!/usr/bin/env node
'use strict';
const {PROVIDERS,IMPLEMENTED,writeDefault,readDefault,selectProvider}=require('../executors/provider-config');
try{
  const args=process.argv.slice(2);
  if(args.length===1&&args[0]==='show'){
    const selected=selectProvider();
    console.log(JSON.stringify({...selected,persisted:readDefault(process.env.HOME),implemented:IMPLEMENTED.includes(selected.provider)}));
  }else if(args.length===2&&args[0]==='set'){
    writeDefault(process.env.HOME,args[1]);
    console.log(JSON.stringify({saved:args[1],implemented:IMPLEMENTED.includes(args[1]),note:'Aplicado às próximas tarefas; AI_PROVIDER e override da tarefa têm prioridade. Nenhum processo reiniciado.'}));
  }else if(args.length===1&&args[0]==='list'){
    console.log(JSON.stringify(PROVIDERS.map(provider=>({provider,implemented:IMPLEMENTED.includes(provider)}))));
  }else throw Error('usage');
}catch(e){
  const safe=new Set(['PROVIDER_INVALID','PROVIDER_HOME_INVALID','PROVIDER_CONFIG_UNSAFE','PROVIDER_CONFIG_INVALID']);
  console.error(safe.has(e.code)?e.code:'Falha na configuração. Uso: npm run provider -- show|list|set <provider>. Verifique permissões e configuração.');
  process.exitCode=1;
}
