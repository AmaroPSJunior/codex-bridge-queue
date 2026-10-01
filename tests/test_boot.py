"""Termux boot script integration, relocated entirely into a temporary fixture."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import unittest

ROOT=Path(__file__).resolve().parent.parent


class BootTests(unittest.TestCase):
    def test_boot_lock_and_safe_calls(self):
        with tempfile.TemporaryDirectory(prefix='bridge-boot-') as temporary:
            root=Path(temporary);bin_dir=root/'bin';bin_dir.mkdir()
            source=(ROOT/'autostart/20-codex-bridge').read_text()
            source=source.replace('PATH=/data/data/com.termux/files/usr/bin:/system/bin','PATH='+str(bin_dir)+':'+os.environ['PATH'])
            source=source.replace('bridge_dir=/data/data/com.termux/files/home/codex-bridge','bridge_dir='+str(root))
            script=root/'boot';script.write_text(source)
            remote=root/'remote';remote.write_text('#!'+shutil.which('sh')+'\nprintf "%s\\n" "$1" >> "'+str(root/'calls')+'"\n');remote.chmod(0o700)
            sleeper=bin_dir/'sleep';sleeper.write_text('#!'+shutil.which('python3')+'\nfrom pathlib import Path\nimport time\np=Path('+repr(str(root))+')\n(p/"entered").touch()\nwhile not (p/"release").exists(): time.sleep(.02)\n');sleeper.chmod(0o700)
            wake=bin_dir/'termux-wake-lock';wake.write_text('#!'+shutil.which('sh')+'\nexit 0\n');wake.chmod(0o700)
            subprocess.run(['sh','-n',str(script)],check=True)
            first=subprocess.Popen(['sh',str(script)])
            try:
                deadline=time.monotonic()+5
                while not (root/'entered').exists() and time.monotonic()<deadline:time.sleep(.02)
                self.assertTrue((root/'entered').exists())
                subprocess.run(['sh',str(script)],check=True,timeout=3)
                self.assertFalse((root/'calls').exists())
                (root/'release').touch()
                self.assertEqual(first.wait(timeout=5),0)
                self.assertEqual((root/'calls').read_text().splitlines(),['start','status'])
                self.assertIn('already in progress', (root/'logs/autostart.log').read_text())
                self.assertEqual((root/'logs/autostart.log').stat().st_mode & 0o777,0o600)
            finally:
                (root/'release').touch()
                first.wait(timeout=5)


if __name__=='__main__':unittest.main()
