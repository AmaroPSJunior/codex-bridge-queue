#!/data/data/com.termux/files/usr/bin/python3
"""Install from a Termux shell with the existing exported credential."""
import datetime
import json
import os
from pathlib import Path
import shlex
import shutil
import stat
import subprocess
import sys


def main():
    os.umask(0o077)
    key = os.environ.get('CODEX_SUPABASE_SERVICE_ROLE_KEY')
    if not key:
        print('Credential unavailable; no changes made.', file=sys.stderr)
        return 1
    root = Path(__file__).resolve().parent.parent
    config = json.loads((root / 'remote-config.json').read_text())
    if not config.get('supabase', {}).get('url'):
        raise RuntimeError('URL unavailable')
    private = Path.home() / '.config/codex-bridge'
    if private.is_symlink():
        raise RuntimeError('Symlink refused')
    private.mkdir(mode=0o700, parents=True, exist_ok=True)
    private.chmod(0o700)
    secret = private / 'supabase-service-role.key'
    if secret.exists() or secret.is_symlink():
        fd = os.open(secret, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd) as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stream.read() != key:
                raise RuntimeError('Existing credential preserved')
            os.fchmod(stream.fileno(), 0o600)
    else:
        fd = os.open(secret, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as stream:
            stream.write(key)
            stream.flush()
            os.fsync(stream.fileno())
    rc = Path.home() / '.bashrc'
    if rc.is_symlink():
        raise RuntimeError('Startup symlink refused')
    old = rc.read_text() if rc.exists() else ''
    begin = '# BEGIN codex-bridge supabase autostart'
    end = '# END codex-bridge supabase autostart'
    launcher = root / 'autostart/supabase-launcher.py'
    command = shlex.quote(sys.executable) + ' ' + shlex.quote(str(launcher))
    block = begin + '\ncase $- in\n  *i*) ' + command + ' >/dev/null 2>&1 & ;;\nesac\n' + end
    if begin in old or end in old:
        if old.count(begin) != 1 or old.count(end) != 1 or old.index(end) < old.index(begin):
            raise RuntimeError('Invalid startup markers')
        updated = old[:old.index(begin)] + block + old[old.index(end) + len(end):]
    else:
        updated = old + '\n' + block + '\n'
    if updated != old:
        if rc.exists():
            stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f')
            backup = private / ('bashrc.backup-' + stamp)
            shutil.copy2(rc, backup)
            backup.chmod(0o600)
        temporary = private / ('bashrc.pending-' + str(os.getpid()))
        try:
            with temporary.open('x') as stream:
                stream.write(updated)
            subprocess.run(['bash', '-n', str(temporary)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            # Only .bashrc itself and the private directory need write access.
            # Validate fully and keep a backup before opening the target.
            fd = os.open(rc, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, 'w') as stream:
                stream.write(updated)
                stream.flush()
                os.fsync(stream.fileno())
        finally:
            temporary.unlink(missing_ok=True)
    subprocess.run([sys.executable, str(launcher)], check=True)
    print('Private credential saved; interactive Bash autostart installed.')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        print('Installation incomplete; worker preserved. Check permissions and configuration.', file=sys.stderr)
        sys.exit(1)
