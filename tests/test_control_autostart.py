"""Supervisor state-machine tests with fake children; never signals production."""
import importlib.util
import json
import os
import subprocess
from unittest.mock import patch
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('supervisor_control', Path(__file__).resolve().parents[1]/'autostart/supabase-launcher.py')
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)
ID = '00000000-0000-4000-8000-000000000071'

class Child:
    def __init__(self, pid):
        self.pid, self.bridge_generation, self.stopped = pid, str(pid), False
    def poll(self):
        return 0 if self.stopped else None
    def terminate(self):
        self.stopped = True
    def wait(self, timeout=None):
        return 0

class ControlTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.started = []
        def start():
            child = Child(200 + len(self.started))
            self.started.append(child)
            return child
        self.now = 10000
        self.control = launcher.SupervisorControl(Path(self.temp.name), start, lambda: self.now)
        self.control.child = Child(100)
        self.file = self.control.directory/(ID+'.json')
        self.control.write(self.file, {'version': 1, 'id': ID, 'command': 'restart', 'status': 'requested'})

    def test_waits_for_exact_ready_then_boot_ack_and_no_duplicate(self):
        c = self.control
        c.tick()
        self.assertFalse(c.child.stopped)
        c.tick()
        self.assertEqual(self.started, [])
        r = c.read(self.file)
        c.write(c.directory/'ready.json', {'id': ID, 'pid': 999, 'nonce': r['nonce']})
        c.tick()
        self.assertEqual(self.started, [])
        c.write(c.directory/'ready.json', {'id': ID, 'pid': 100, 'nonce': r['nonce']})
        c.tick()
        self.assertEqual(len(self.started), 1)
        self.assertEqual(c.read(self.file)['status'], 'starting')
        c.write(c.directory/'boot.json', {'pid': c.child.pid, 'generation': c.child.bridge_generation})
        c.tick()
        self.assertEqual(c.read(self.file)['status'], 'acknowledged')
        for _ in range(5):
            c.tick()
        self.assertEqual(len(self.started), 1)

    def test_interrupted_transition_not_replayed(self):
        self.control.tick()
        c = launcher.SupervisorControl(Path(self.temp.name), lambda: self.fail('must not start'))
        self.assertEqual(c.read(self.file)['status'], 'needs_review')
        c.tick()

    def test_dead_child_not_blindly_restarted(self):
        self.control.child.stopped = True
        self.control.tick()
        self.assertEqual(self.control.read(self.file)['status'], 'needs_review')
        self.assertEqual(self.started, [])

    def test_rate_limit_and_private_journal(self):
        self.control.write(self.file, {'version': 1, 'id': ID, 'command': 'restart', 'status': 'acknowledged', 'ack_epoch': self.now})
        other = self.control.directory/'00000000-0000-4000-8000-000000000072.json'
        self.control.write(other, {'version': 1, 'id': other.stem, 'command': 'restart', 'status': 'requested'})
        self.control.tick()
        self.assertIsNone(self.control.active)
        self.assertEqual(self.file.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.control.directory.stat().st_mode & 0o777, 0o700)

    def ready(self):
        self.control.tick()
        r = self.control.read(self.file)
        self.control.write(self.control.directory/'ready.json', {k:r[k] for k in ('id','pid','nonce')})

    def test_slow_exit_waits_without_second_signal_then_relaunches(self):
        old = self.control.child
        signals = []
        old.terminate = lambda: signals.append('TERM')
        self.ready()
        self.control.tick()
        self.now += 31
        for _ in range(5): self.control.tick()
        self.assertEqual(signals, ['TERM'])
        self.assertEqual(self.started, [])
        self.assertEqual(self.control.read(self.file)['reason'], 'waiting_previous_exit')
        old.stopped = True
        self.control.tick()
        self.assertEqual(len(self.started), 1)
        self.assertEqual(self.control.read(self.file)['status'], 'starting')

    def test_child_exits_after_ready_before_signal_still_relaunches(self):
        self.ready()
        self.control.child.stopped = True
        self.control.tick()
        self.assertEqual(len(self.started), 1)

    def test_transient_spawn_failure_retries_once_after_cooldown(self):
        original = self.control.start
        attempts = []
        def start():
            attempts.append(1)
            if len(attempts) == 1: raise OSError('synthetic spawn failure')
            return original()
        self.control.start = start
        self.ready()
        self.control.tick()
        self.assertEqual(self.control.read(self.file)['reason'], 'launch_retry_pending')
        for _ in range(5): self.control.tick()
        self.assertEqual(len(attempts), 1)
        self.now += 60
        self.control.tick()
        self.assertEqual(len(attempts), 2)
        self.assertEqual(len(self.started), 1)
        self.assertEqual(self.control.read(self.file)['launch_attempts'], 2)

    def test_persistent_spawn_failure_has_durable_budget_no_loop(self):
        attempts = []
        def fail():
            attempts.append(1)
            raise OSError('synthetic failure')
        self.control.start = fail
        self.ready()
        for _ in range(20):
            self.control.tick()
            self.now += 60
        self.assertEqual(len(attempts), 3)
        self.assertEqual(self.control.read(self.file)['status'], 'needs_review')
        self.assertEqual(self.control.read(self.file)['launch_attempts'], 3)

    def test_failed_journal_after_spawn_does_not_duplicate_child(self):
        self.ready()
        original = self.control.write
        failed = []
        def write(file, record):
            if record.get('new_pid') and not failed:
                failed.append(1)
                raise OSError('synthetic write interruption')
            return original(file, record)
        self.control.write = write
        with self.assertRaises(OSError): self.control.tick()
        self.control.tick()
        self.assertEqual(len(self.started), 1)
        self.assertEqual(self.control.read(self.file)['new_pid'], self.control.child.pid)

    def test_boot_from_dead_new_worker_is_not_success_or_restarted(self):
        self.ready()
        self.control.tick()
        child = self.control.child
        child.stopped = True
        self.control.write(self.control.directory/'boot.json', {'pid':child.pid,'generation':child.bridge_generation})
        self.control.tick()
        self.assertEqual(self.control.read(self.file)['status'], 'needs_review')
        for _ in range(5): self.control.tick()
        self.assertEqual(len(self.started), 1)

    def test_dead_child_during_drain_without_ack_releases_transition(self):
        self.control.tick()
        self.control.child.stopped = True
        self.control.tick()
        self.assertIsNone(self.control.active)
        self.assertEqual(self.control.read(self.file)['reason'], 'exit_without_ready')
        self.assertEqual(self.started, [])

    def test_existing_terminal_records_preserved(self):
        r = {'version':1,'id':ID,'status':'acknowledged','command':'restart','ack_epoch':1,'custom':'retained'}
        self.control.write(self.file, r)
        launcher.SupervisorControl(Path(self.temp.name), lambda: self.fail('no replay'))
        self.assertEqual(self.control.read(self.file), r)


class LockTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.logs = Path(self.temp.name)
        self.patch = patch.object(launcher, 'LOGS', self.logs)
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def test_orphan_file_reused_without_unlink_and_exclusive(self):
        file = self.logs/'supabase-worker.lock'
        file.write_text('stale diagnostic text')
        file.chmod(0o600)
        inode = file.stat().st_ino
        fd = launcher.open_lock()
        try:
            with self.assertRaises(BlockingIOError): launcher.open_lock()
            self.assertEqual(file.stat().st_ino, inode)
        finally: os.close(fd)
        fd = launcher.open_lock()
        os.close(fd)
        self.assertEqual(file.stat().st_ino, inode)
        self.assertEqual(file.read_text(), 'stale diagnostic text')

    def test_unrelated_or_replaced_inherited_fd_refused(self):
        fd = launcher.open_lock()
        try:
            file = self.logs/'supabase-worker.lock'
            file.rename(self.logs/'old.lock')
            file.touch(mode=0o600)
            with self.assertRaises(RuntimeError): launcher.validate_lock(fd)
        finally: os.close(fd)

    def test_unsafe_mode_and_symlink_refused(self):
        file = self.logs/'supabase-worker.lock'
        file.touch(mode=0o644)
        file.chmod(0o644)
        with self.assertRaises(RuntimeError): launcher.open_lock()
        file.rename(self.logs/'target')
        file.symlink_to(self.logs/'target')
        with self.assertRaises(OSError): launcher.open_lock()

if __name__ == '__main__':
    unittest.main()
