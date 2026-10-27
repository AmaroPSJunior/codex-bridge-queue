#!/usr/bin/env python3
"""Phone-side BYD transport. Discovery is untrusted; SSH always checks the pinned key."""
import concurrent.futures
import ipaddress
import json
import os
from pathlib import Path
import secrets
import select
import shlex
import socket
import subprocess
import sys
import time

ENV = {k: v for k, v in os.environ.items() if k != 'LD_LIBRARY_PATH'}
ROOT = Path.home() / '.config/byd-link'
PORT = 48022


def private_ip(value):
    try:
        ip = ipaddress.IPv4Address(value)
        return ip.is_private and not (ip.is_loopback or ip.is_link_local or ip.is_unspecified)
    except ipaddress.AddressValueError:
        return False


def run(args, timeout=12):
    return subprocess.run(args, env=ENV, capture_output=True, text=True, timeout=timeout)


def ssh_args(config, ip):
    if not private_ip(ip):
        raise ValueError('Destination must be a private IPv4 address')
    return ['ssh', '-o', 'ProxyCommand=none', '-o', f'HostName={ip}',
            '-o', f'HostKeyAlias={config["host_key_alias"]}',
            '-o', 'StrictHostKeyChecking=yes', '-o', 'BatchMode=yes',
            '-o', 'ConnectTimeout=4', '-o', 'ServerAliveInterval=15',
            '-o', 'ServerAliveCountMax=2', 'byd-central']


def authenticated(config, ip):
    try:
        result = run(ssh_args(config, ip) + ['printf BYD_LINK_OK'], timeout=7)
        return result.returncode == 0 and result.stdout == 'BYD_LINK_OK'
    except (OSError, subprocess.TimeoutExpired, ValueError):
        return False


def udp_candidates(seconds=3):
    nonce = secrets.token_hex(16)
    request = json.dumps({'service': 'byd-link-v1', 'nonce': nonce}).encode()
    found = set()
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        sock.bind(('0.0.0.0', 0))
        sock.settimeout(0.3)
        deadline = time.monotonic() + seconds
        next_send = 0
        while time.monotonic() < deadline:
            if time.monotonic() >= next_send:
                sock.sendto(request, ('255.255.255.255', PORT))
                next_send = time.monotonic() + 0.7
            try:
                data, addr = sock.recvfrom(512)
                reply = json.loads(data)
                if (reply.get('service') == 'byd-link-v1' and reply.get('nonce') == nonce
                        and private_ip(addr[0])):
                    found.add(addr[0])
            except (socket.timeout, ValueError, UnicodeError, AttributeError):
                pass
    return sorted(found)


def adb_candidates(config):
    found = []
    try:
        result = run(['adb', 'devices'], timeout=5)
        for line in result.stdout.splitlines()[1:]:
            fields = line.split()
            if len(fields) < 2 or fields[1] != 'device':
                continue
            target = fields[0]
            ip, sep, port = target.rpartition(':')
            if not sep or port != '5555' or not private_ip(ip):
                continue
            serial = run(['adb', '-s', target, 'shell', 'getprop', 'ro.serialno'], 5)
            if serial.returncode == 0 and serial.stdout.strip() == config['adb_serial']:
                found.append(ip)
    except (OSError, subprocess.TimeoutExpired):
        pass
    return found


def discover(config, fresh=False):
    if not fresh:
        try:
            cached = (ROOT / 'last-ip').read_text().strip()
        except OSError:
            cached = config['initial_ip']
        if authenticated(config, cached):
            return cached
    candidates = udp_candidates()
    candidates.extend(ip for ip in adb_candidates(config) if ip not in candidates)
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        results = pool.map(lambda ip: (ip, authenticated(config, ip)), candidates)
        for ip, valid in results:
            if valid:
                ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
                temp = ROOT / ('last-ip.' + secrets.token_hex(6))
                temp.write_text(ip + '\n')
                temp.chmod(0o600)
                temp.replace(ROOT / 'last-ip')
                return ip
    raise RuntimeError('Central not found with its pinned SSH key. Check same Wi-Fi and Termux service.')


