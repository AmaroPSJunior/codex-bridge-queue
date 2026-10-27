'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {validate}=require('../executors/command');

test('read-only diagnostic commands are permitted without an AI intermediary',()=>{
 for(const [command,args] of [
  ['pwd',[]],['ls',['-la']],['git',['status','--short']],
  ['git',['rev-parse','HEAD']],['git',['log','-1','--oneline']],
  ['node',['--version']],['npm',['--version']],['python3',['--version']],
  ['python3',['watchdog/watchdog.py','--once']],
  ['python3',['watchdog/watchdog.py','--publish']],
  ['python3',['watchdog/watchdog.py','--status']]
 ]) assert.equal(validate({command,args,cwd:'.'}).command,command);
});

test('mutations, arbitrary scripts and shell expansion remain blocked',()=>{
 for(const [command,args] of [
  ['git',['push']],['git',['reset','--hard']],['git',['status','--porcelain=v2']],
  ['node',['-e','process.exit(0)']],['python3',['-c','print(1)']],
  ['python3',['watchdog/watchdog.py','--apply']],
  ['python3',['watchdog/watchdog.py','--daemon']],
  ['python3',['watchdog/watchdog.py','--serve']],
  ['python3',['watchdog/watchdog.py','--apply','--once']],
  ['npm',['install']],['sh',['-c','pwd']],['ls',['-la','/']]
 ]) assert.throws(()=>validate({command,args,cwd:'.'}),/recusados/);
});
