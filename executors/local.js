'use strict';

const {
  createLocalExecutor,
  configFromEnv,
}=require('./local-openai');

function createLocalProviderExecutor({
  env=process.env,
  cwd,
  workspaceToken,
  ...options
}={}){
  const config={
    ...configFromEnv(env),
    ...options,
  };

  const mode=env.LOCAL_AI_MODE||'text';

  if(!['text','agent'].includes(mode))
    throw TypeError('LOCAL_AI_MODE inválido');

  const common={
    ...config,
    env,
    cwd,
    workspaceToken,
    providerId:'local',
  };

  if(mode==='agent'){
    return require('./local-agent').createAgent(common);
  }

  return createLocalExecutor(common);
}

module.exports={
  createLocalProviderExecutor,
};
