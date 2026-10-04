'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
function receipt(dir,id,payload,metadata=null){
 const folder=path.join(dir,'pending-results');fs.mkdirSync(folder,{recursive:true,mode:0o700});
 if(fs.lstatSync(folder).isSymbolicLink()||(fs.statSync(folder).mode&0o777)!==0o700)throw Error('Unsafe receipt directory');
 const target=path.join(folder,crypto.createHash('sha256').update(String(id)).digest('hex')+'.json');
 const temp=target+'.'+crypto.randomBytes(8).toString('hex');let fd;
 try{fd=fs.openSync(temp,'wx',0o600);fs.writeFileSync(fd,JSON.stringify({id,payload,metadata}));fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(temp,target);}finally{if(fd!==undefined)fs.closeSync(fd);if(fs.existsSync(temp))fs.unlinkSync(temp);}
 return target;
}
module.exports={receipt};
const cursors=new Map();
function pending(dir){
 const folder=path.join(dir,'pending-results');if(!fs.existsSync(folder))return [];
 if(fs.lstatSync(folder).isSymbolicLink()||(fs.statSync(folder).mode&0o777)!==0o700||fs.statSync(folder).uid!==process.getuid())throw Error('Unsafe receipt directory');
 const files=fs.readdirSync(folder).filter(n=>/^[a-f0-9]{64}\.json$/.test(n)).sort();
 const offset=(cursors.get(dir)||0)%Math.max(1,files.length);cursors.set(dir,offset+10);
 return files.slice(offset,offset+10).map(name=>{
  const file=path.join(folder,name),fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try{const s=fs.fstatSync(fd);if(s.uid!==process.getuid()||!s.isFile()||s.size>8*1024*1024||(s.mode&0o777)!==0o600)throw Error('Invalid receipt');
   const r=JSON.parse(fs.readFileSync(fd,'utf8'));if(typeof r.id!=='string'||!r.payload||!['succeeded','failed'].includes(r.payload.status)||crypto.createHash('sha256').update(r.id).digest('hex')+'.json'!==name)throw Error('Invalid receipt');
   if(Object.keys(r.payload).some(k=>!['status','result','error','completed_at','updated_at','git_status','commit_sha','git_files'].includes(k))||typeof r.payload.result!=='string'||!(r.payload.error===null||typeof r.payload.error==='string'))throw Error('Invalid receipt payload');
   return {...r,file};
  }finally{fs.closeSync(fd);}
 });
}
module.exports.pending=pending;
