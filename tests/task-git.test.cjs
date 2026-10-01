const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');

const {
  inspectRepository,
  commitTaskChanges,
  commitMessage,
  sensitivePath
}=require('../task-git');

function git(cwd,...args){
  const r=spawnSync('git',args,{cwd,encoding:'utf8'});
  if(r.status!==0)throw new Error(r.stderr||`git ${args[0]} failed`);
  return r.stdout.trim();
}

function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'task-git-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));

  git(dir,'init');
  git(dir,'config','user.name','Bridge Test');
  git(dir,'config','user.email','bridge@example.test');

  fs.writeFileSync(path.join(dir,'tracked.txt'),'base\n');
  git(dir,'add','tracked.txt');
  git(dir,'commit','-m','base');

  return dir;
}

test('commit message uses task number and safe one-line title',()=>{
  assert.equal(
    commitMessage({task_number:12,title:'  Ajustar\n progresso  '}),
    'task(12): Ajustar progresso'
  );
});

test('changed files produce exactly one task commit',async t=>{
  const dir=fixture(t);
  const before=await inspectRepository({cwd:dir});

  fs.writeFileSync(path.join(dir,'tracked.txt'),'changed\n');

  const result=await commitTaskChanges({
    cwd:dir,
    task:{task_number:21,title:'Alterar arquivo'},
    before,
    enabled:true
  });

  assert.equal(result.status,'committed');
  assert.match(result.commit_sha,/^[0-9a-f]{40}$/);
  assert.deepEqual(result.files,['tracked.txt']);
  assert.equal(git(dir,'rev-list','--count',`${before.head}..HEAD`),'1');
  assert.equal(git(dir,'log','-1','--pretty=%s'),'task(21): Alterar arquivo');
});

test('clean task creates no empty commit',async t=>{
  const dir=fixture(t);
  const before=await inspectRepository({cwd:dir});

  const result=await commitTaskChanges({
    cwd:dir,
    task:{task_number:22,title:'Sem mudanças'},
    before,
    enabled:true
  });

  assert.equal(result.status,'no_changes');
  assert.equal(result.commit_sha,null);
  assert.equal(git(dir,'rev-parse','HEAD'),before.head);
});

test('dirty repository at task start is never auto committed',async t=>{
  const dir=fixture(t);
  fs.writeFileSync(path.join(dir,'tracked.txt'),'preexisting\n');

  const before=await inspectRepository({cwd:dir});
  assert.equal(before.clean,false);

  fs.writeFileSync(path.join(dir,'other.txt'),'task change\n');

  const result=await commitTaskChanges({
    cwd:dir,
    task:{task_number:23,title:'Não capturar alterações antigas'},
    before,
    enabled:true
  });

  assert.equal(result.status,'dirty_start');
  assert.equal(result.commit_sha,null);
  assert.equal(git(dir,'rev-parse','HEAD'),before.head);
});

test('disabled mode never creates commit',async t=>{
  const dir=fixture(t);
  const before=await inspectRepository({cwd:dir});
  fs.writeFileSync(path.join(dir,'tracked.txt'),'changed\n');

  const result=await commitTaskChanges({
    cwd:dir,
    task:{task_number:24,title:'Desabilitada'},
    before,
    enabled:false
  });

  assert.equal(result.status,'disabled');
  assert.equal(git(dir,'rev-parse','HEAD'),before.head);
});

test('commit failure is surfaced and does not claim success',async t=>{
  const dir=fixture(t);
  const before=await inspectRepository({cwd:dir});
  fs.writeFileSync(path.join(dir,'tracked.txt'),'changed\n');

  git(dir,'config','user.name','');
  git(dir,'config','user.email','');

  await assert.rejects(
    commitTaskChanges({
      cwd:dir,
      task:{task_number:25,title:'Falha esperada'},
      before,
      enabled:true
    }),
    /git commit failed/
  );

  assert.equal(git(dir,'rev-parse','HEAD'),before.head);
});

test('multiple tasks create one commit each',async t=>{
  const dir=fixture(t);

  let before=await inspectRepository({cwd:dir});
  fs.writeFileSync(path.join(dir,'tracked.txt'),'task one\n');
  const first=await commitTaskChanges({
    cwd:dir,
    task:{task_number:26,title:'Primeira'},
    before,
    enabled:true
  });

  before=await inspectRepository({cwd:dir});
  fs.writeFileSync(path.join(dir,'tracked.txt'),'task two\n');
  const second=await commitTaskChanges({
    cwd:dir,
    task:{task_number:27,title:'Segunda'},
    before,
    enabled:true
  });

  assert.equal(first.status,'committed');
  assert.equal(second.status,'committed');
  assert.notEqual(first.commit_sha,second.commit_sha);
  assert.equal(git(dir,'rev-list','--count',`${first.commit_sha}..${second.commit_sha}`),'1');
});

test('module never invokes git push',async t=>{
  const dir=fixture(t);
  const before=await inspectRepository({cwd:dir});
  fs.writeFileSync(path.join(dir,'tracked.txt'),'changed\n');

  await commitTaskChanges({
    cwd:dir,
    task:{task_number:28,title:'Sem push'},
    before,
    enabled:true
  });

  assert.equal(git(dir,'remote').trim(),'');
});

test('sensitive files are blocked and unstaged',async t=>{const dir=fixture(t);const before=await inspectRepository({cwd:dir});fs.writeFileSync(path.join(dir,'.env'),'SECRET=value\n');await assert.rejects(commitTaskChanges({cwd:dir,task:{task_number:29,title:'Segredo'},before,enabled:true}),/Sensitive path blocked/);assert.equal(git(dir,'diff','--cached','--name-only'),'');assert.equal(git(dir,'rev-parse','HEAD'),before.head);assert.equal(sensitivePath('.env'),true);});
test('commit failure leaves nothing staged',async t=>{const dir=fixture(t);const before=await inspectRepository({cwd:dir});fs.writeFileSync(path.join(dir,'tracked.txt'),'changed\n');git(dir,'config','user.name','');git(dir,'config','user.email','');await assert.rejects(commitTaskChanges({cwd:dir,task:{task_number:30,title:'Falha'},before,enabled:true}),/git commit failed/);assert.equal(git(dir,'diff','--cached','--name-only'),'');});
