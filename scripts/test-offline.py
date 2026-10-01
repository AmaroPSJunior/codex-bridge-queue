#!/usr/bin/env python3
"""Explicit offline test inventory; no inherited service credentials."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

root = Path(__file__).resolve().parent.parent
with tempfile.TemporaryDirectory(prefix='bridge-offline-home-') as home:
    env = {k: os.environ[k] for k in ('PATH', 'TMPDIR', 'SYSTEMROOT', 'LD_LIBRARY_PATH') if k in os.environ}
    env.update(HOME=home, PYTHONDONTWRITEBYTECODE='1', LANG='C.UTF-8')
    commands = [
        [shutil.which('node'), 'scripts/dashboard-build.cjs', '--check'],
        [sys.executable, 'scripts/generate-docs.py', '--check'],
        [shutil.which('node'), '--test', *map(str, sorted((root/'tests').glob('*.test.cjs')))],
        [sys.executable, '-B', 'tests/test_remote.py'],
        [sys.executable, '-B', '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_*autostart.py', '-v'],
        [sys.executable, '-B', 'tests/test_docs.py'],
        [sys.executable, '-B', 'tests/test_smoke.py'],
        [sys.executable, '-B', 'tests/test_boot.py'],
    ]
    for command in commands:
        result = subprocess.run(command, cwd=root, env=env)
        if result.returncode:
            sys.exit(result.returncode)
print('OFFLINE SUITE PASSED (no live services or production workers used)')
