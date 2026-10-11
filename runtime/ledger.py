"""Single-host durable leases. Expiry/dead PIDs NEVER grant permission to repeat effects."""
import contextlib
import json
import os
from pathlib import Path
import sqlite3
import time
import uuid


def identity(pid=None):
    pid = pid or os.getpid()
    try:
        fields = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
        return {'pid': pid, 'start': fields[19], 'boot': Path('/proc/sys/kernel/random/boot_id').read_text().strip()}
    except (OSError, IndexError):
        return None


def alive(owner):
    return bool(owner and identity(owner['pid']) == owner)


class Ledger:
    def __init__(self, root):
        self.root = Path(root)
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        st = self.root.lstat()
        if self.root.is_symlink() or st.st_uid != os.getuid() or st.st_mode & 0o777 != 0o700:
            raise RuntimeError('private runtime directory required')
        file = self.root/'ledger.sqlite'
        if file.exists() and (file.is_symlink() or file.stat().st_uid != os.getuid() or file.stat().st_mode & 0o777 != 0o600):
            raise RuntimeError('unsafe ledger')
        self.db = sqlite3.connect(file, timeout=5, isolation_level=None)
        os.chmod(file, 0o600)
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.executescript('''
        CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY, fence TEXT NOT NULL,
          lane TEXT NOT NULL, state TEXT NOT NULL, owner TEXT, updated REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS resources(name TEXT PRIMARY KEY, id TEXT NOT NULL, fence TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS workers(lane TEXT PRIMARY KEY, owner TEXT NOT NULL, state TEXT NOT NULL, beat REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY, at REAL NOT NULL, id TEXT, event TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS controls(id TEXT PRIMARY KEY, lane TEXT NOT NULL, action TEXT NOT NULL, state TEXT NOT NULL);
        ''')

    def __del__(self):
        try:self.db.close()
        except Exception:pass

    @contextlib.contextmanager
    def transaction(self):
        self.db.execute('BEGIN IMMEDIATE')
        try:
            yield
            self.db.execute('COMMIT')
        except BaseException:
            self.db.execute('ROLLBACK')
            raise

    def event(self, task, event):
        self.db.execute('INSERT INTO events(at,id,event) VALUES(?,?,?)', (time.time(), task, event))

    def reserve(self, task, lane, resources):
        fence = str(uuid.uuid4())
        with self.transaction():
            if self.db.execute('SELECT 1 FROM attempts WHERE id=?', (task,)).fetchone():
                return None
            names = sorted(set(resources))
            if not names or any(self.db.execute('SELECT 1 FROM resources WHERE name=?', (r,)).fetchone() for r in names):
                return None
            self.db.execute('INSERT INTO attempts VALUES(?,?,?,?,?,?)', (task, fence, lane, 'reserved', None, time.time()))
            self.db.executemany('INSERT INTO resources VALUES(?,?,?)', [(r, task, fence) for r in names])
            self.event(task, 'reserved')
        return fence

    def transition(self, task, fence, state, owner=None, release=False):
        with self.transaction():
            row = self.db.execute('SELECT fence,state FROM attempts WHERE id=?', (task,)).fetchone()
            if not row or row[0] != fence or row[1] in ('completed', 'not_claimed'):
                raise RuntimeError('stale fencing token or terminal attempt')
            if release and state not in ('completed', 'not_claimed'):
                raise RuntimeError('uncertain effects retain resources')
            self.db.execute('UPDATE attempts SET state=?,owner=?,updated=? WHERE id=?', (state, json.dumps(owner) if owner else None, time.time(), task))
            if release:
                self.db.execute('DELETE FROM resources WHERE id=? AND fence=?', (task, fence))
            self.event(task, state)

    def active(self):
        return [dict(zip(('id','fence','lane','state','owner','updated'), row)) for row in self.db.execute("SELECT * FROM attempts WHERE state NOT IN ('completed','not_claimed')")]

    def beat(self, lane, state):
        self.db.execute('INSERT OR REPLACE INTO workers VALUES(?,?,?,?)', (lane,json.dumps(identity()),state,time.time()))

    def control(self, request_id, lane, action):
        if lane not in ('agent','command','maintenance') or action not in ('drain','restart','status'):
            raise ValueError('unsupported control')
        with self.transaction():
            if action=='restart':self.db.execute("UPDATE controls SET state='acknowledged' WHERE lane=? AND action='drain'",(lane,))
            self.db.execute('INSERT INTO controls VALUES(?,?,?,?)', (str(uuid.UUID(request_id)),lane,action,'requested'))
            self.event(request_id, 'control_'+action)

    def draining(self, lane):
        return bool(self.db.execute("SELECT 1 FROM controls WHERE lane=? AND action IN ('drain','restart') AND state IN ('requested','draining','stopping')",(lane,)).fetchone())

    def snapshot(self):
        return {'attempts':self.active(),'workers':[dict(zip(('lane','owner','state','beat'),r)) for r in self.db.execute('SELECT * FROM workers')],
                'controls':[dict(zip(('id','lane','action','state'),r)) for r in self.db.execute('SELECT * FROM controls')]}
