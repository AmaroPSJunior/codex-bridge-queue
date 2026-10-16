#!/usr/bin/env python3
"""Explicit offline test inventory; no inherited service credentials."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

root = Path(__file__).resolve().parent.parent
COMMAND_TIMEOUT_SECONDS = 120

with tempfile.TemporaryDirectory(prefix='bridge-offline-home-') as home:
    env = {k: os.environ[k] for k in ('PATH', 'TMPDIR', 'SYSTEMROOT', 'LD_LIBRARY_PATH') if k in os.environ}
    env.update(HOME=home, PYTHONDONTWRITEBYTECODE='1', LANG='C.UTF-8')
    commands = [
        [shutil.which('node'), 'scripts/dashboard-build.cjs', '--check'],
        [sys.executable, 'scripts/generate-docs.py', '--check'],
        [shutil.which('node'), '--test', *map(str, sorted((root/'tests').glob('*.test.cjs')))],
        [sys.executable, '-B', 'tests/test_runtime.py'],
        [sys.executable, '-B', 'tests/test_remote.py'],
        [sys.executable, '-B', '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_*autostart.py', '-v'],
        [sys.executable, '-B', 'tests/test_docs.py'],
        [sys.executable, '-B', 'tests/test_smoke.py'],
        [sys.executable, '-B', 'tests/test_boot.py'],
        [sys.executable, '-B', 'tests/test_boot_path_repair.py'],
        [sys.executable, '-B', 'tests/test_multi_device_contract.py'],
        [sys.executable, '-B', 'tests/test_provision_device.py'],
        [sys.executable, '-B', 'tests/test_watchdog.py'],
    ]
    for index, command in enumerate(commands, 1):
        label = ' '.join(str(part) for part in command)
        print(f'OFFLINE [{index}/{len(commands)}] START {label}', flush=True)
        try:
            result = subprocess.run(
                command,
                cwd=root,
                env=env,
                timeout=COMMAND_TIMEOUT_SECONDS,
            )
        except subprocess.TimeoutExpired:
            print(
                f'OFFLINE [{index}/{len(commands)}] TIMEOUT after '
                f'{COMMAND_TIMEOUT_SECONDS}s: {label}',
                file=sys.stderr,
                flush=True,
            )
            sys.exit(124)
        if result.returncode:
            print(
                f'OFFLINE [{index}/{len(commands)}] FAILED rc={result.returncode}: {label}',
                file=sys.stderr,
                flush=True,
            )
            sys.exit(result.returncode)
        print(f'OFFLINE [{index}/{len(commands)}] PASS {label}', flush=True)
print('OFFLINE SUITE PASSED (no live services or production workers used)')
