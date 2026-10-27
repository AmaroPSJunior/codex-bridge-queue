#!/usr/bin/env python3
import importlib.util
import json
from pathlib import Path
import stat
import tempfile
import unittest

spec=importlib.util.spec_from_file_location('provision',Path(__file__).resolve().parents[1]/'scripts/provision-device.py')
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class ProvisionTest(unittest.TestCase):
 def test_private_unique_device_and_hash(self):
  with tempfile.TemporaryDirectory() as root:
   directory=Path(root)/'private'
   directory.mkdir(mode=0o700)
   a=module.provision(directory,'Central BYD','android_head_unit')
   b=module.provision(directory,'Celular','android_phone')
   self.assertNotEqual(a['device_id'],b['device_id'])
   self.assertFalse(a['enabled'])
   self.assertEqual(len(a['token_sha256']),64)
   data=json.loads(Path(a['secret_path']).read_text())
   self.assertNotIn(data['token'],json.dumps(a))
   self.assertEqual(stat.S_IMODE(Path(a['secret_path']).stat().st_mode),0o600)
 def test_refuses_public_directory(self):
  with tempfile.TemporaryDirectory() as root:
   directory=Path(root)/'public'
   directory.mkdir(mode=0o755)
   # mkdir mode is filtered by the process umask. Termux commonly uses 0077,
   # which would silently turn 0755 into 0700 and invalidate this test setup.
   directory.chmod(0o755)
   self.assertEqual(stat.S_IMODE(directory.stat().st_mode),0o755)
   with self.assertRaises(ValueError):
    module.provision(directory,'BYD','android_head_unit')

if __name__=='__main__':unittest.main()
