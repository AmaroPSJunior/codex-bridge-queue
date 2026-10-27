#!/usr/bin/env python3
"""Explicit local transport installer. No queue credentials or worker state are changed."""
import datetime
import ipaddress
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys

SOURCE = Path(__file__).resolve().parent.parent
ENV = {k: v for k, v in os.environ.items() if k != 'LD_LIBRARY_PATH'}


def validate_network_config(initial_ip, host_key_alias):
    try:
        address = ipaddress.IPv4Address(initial_ip)
    except ipaddress.AddressValueError as error:
        raise ValueError('Initial address must be a private IPv4 address') from error
    if not any(address in ipaddress.IPv4Network(net) for net in
               ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16')):
        raise ValueError('Initial address must be a private IPv4 address')
    if not re.fullmatch(r'[A-Za-z0-9_.:\[\]-]{1,255}', host_key_alias):
        raise ValueError('Invalid SSH host key alias')


def validate_config(initial_ip, adb_serial, host_key_alias):
    validate_network_config(initial_ip, host_key_alias)
    if not re.fullmatch(r'[A-Za-z0-9._:-]{1,128}', adb_serial):
        raise ValueError('Invalid ADB serial')


def install_phone(initial_ip, adb_serial, host_key_alias):
    validate_config(initial_ip, adb_serial, host_key_alias)
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
    config = {'initial_ip': initial_ip, 'adb_serial': adb_serial,
              'host_key_alias': host_key_alias}
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
             f'    HostKeyAlias {host_key_alias}\n'
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


def install_central(initial_ip, host_key_alias):
    validate_network_config(initial_ip, host_key_alias)
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
    args = ['ssh', '-o', 'ProxyCommand=none', '-o', f'HostName={initial_ip}',
            '-o', f'HostKeyAlias={host_key_alias}', 'byd-central',
            'python3 -c ' + shlex.quote(code)]
    subprocess.run(args, env=ENV, input=json.dumps(files), text=True, check=True)
    subprocess.run(args[:-1] + [
        'nohup sh "$HOME/.termux/boot/10-byd-link" >/dev/null 2>&1 </dev/null &'
    ], env=ENV, check=True)


if __name__ == '__main__':
    os.umask(0o077)
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest='target', required=True)
    phone = subparsers.add_parser('phone', help='install the phone-side client')
    phone.add_argument('--initial-ip', required=True)
    phone.add_argument('--adb-serial', required=True)
    phone.add_argument('--host-key-alias', required=True)
    central = subparsers.add_parser('central', help='install the central-side service')
    central.add_argument('--initial-ip', required=True)
    central.add_argument('--host-key-alias', required=True)
    options = parser.parse_args()
    try:
        if options.target == 'phone':
            install_phone(options.initial_ip, options.adb_serial, options.host_key_alias)
        else:
            install_central(options.initial_ip, options.host_key_alias)
    except ValueError as error:
        parser.error(str(error))
