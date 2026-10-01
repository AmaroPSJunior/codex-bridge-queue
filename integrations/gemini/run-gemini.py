#!/usr/bin/env python3
"""Launch Gemini without inheriting the bridge's privileged service credential."""
import os
import shutil
import sys


def environment(source):
    return {name:value for name,value in source.items()
            if name not in ('CODEX_SUPABASE_SERVICE_ROLE_KEY','SUPABASE_SERVICE_ROLE_KEY','SUPABASE_SECRET_KEY')}


def main():
    executable=shutil.which('gemini')
    if not executable:
        print('Gemini CLI não encontrado. Instale e autentique o cliente conforme a documentação oficial.',file=sys.stderr)
        return 1
    os.execve(executable,[executable,*sys.argv[1:]],environment(os.environ))


if __name__=='__main__':
    sys.exit(main())
