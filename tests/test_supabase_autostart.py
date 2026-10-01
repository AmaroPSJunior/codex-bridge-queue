"""Isolated tests; never read the real credential or stop the real worker."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent


def module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


class AutostartTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='bridge-autostart-test-')
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.repo = self.home / 'codex-bridge'
        (self.repo / 'autostart').mkdir(parents=True)
        for name in ['supabase-launcher.py', 'install-supabase-autostart.py']:
            shutil.copyfile(ROOT / 'autostart' / name, self.repo / 'autostart' / name)
        (self.repo / 'remote-config.json').write_text(json.dumps({'supabase': {'url': 'https://example.invalid'}}))
        self.launcher = self.repo / 'autostart/supabase-launcher.py'
        self.installer = module(self.repo / 'autostart/install-supabase-autostart.py', 'installer')
        self.private = self.home / '.config/codex-bridge'
        self.secret = self.private / 'supabase-service-role.key'
        self.fake = 'synthetic-test-only'

    def install(self, value):
        real_run = subprocess.run
        def run(args, **kwargs):
            if args[0] == 'bash':
                return real_run(args, **kwargs)
            return subprocess.CompletedProcess(args, 0)
        with patch.object(Path, 'home', return_value=self.home), patch.dict(os.environ, {'CODEX_SUPABASE_SERVICE_ROLE_KEY': value}), patch.object(self.installer.subprocess, 'run', side_effect=run):
            return self.installer.main()

    def test_install_backup_idempotence_and_permissions(self):
        rc = self.home / '.bashrc'
        original = '# existing configuration\nexport BRIDGE_TEST=1\n'
        rc.write_text(original)
        self.assertEqual(self.install(self.fake), 0)
        first = rc.read_text()
        self.assertTrue(first.startswith(original))
        self.assertEqual(self.install(self.fake), 0)
        self.assertEqual(rc.read_text(), first)
        backups = list(self.private.glob('bashrc.backup-*'))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_text(), original)
        self.assertEqual(stat.S_IMODE(self.private.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(self.secret.stat().st_mode), 0o600)
        with self.assertRaises(RuntimeError):
            self.install('different-synthetic-value')
        self.assertEqual(self.secret.read_text(), self.fake)

    def test_missing_credential_does_not_write(self):
        self.assertEqual(self.install(''), 1)
        self.assertFalse(self.private.exists())
        self.assertFalse((self.home / '.bashrc').exists())

    def test_credential_permissions_and_symlinks_rejected(self):
        self.install(self.fake)
        local = module(self.launcher, 'launcher_secure')
        local.PRIVATE = self.private
        local.SECRET = self.secret
        self.assertEqual(local.credential(), self.fake)
        self.secret.chmod(0o644)
        with self.assertRaises(RuntimeError):
            local.credential()
        self.secret.chmod(0o600)
        target = self.private / 'original'
        self.secret.rename(target)
        self.secret.symlink_to(target)
        with self.assertRaises(OSError):
            local.credential()
        with self.assertRaises(OSError):
            self.install(self.fake)

    def test_invalid_markers_preserve_bashrc(self):
        rc = self.home / '.bashrc'
        original = '# BEGIN codex-bridge supabase autostart\n'
        rc.write_text(original)
        with self.assertRaises(RuntimeError):
            self.install(self.fake)
        self.assertEqual(rc.read_text(), original)

    def test_autostart_only_interactive(self):
        self.install(self.fake)
        marker = self.home / 'called'
        self.launcher.write_text('from pathlib import Path\nPath(' + repr(str(marker)) + ').touch()\n')
        rc = self.home / '.bashrc'
        subprocess.run(['bash', '-c', '. "$1"', 'test', str(rc)], check=True)
        self.assertFalse(marker.exists())
        subprocess.run(['bash', '--noprofile', '--rcfile', str(rc), '-i', '-c', 'exit'],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
        deadline = time.monotonic() + 3
        while not marker.exists() and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertTrue(marker.exists())

    def test_concurrent_launch_and_private_filtered_logs(self):
        self.install(self.fake)
        (self.repo / 'supabase-worker.js').write_text("console.log(process.env.CODEX_SUPABASE_SERVICE_ROLE_KEY); console.log(JSON.stringify({event:'started'})); setInterval(()=>{},1000);\n")
        env = os.environ.copy()
        env['HOME'] = str(self.home)
        env.pop('CODEX_SUPABASE_SERVICE_ROLE_KEY', None)
        local = module(self.launcher, 'launcher')
        children = [subprocess.Popen([sys.executable, str(self.launcher)], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE) for _ in range(12)]
        try:
            for child in children:
                out, err = child.communicate(timeout=10)
                self.assertEqual(child.returncode, 0, 'Concurrent launcher failed')
                self.assertNotIn(self.fake.encode(), out + err)
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                pids = local.workers()
                log = self.repo / 'logs/supabase-worker.log'
                if pids and log.exists() and 'started' in log.read_text():
                    break
                time.sleep(0.05)
            self.assertEqual(len(local.workers()), 1)
            subprocess.run([sys.executable, str(self.launcher)], env=env, check=True)
            self.assertEqual(len(local.workers()), 1)
            self.assertNotIn(self.fake, log.read_text())
            self.assertEqual(stat.S_IMODE(log.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(log.parent.stat().st_mode), 0o700)
        finally:
            for pid in local.workers():
                os.kill(pid, signal.SIGTERM)
            time.sleep(0.2)


if __name__ == '__main__':
    unittest.main()
