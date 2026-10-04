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
import time
import threading
import uuid

ROOT = Path(__file__).resolve().parent.parent
PRIVATE = Path.home() / '.config/codex-bridge'
SECRET = PRIVATE / 'supabase-service-role.key'
GROQ_SECRET = PRIVATE / 'groq_api_key'
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


def validate_lock(fd):
    """The inherited FD must still refer to the one stable launcher lock inode."""
    info = os.fstat(fd)
    current = (LOGS / 'supabase-worker.lock').lstat()
    if (not stat.S_ISREG(info.st_mode) or not stat.S_ISREG(current.st_mode)
            or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600
            or info.st_nlink != 1 or (info.st_dev, info.st_ino) != (current.st_dev, current.st_ino)):
        raise RuntimeError('Unsafe or replaced supervisor lock')
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)


def open_lock():
    # Never unlink a stale lock file: that would let two holders lock two inodes.
    fd = os.open(LOGS / 'supabase-worker.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        validate_lock(fd)
        return fd
    except BaseException:
        os.close(fd)
        raise


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


def supervise(lock_fd):
    validate_lock(lock_fd)
    env = os.environ.copy()
    local_bin = str(Path.home() / '.local' / 'bin')
    env['PATH'] = local_bin + os.pathsep + env.get('PATH', '')
    # Worker resolves task > inherited AI_PROVIDER > private provider.json > codex.
    env['CODEX_SUPABASE_SERVICE_ROLE_KEY'] = credential()

    # Optional provider credentials must not prevent the default Codex worker
    # from returning after an authorized restart. Existing files remain strict.
    if GROQ_SECRET.exists() or GROQ_SECRET.is_symlink():
        key_fd = os.open(GROQ_SECRET, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(key_fd) as stream:
            info = os.fstat(stream.fileno())
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                    or stat.S_IMODE(info.st_mode) != 0o600):
                raise RuntimeError('Groq credential mode must be 0600')
            groq_key = stream.read().strip()
        if not groq_key:
            raise RuntimeError('Empty Groq credential')
        env['GROQ_API_KEY'] = groq_key
    config = json.loads((ROOT / 'remote-config.json').read_text())
    env['CODEX_SUPABASE_URL'] = config['supabase']['url']
    logger = logging.getLogger('supabase-worker')
    logger.setLevel(logging.INFO)
    handler = logging.handlers.RotatingFileHandler(LOGS / 'supabase-worker.log', maxBytes=1048576, backupCount=3)
    handler.setFormatter(logging.Formatter('%(asctime)s %(message)s'))
    logger.addHandler(handler)
    def start():
        validate_lock(lock_fd)
        if workers():
            raise RuntimeError('Existing worker prevents launch')
        generation = str(uuid.uuid4())
        child_env = {**env, 'BRIDGE_SUPERVISOR_GENERATION': generation}
        child = subprocess.Popen([shutil.which('node'), str(WORKER)], cwd=ROOT, env=child_env,
                                 stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                 stderr=subprocess.STDOUT, pass_fds=(lock_fd,))
        child.bridge_generation = generation
        logger.info('worker_started pid=%d', child.pid)
        def consume():
            allowed = {'started', 'execution_start', 'execution_finish', 'poll_error', 'fatal',
                       'stopped', 'result_receipt_pending', 'result_receipt_needs_review'}
            for line in child.stdout:
                try:
                    event = json.loads(line).get('event')
                    if event in allowed:
                        logger.info('%s', event)
                except (ValueError, AttributeError, TypeError):
                    pass
            logger.info('worker_exit code=%d', child.wait())
        threading.Thread(target=consume, daemon=True).start()
        return child
    controller = SupervisorControl(ROOT, start)
    controller.write(controller.directory/'supervisor.json', {'pid': os.getpid(), 'version': 1})
    controller.child = start()
    while True:
        try:
            controller.tick()
            if controller.active is None and controller.child.poll() is not None:
                controller.write(controller.directory/'supervisor.json',
                                 {'pid': os.getpid(), 'version': 1, 'status': 'stopped', 'reason': 'worker_exited'})
                logger.warning('supervisor_stopped_no_worker')
                return  # Release our flock so a future launcher can recover.
        except Exception:
            logger.warning('supervisor_control_error')
        time.sleep(1)


class SupervisorControl:
    """Local durable control plane; never kills a worker without its drain ACK."""
    def __init__(self, root, start, clock=time.time):
        self.root, self.start, self.clock = root, start, clock
        self.directory = root / 'supabase-state/control'
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        info = self.directory.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
            raise RuntimeError('Unsafe control directory')
        self.child = None
        self.active = None
        # An interrupted transition is not replayed blindly after supervisor crash.
        for file in self.requests():
            record = self.read(file)
            if record.get('status') in ('draining', 'stopping', 'starting'):
                self.write(file, {**record, 'status': 'needs_review', 'reason': 'supervisor_interrupted'})

    def requests(self):
        return sorted(p for p in self.directory.glob('*.json') if self.is_id(p.stem))

    @staticmethod
    def is_id(value):
        try:
            return str(uuid.UUID(value)) == value.lower()
        except (ValueError, AttributeError, TypeError):
            return False

    def read(self, file):
        fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd) as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > 8192:
                raise RuntimeError('Unsafe control record')
            return json.load(stream)

    def write(self, file, record):
        temp = file.with_name(file.name + '.' + uuid.uuid4().hex)
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as stream:
            json.dump(record, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, file)
        fd = os.open(self.directory, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    def tick(self):
        if self.active is None:
            completed = [self.read(p).get('attempt_epoch', self.read(p).get('ack_epoch', 0)) for p in self.requests()]
            if sum(t > self.clock()-3600 for t in completed) >= 3 or any(t > self.clock()-60 for t in completed):
                return
            for file in self.requests():
                r = self.read(file)
                if r.get('status') != 'requested':
                    continue
                if r.get('id') != file.stem or r.get('version') != 1 or r.get('command') != 'restart':
                    self.write(file, {**r, 'status': 'rejected'})
                    continue
                if self.child is None or self.child.poll() is not None:
                    self.write(file, {**r, 'status': 'needs_review'})
                    continue
                self.active = file
                r.update(status='draining', pid=self.child.pid, nonce=uuid.uuid4().hex)
                self.write(file, r)
                self.write(self.directory/'drain.json', {'id': r['id'], 'pid': r['pid'], 'nonce': r['nonce']})
                return
            return
        r = self.read(self.active)
        if r['status'] == 'draining':
            ready = self.directory/'ready.json'
            ack = self.read(ready) if ready.exists() else {}
            if any(ack.get(k) != r[k] for k in ('id', 'pid', 'nonce')):
                if self.child.poll() is not None:
                    self.write(self.active, {**r, 'status': 'needs_review', 'reason': 'exit_without_ready'})
                    self.active = None
                return
            # Persist intent before signalling, and keep waiting if exit is slow.
            # A dead child with an exact ready ACK is also safe to reap/relaunch.
            r.update(status='stopping', attempt_epoch=self.clock(), stop_epoch=self.clock())
            self.write(self.active, r)
            if self.child.poll() is None:
                self.child.terminate()
            self.relaunch(r)
            return
        if r['status'] == 'stopping':
            self.relaunch(r)
            return
        if r['status'] == 'starting':
            boot = self.directory/'boot.json'
            ack = self.read(boot) if boot.exists() else {}
            if self.child.poll() is None and ack.get('pid') == r.get('new_pid') and ack.get('generation') == r.get('generation'):
                self.write(self.active, {**r, 'status': 'acknowledged', 'ack_epoch': self.clock(),
                                        'ack_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(self.clock()))})
                self.active = None
            elif self.child.poll() is not None or self.clock()-r['started_epoch'] > 120:
                self.write(self.active, {**r, 'status': 'needs_review', 'reason': 'boot_not_confirmed'})
                self.active = None

    def relaunch(self, record):
        """Called only after exact drain acknowledgement; no blind crash loop."""
        r = dict(record)
        if self.child.poll() is None:
            # A journal write may have failed immediately after spawning. Recover
            # the already-owned child instead of creating a duplicate on retry.
            if self.child.pid != r['pid']:
                self.write(self.active, {**r, 'status': 'starting', 'new_pid': self.child.pid,
                                        'generation': self.child.bridge_generation, 'started_epoch': self.clock()})
            elif self.clock() - r['stop_epoch'] >= 30 and r.get('reason') != 'waiting_previous_exit':
                self.write(self.active, {**r, 'reason': 'waiting_previous_exit'})
            return
        self.child.wait()  # Exit has been observed; never wait on a live worker.
        if self.child.pid != r['pid']:
            self.write(self.active, {**r, 'status': 'needs_review', 'reason': 'boot_not_confirmed'})
            self.active = None
            return  # A spawned worker might already have claimed a task.
        if self.clock() < r.get('retry_after', 0):
            return
        if r.get('launch_attempts', 0) >= 3:
            self.write(self.active, {**r, 'status': 'needs_review', 'reason': 'launch_attempts_exhausted'})
            self.active = None
            return
        r.update(launch_attempts=r.get('launch_attempts', 0) + 1, retry_after=self.clock() + 60)
        self.write(self.active, r)  # A crash cannot erase the attempt budget.
        try:
            self.child = self.start()
        except Exception:
            exhausted = r['launch_attempts'] >= 3
            self.write(self.active, {**r, 'status': 'needs_review' if exhausted else 'stopping',
                                    'reason': 'launch_attempts_exhausted' if exhausted else 'launch_retry_pending'})
            if exhausted:
                self.active = None
            return
        self.write(self.active, {**r, 'status': 'starting', 'new_pid': self.child.pid,
                                'generation': self.child.bridge_generation, 'started_epoch': self.clock()})


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
    # Resume an explicitly requested bootstrap on normal Bash/Boot autostart.
    bootstrap = ROOT / 'autostart/control-bootstrap.py'
    if bootstrap.is_file() and (ROOT/'supabase-state/control/bootstrap.json').is_file():
        subprocess.run([sys.executable, str(bootstrap), '--detach'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if LOGS.is_symlink():
        raise RuntimeError('Log symlink refused')
    LOGS.mkdir(mode=0o700, exist_ok=True)
    LOGS.chmod(0o700)
    try:
        fd = open_lock()
    except BlockingIOError:
        return
    try:
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
