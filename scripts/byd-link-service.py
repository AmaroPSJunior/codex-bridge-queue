#!/usr/bin/env python3
"""Unprivileged SSH watchdog and LAN discovery responder; never starts queue workers."""
import fcntl
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time

STATE = Path.home() / '.local/state/byd-link'
PORT = 48022


def ssh_alive():
    try:
        with socket.create_connection(('127.0.0.1', 8022), timeout=1) as sock:
            return sock.recv(256).startswith(b'SSH-2.0-')
    except OSError:
        return False


def reply(data):
    try:
        request = json.loads(data)
        nonce = request.get('nonce', '')
        if (request.get('service') != 'byd-link-v1' or not isinstance(nonce, str)
                or len(nonce) != 32 or any(c not in '0123456789abcdef' for c in nonce)):
            return None
        return json.dumps({'service': 'byd-link-v1', 'nonce': nonce}).encode()
    except (ValueError, AttributeError, UnicodeError):
        return None


def main():
    STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (STATE / 'service.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            # A simultaneous status probe holds the lock only briefly. Give it
            # time to release before deciding a persistent service already exists.
            if sys.argv[1:] != ['status']:
                time.sleep(0.25)
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    print('ALREADY_RUNNING')
                    return 0
            else:
                print('ALREADY_RUNNING')
                return 0
        if sys.argv[1:] == ['status']:
            fcntl.flock(lock, fcntl.LOCK_UN)
            print('SERVICE_STOPPED')
            return 1
        (STATE / 'service.pid').write_text(str(os.getpid()) + '\n')
        env = {k: v for k, v in os.environ.items() if k != 'LD_LIBRARY_PATH'}
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.bind(('0.0.0.0', PORT))
            sock.settimeout(1)
            next_check = 0
            last_reply = {}
            while True:
                now = time.monotonic()
                if now >= next_check:
                    if not ssh_alive():
                        try:
                            result = subprocess.run(['sshd'], env=env, capture_output=True, timeout=8)
                            print(time.strftime('%Y-%m-%dT%H:%M:%S'), 'SSHD_START', result.returncode, flush=True)
                        except (OSError, subprocess.TimeoutExpired):
                            print('SSHD_START_FAILED; retry in 10 seconds', flush=True)
                    next_check = now + 10
                try:
                    data, addr = sock.recvfrom(512)
                    response = reply(data)
                    if response and now - last_reply.get(addr[0], -10) > 0.5:
                        if len(last_reply) > 128:
                            last_reply.clear()
                        last_reply[addr[0]] = now
                        sock.sendto(response, addr)
                except OSError:
                    pass


if __name__ == '__main__':
    os.umask(0o077)
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        pass
