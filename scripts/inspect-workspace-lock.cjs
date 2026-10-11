#!/usr/bin/env node
'use strict';
// Read-only lock report: never removes owner.json, kills processes or claims a lease.
const fs=require('node:fs');
const path=require('node:path');
const root=fs.realpathSync(process.argv[2]||process.cwd());
const dir=path.join(root,'.bridge-workspace-lock');
const owner=path.join(dir,'owner.json');
function report(){
 if(!fs.existsSync(dir))return {state:'absent',next:'Workspace lock is absent; this does not prove remote sessions finished'};
 const ds=fs.lstatSync(dir);
 if(!ds.isDirectory()||ds.isSymbolicLink()||ds.uid!==process.getuid()||(ds.mode&0o777)!==0o700)throw Error('unsafe directory metadata');
 const fd=fs.openSync(owner,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{
  const s=fs.fstatSync(fd);
  if(!s.isFile()||s.uid!==process.getuid()||(s.mode&0o777)!==0o600||s.size>1024)throw Error('unsafe owner metadata');
  const o=JSON.parse(fs.readFileSync(fd,'utf8'));
  if(o.version!==1||!['active','uncertain'].includes(o.state)||!Number.isSafeInteger(o.pid)||o.pid<=0||typeof o.token!=='string')throw Error('invalid owner record');
  let pidObservation='unknown';
  try{process.kill(o.pid,0);pidObservation='present-or-inaccessible';}
  catch(e){if(e.code==='ESRCH')pidObservation='not-found';else if(e.code==='EPERM')pidObservation='inaccessible';}
  return {state:o.state,ownerPid:o.pid,pidObservation,next:'Do not clear based on PID alone. Verify detached Codex sessions, Git worktree changes and remote turn acknowledgement before authorized recovery.'};
 }finally{fs.closeSync(fd);}
}
try{console.log(JSON.stringify(report(),null,2));}catch(e){console.error('LOCK_INSPECTION_FAILED: '+e.message);process.exitCode=2;}
