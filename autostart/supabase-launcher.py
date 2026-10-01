#!/data/data/com.termux/files/usr/bin/python3
"""Launch one detached worker, preserving any existing worker."""
import fcntl
import json
import logging
import logging.handlers
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
PRIVATE = Path.home() / '.config/codex-bridge'
SECRET = PRIVATE / 'supabase-service-role.key'
LOGS = ROOT / 'logs'
WORKER = ROOT / 'supabase-worker.js'


def workers():
    found = []
    for proc in Path('/proc').glob('[0-9]*'):
        try:
            args = (proc / 'cmdline').read_bytes().split(b'\0')
            if Path(os.readlink(proc / 'exe')).name != 'node':
                continue
            cwd = Path(os.readlink(proc / 'cwd'))
            if any(a and (cwd / os.fsdecode(a)).resolve() == WORKER for a in args[1:]):
                found.append(int(proc.name))
        except (FileNotFoundError, ProcessLookupError):
            continue
        except PermissionError:
            try:
                if proc.stat().st_uid == os.getuid():
                    raise RuntimeError('Cannot inspect own processes')
            except FileNotFoundError:
                pass
    return sorted(found)


def credential():
    if PRIVATE.is_symlink() or stat.S_IMODE(PRIVATE.stat().st_mode) != 0o700:
        raise RuntimeError('Private directory mode must be 0700')
    fd = os.open(SECRET, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd) as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
            raise RuntimeError('Credential mode must be 0600')
        value = stream.read()
    if not value:
        raise RuntimeError('Empty credential')
    return value


def supervise(fd):
    env = os.environ.copy()
    env['CODEX_SUPABASE_SERVICE_ROLE_KEY'] = credential()
    config = json.loads((ROOT / 'remote-config.json').read_text())
    env['CODEX_SUPABASE_URL'] = config['supabase']['url']
    logger = logging.getLogger('supabase-worker')
    logger.setLevel(logging.INFO)
    handler = logging.handlers.RotatingFileHandler(LOGS / 'supabase-worker.log', maxBytes=1048576, backupCount=3)
    handler.setFormatter(logging.Formatter('%(asctime)s %(message)s'))
    logger.addHandler(handler)
    child = subprocess.Popen([shutil.which('node'), str(WORKER)], cwd=ROOT, env=env,
                             stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                             stderr=subprocess.STDOUT, pass_fds=(fd,))
    logger.info('worker_started pid=%d', child.pid)
    # Persist only known event names, never arbitrary output or response bodies.
    allowed = {'started', 'execution_start', 'execution_finish', 'poll_error', 'fatal', 'stopped', 'progress_local_only', 'progress_local_log_unavailable',
               'progress_capture_failed', 'local_log_failed', 'progress_publish_failed', 'progress_local_log_close_failed'}
    for line in child.stdout:
        try:
            event = json.loads(line).get('event')
            if event in allowed:
                logger.info('%s', event)
        except (ValueError, AttributeError, TypeError):
            pass
    logger.info('worker_exit code=%d', child.wait())


def main():
    os.umask(0o077)
    if len(sys.argv) == 3 and sys.argv[1] == '--supervise':
        supervise(int(sys.argv[2]))
        return
    if len(sys.argv) == 2 and sys.argv[1] == '--status':
        print(json.dumps({'worker_pids': workers(), 'credential_file_exists': SECRET.is_file()}))
        return
    if len(sys.argv) != 1:
        raise RuntimeError('Invalid arguments')
    if LOGS.is_symlink():
        raise RuntimeError('Log symlink refused')
    LOGS.mkdir(mode=0o700, exist_ok=True)
    LOGS.chmod(0o700)
    fd = os.open(LOGS / 'supabase-worker.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        if workers():
            return
        credential()
        subprocess.Popen([sys.executable, str(Path(__file__).resolve()), '--supervise', str(fd)],
                         cwd=ROOT, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, start_new_session=True, pass_fds=(fd,))
    finally:
        os.close(fd)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('Supabase launcher failed; check private configuration and permissions.', file=sys.stderr)
        sys.exit(1)
