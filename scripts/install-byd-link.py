#!/usr/bin/env python3
"""Explicit local transport installer. No queue credentials or worker state are changed."""
import datetime
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys

SOURCE = Path(__file__).resolve().parent.parent
ENV = {k: v for k, v in os.environ.items() if k != 'LD_LIBRARY_PATH'}


def install_phone():
    home = Path.home()
    stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    backup = home / '.local/state/byd-link/backups' / stamp
    backup.mkdir(mode=0o700, parents=True)
    targets = [home / '.ssh/config', home / '.bashrc',
               home / '.local/bin/central', home / '.config/byd-link/config.json',
               home / '.local/share/byd-link/central.py']
    for n, target in enumerate(targets):
        if target.exists():
            shutil.copy2(target, backup / (str(n) + '-' + target.name))
    config = {'initial_ip': '10.51.86.181', 'adb_serial': '808ca340',
              'host_key_alias': '[10.48.199.181]:8022'}
    directory = home / '.config/byd-link'
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    file = directory / 'config.json'
    file.write_text(json.dumps(config) + '\n')
    file.chmod(0o600)
    directory = home / '.local/share/byd-link'
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    shutil.copy2(SOURCE / 'scripts/byd-link.py', directory / 'central.py')
    binary = home / '.local/bin/central'
    binary.parent.mkdir(parents=True, exist_ok=True)
    binary.write_text('#!/data/data/com.termux/files/usr/bin/sh\nunset LD_LIBRARY_PATH\nexec python3 "$HOME/.local/share/byd-link/central.py" "$@"\n')
    binary.chmod(0o700)
    ssh = home / '.ssh/config'
    old = ssh.read_text()
    # A first-match block makes the pinned key independent of DHCP changes.
    block = ('# BEGIN BYD-LINK\nHost byd-central\n'
             '    HostKeyAlias [10.48.199.181]:8022\n'
             '    ProxyCommand /data/data/com.termux/files/usr/bin/python3 '
             + str(directory / 'central.py') + ' proxy\n# END BYD-LINK\n')
    if '# BEGIN BYD-LINK\n' in old:
        start = old.index('# BEGIN BYD-LINK\n')
        end = old.index('# END BYD-LINK\n', start) + len('# END BYD-LINK\n')
        old = old[:start] + old[end:]
    ssh.write_text(block + old)
    ssh.chmod(0o600)
    bashrc = home / '.bashrc'
    old = bashrc.read_text()
    line = 'alias central=\'"$HOME/.local/bin/central"\''
    import re
    old, count = re.subn(r'^alias central=.*$', lambda _: line, old, flags=re.M)
    if not count:
        old += '\n' + line + '\n'
    bashrc.write_text(old)
    print('PHONE_INSTALLED backup=' + str(backup))


def install_central():
    files = {'service.py': (SOURCE / 'scripts/byd-link-service.py').read_text(),
             '10-byd-link': (SOURCE / 'autostart/10-byd-link').read_text()}
    code = '''
import datetime,json,os,pathlib,shutil,sys
os.umask(0o077)
h=pathlib.Path.home()
b=h/'.local/state/byd-link/backups'/datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f')
b.mkdir(parents=True)
files=json.load(sys.stdin)
for n,p in enumerate([h/'.termux/boot/20-codex-bridge',h/'.termux/boot/10-byd-link',h/'.local/share/byd-link/service.py']):
 if p.exists(): shutil.copy2(p,b/(str(n)+'-'+p.name))
for name,target in [('service.py',h/'.local/share/byd-link/service.py'),('10-byd-link',h/'.termux/boot/10-byd-link')]:
 target.parent.mkdir(parents=True,exist_ok=True)
 target.write_text(files[name]); target.chmod(0o700)
print('CENTRAL_INSTALLED backup='+str(b))
'''
    args = ['ssh', '-o', 'ProxyCommand=none', '-o', 'HostName=10.51.86.181',
            '-o', 'HostKeyAlias=[10.48.199.181]:8022', 'byd-central',
            'python3 -c ' + shlex.quote(code)]
    subprocess.run(args, env=ENV, input=json.dumps(files), text=True, check=True)
    subprocess.run(args[:-1] + [
        'nohup sh "$HOME/.termux/boot/10-byd-link" >/dev/null 2>&1 </dev/null &'
    ], env=ENV, check=True)


if __name__ == '__main__':
    os.umask(0o077)
    if sys.argv[1:] == ['phone']:
        install_phone()
    elif sys.argv[1:] == ['central']:
        install_central()
    else:
        sys.exit('Usage: install-byd-link.py phone|central')