def proxy(ip):
    # OpenSSH performs host authentication over this byte stream.
    with socket.create_connection((ip, 8022), timeout=6) as sock:
        sock.settimeout(None)
        inputs = [sys.stdin.buffer, sock]
        while inputs:
            ready, _, _ = select.select(inputs, [], [], 45)
            for stream in ready:
                data = os.read(stream.fileno(), 65536)
                if not data:
                    if stream is sock:
                        return
                    inputs.remove(stream)
                    sock.shutdown(socket.SHUT_WR)
                elif stream is sock:
                    sys.stdout.buffer.write(data)
                    sys.stdout.buffer.flush()
                else:
                    sock.sendall(data)


def codex_command(args):
    cwd = '~/codebridge-device'
    if args[:1] == ['--cwd']:
        if len(args) < 3:
            raise ValueError('Usage: central codex [--cwd PATH] PROMPT')
        cwd, args = args[1], args[2:]
    if cwd.startswith('~/'):
        parts = cwd[2:].split('/')
        if any(p in ('', '.', '..') for p in parts):
            raise ValueError('Unsafe workspace path')
        directory = '"$HOME"/' + shlex.quote(cwd[2:])
    elif cwd.startswith('/'):
        directory = shlex.quote(cwd)
    else:
        raise ValueError('Workspace must be absolute or start with ~/')
    if not args:
        raise ValueError('Provide a prompt')
    # All central CLI jobs share a lock. Never retry a job after uncertain delivery.
    command = (f'cd -- {directory} && mkdir -p "$HOME/.local/state/byd-link" && '
               'exec flock -n -E 75 "$HOME/.local/state/byd-link/codex.lock" '
               'codex exec --sandbox workspace-write -')
    return command, ' '.join(args)


def main(argv=None):
    args = list(sys.argv[1:] if argv is None else argv)
    if args[:1] in (['--help'], ['help']):
        print('central [SSH_COMMAND] | adb [ADB_ARGS] | ip [--fresh] | doctor | codex [--cwd PATH] PROMPT')
        return 0
    config = json.loads((ROOT / 'config.json').read_text())
    mode = args[0] if args else 'ssh'
    ip = discover(config, fresh='--fresh' in args if mode == 'ip' else False)
    if mode == 'ip':
        print(ip)
        return 0
    if mode == 'proxy':
        proxy(ip)
        return 0
    if mode == 'doctor':
        print(json.dumps({'ip': ip, 'ssh_pinned_key': True,
                          'adb_connected_matches': ip in adb_candidates(config)}))
        return subprocess.call(ssh_args(config, ip) + [
            'id; codex --version; python3 "$HOME/.local/share/byd-link/service.py" status'], env=ENV)
    if mode == 'adb':
        target = ip + ':5555'
        result = run(['adb', 'connect', target])
        check = run(['adb', '-s', target, 'shell', 'getprop', 'ro.serialno'])
        if check.returncode or check.stdout.strip() != config['adb_serial']:
            raise RuntimeError('ADB identity mismatch or connection unavailable')
        if len(args) == 1:
            print('ADB_OK ' + target)
            return 0
        return subprocess.call(['adb', '-s', target] + args[1:], env=ENV)
    if mode == 'codex':
        command, prompt = codex_command(args[1:])
        result = subprocess.run(ssh_args(config, ip) + ['-T', command],
                                input=prompt, text=True, env=ENV)
        if result.returncode:
            print('Remote job was not retried. Inspect its state before submitting again.', file=sys.stderr)
        return result.returncode
    return subprocess.call(ssh_args(config, ip) + (args[1:] if mode == 'ssh' else args), env=ENV)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as error:
        print(f'central: {error}', file=sys.stderr)
        sys.exit(1)
