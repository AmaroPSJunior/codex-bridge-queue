import importlib.util
import os
from pathlib import Path
import stat
import tempfile
import unittest

MODULE = Path(__file__).resolve().parents[1] / "autostart" / "repair-boot-path.py"
spec = importlib.util.spec_from_file_location("repair_boot_path", MODULE)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


class BootRepairTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        (self.home / ".termux" / "boot").mkdir(parents=True)
        (self.home / "codex-bridge-main" / "autostart").mkdir(parents=True)
        (self.home / "codex-bridge-main" / "autostart" / "supabase-launcher.py").touch()
        self.target = self.home / ".termux" / "boot" / "20-codex-bridge"
        self.original = b"#!/bin/bash\nbridge_dir=/data/data/com.termux/files/home/codex-bridge\necho hello\n"
        self.target.write_bytes(self.original)
        self.target.chmod(0o700)

    def test_dry_run_no_changes(self):
        self.assertIn("DRY-RUN", mod.repair(self.home))
        self.assertEqual(self.target.read_bytes(), self.original)
        self.assertFalse((self.home / "bridge-resgate").exists())

    def test_backup_and_idempotency(self):
        self.assertIn("APLICADO", mod.repair(self.home, True))
        self.assertIn(mod.NEW.encode(), self.target.read_bytes())
        self.assertEqual(stat.S_IMODE(self.target.stat().st_mode), 0o700)
        backups = list((self.home / "bridge-resgate").iterdir())
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_bytes(), self.original)
        self.assertIn("JÁ CORRIGIDO", mod.repair(self.home, True))
        self.assertEqual(len(list((self.home / "bridge-resgate").iterdir())), 1)

    def test_rejects_unexpected_file_without_writing(self):
        self.target.write_bytes(self.original.replace(mod.OLD.encode(), b"/unexpected"))
        with self.assertRaises(RuntimeError):
            mod.repair(self.home, True)
        self.assertFalse((self.home / "bridge-resgate").exists())

    def test_rejects_symlink(self):
        original = self.home / "original"
        original.write_bytes(self.original)
        self.target.unlink()
        self.target.symlink_to(original)
        with self.assertRaises(RuntimeError):
            mod.repair(self.home, True)


if __name__ == "__main__":
    unittest.main()
