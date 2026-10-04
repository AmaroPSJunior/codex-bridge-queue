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
        # Existing launcher loads this private credential even for the fake worker.
        groq_secret = self.private / 'groq_api_key'
        groq_secret.write_text('synthetic-groq-test-only')
        groq_secret.chmod(0o600)
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
            # The new supervisor intentionally outlives its worker. Stop only the
            # supervisor launched inside this test's unique temporary repository.
            supervisor = self.repo / 'supabase-state/control/supervisor.json'
            if supervisor.exists():
                pid = json.loads(supervisor.read_text())['pid']
                args = Path('/proc') / str(pid) / 'cmdline'
                if args.exists() and str(self.launcher).encode() in args.read_bytes().split(b'\0'):
                    os.kill(pid, signal.SIGTERM)
            for pid in local.workers():
                os.kill(pid, signal.SIGTERM)
            time.sleep(0.2)


    def test_real_restart_keeps_lock_until_previous_exit_and_relaunches_once(self):
        self.install(self.fake)
        # No Groq key: unrelated optional provider must not block Codex startup.
        (self.repo/'supabase-worker.js').write_text(r"""
const fs=require('fs'),path=require('path');
const dir=path.join(__dirname,'supabase-state/control');
fs.mkdirSync(dir,{recursive:true,mode:0o700});
function save(name,obj){const p=path.join(dir,name);fs.writeFileSync(p+'.tmp',JSON.stringify(obj),{mode:0o600});fs.renameSync(p+'.tmp',p);}
fs.appendFileSync(path.join(__dirname,'events'),JSON.stringify({event:'start',pid:process.pid})+'\n');
save('boot.json',{pid:process.pid,generation:process.env.BRIDGE_SUPERVISOR_GENERATION});
const timer=setInterval(()=>{try{const r=JSON.parse(fs.readFileSync(path.join(dir,'drain.json')));if(r.pid===process.pid)save('ready.json',r);}catch{}},20);
process.on('SIGTERM',()=>{clearInterval(timer);setTimeout(()=>{fs.appendFileSync(path.join(__dirname,'events'),JSON.stringify({event:'exit',pid:process.pid})+'\n');process.exit(0);},200);});
""")
        env = {k:os.environ[k] for k in ('PATH','TMPDIR','LD_LIBRARY_PATH') if k in os.environ}
        env['HOME'] = str(self.home)
        local = module(self.launcher, 'restart_launcher')
        def wait_for(check):
            end = time.monotonic()+12
            while time.monotonic()<end:
                value=check()
                if value:return value
                time.sleep(.03)
            self.fail('Timed out waiting for isolated supervisor')
        directory=self.repo/'supabase-state/control'
        subprocess.run([sys.executable,str(self.launcher)],env=env,check=True)
        supervisor_pid=None
        try:
            wait_for(lambda:(directory/'boot.json').exists())
            supervisor_pid=json.loads((directory/'supervisor.json').read_text())['pid']
            old=json.loads((directory/'boot.json').read_text())['pid']
            local.LOGS=self.repo/'logs'
            with self.assertRaises(BlockingIOError):local.open_lock()
            request=directory/'00000000-0000-4000-8000-000000000071.json'
            request.write_text(json.dumps({'id':request.stem,'version':1,'command':'restart','status':'requested'}))
            request.chmod(0o600)
            wait_for(lambda:json.loads(request.read_text()).get('status')=='acknowledged')
            rows=[json.loads(line) for line in (self.repo/'events').read_text().splitlines()]
            self.assertEqual([r['event'] for r in rows],['start','exit','start'])
            self.assertEqual(rows[0]['pid'],old)
            new=rows[2]['pid']
            self.assertNotEqual(old,new)
            self.assertEqual(local.workers(),[new])
            children=[subprocess.Popen([sys.executable,str(self.launcher)],env=env) for _ in range(4)]
            for child in children:self.assertEqual(child.wait(timeout=5),0)
            self.assertEqual(local.workers(),[new])
            with self.assertRaises(BlockingIOError):local.open_lock()
            # Only test processes: after an unrequested exit the supervisor must
            # release its lock, without automatically creating a restart loop.
            os.kill(new,signal.SIGTERM)
            wait_for(lambda:json.loads((directory/'supervisor.json').read_text()).get('status')=='stopped')
            def unlocked():
                try: fd=local.open_lock()
                except BlockingIOError:return False
                os.close(fd);return True
            wait_for(unlocked)
            self.assertEqual(local.workers(),[])
            self.assertEqual(json.loads(request.read_text())['status'],'acknowledged')
        finally:
            # Verify ownership before signalling anything; all paths are temporary.
            if supervisor_pid:
                proc=Path('/proc')/str(supervisor_pid)/'cmdline'
                try:
                    if str(self.launcher).encode() in proc.read_bytes().split(b'\0'):
                        os.kill(supervisor_pid,signal.SIGTERM)
                except (FileNotFoundError,ProcessLookupError):pass
            for pid in local.workers():os.kill(pid,signal.SIGTERM)
            time.sleep(.3)

if __name__ == '__main__':
    unittest.main()
