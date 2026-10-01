#!/usr/bin/env python3
"""Read-only project diagnosis; optional separate disposable Git exercise.
Never stages project files, changes permissions, or connects to a remote.
"""
import argparse
import hashlib
import os
from pathlib import Path
import stat
import subprocess
import tempfile


def run_git(args, cwd, env):
    result = subprocess.run(['git', *args], cwd=cwd, env=env, capture_output=True, text=True, timeout=20)
    if result.returncode:
        raise RuntimeError('Git operation failed: '+args[0]+' (output suppressed)')
    return result.stdout.strip()


def isolated():
    with tempfile.TemporaryDirectory(prefix='bridge-git-validation-') as folder:
        base = Path(folder)
        home = base/'home'; home.mkdir()
        repo = base/'fixture'; repo.mkdir()
        env = {k: os.environ[k] for k in ('PATH','TMPDIR','LD_LIBRARY_PATH','SYSTEMROOT') if k in os.environ}
        env.update(HOME=str(home), GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull,
                   GIT_TERMINAL_PROMPT='0', GIT_OPTIONAL_LOCKS='0')
        git = lambda *args: run_git(list(args), repo, env)
        git('init', '--quiet')
        (repo/'fixture.txt').write_text('Git diagnostic fixture only.\n')
        git('status', '--porcelain')
        git('add', '--', 'fixture.txt')
        git('-c','user.name=Bridge diagnostic','-c','user.email=diagnostic@example.invalid',
            '-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null','commit','--quiet','-m','Isolated Git write validation')
        git('branch','validation')
        commit = git('log','-1','--format=%H')
        assert git('status','--porcelain') == ''
        assert git('rev-parse','validation') == commit
        assert git('remote') == ''
        return commit


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--isolated',action='store_true')
    args=parser.parse_args()
    root=Path(__file__).resolve().parent.parent
    index=root/'.git/index'
    before=hashlib.sha256(index.read_bytes()).hexdigest() if index.is_file() else None
    print('process uid/gid:',os.getuid(),os.getgid())
    for name in ('.git','.git/index','.git/objects','.git/refs'):
        p=root/name
        if not p.exists(): continue
        s=p.stat()
        print(name,'mode',oct(stat.S_IMODE(s.st_mode)),'uid/gid',s.st_uid,s.st_gid,'Unix W_OK',os.access(p,os.W_OK))
    env={**os.environ,'GIT_OPTIONAL_LOCKS':'0','GIT_TERMINAL_PROMPT':'0'}
    for command in [['status','--porcelain'],['branch','--show-current'],['log','-1','--format=%H']]:
        run_git(command,root,env)
        print('Project read:',command[0],'OK')
    print('Effective sandbox authorization must be checked separately; Unix W_OK is not permission to bypass it.')
    if args.isolated:
        print('Isolated status/add/commit/branch/log PASS; disposable commit:',isolated())
        print('Temporary fixture removed; project Git write access remains unverified.')
    after=hashlib.sha256(index.read_bytes()).hexdigest() if index.is_file() else None
    if before!=after: raise RuntimeError('Project index changed concurrently; inspect before proceeding')
    print('Project index unchanged. No push.')


if __name__=='__main__': main()
