#!/usr/bin/env python3
"""Strict, one-purpose Termux:Boot path repair. Dry-run unless --apply is supplied."""
import argparse
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import tempfile
from datetime import datetime, timezone

OLD = "/data/data/com.termux/files/home/codex-bridge"
NEW = "/data/data/com.termux/files/home/codex-bridge-main"
FILENAME = "20-codex-bridge"
PATTERN = re.compile(rb"(?m)^(bridge_dir=)([^\r\n]+)$")


def regular_owned(path: Path, *, mode=None):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
        raise RuntimeError("Arquivo inseguro ou sem proprietário esperado")
    if mode is not None and stat.S_IMODE(info.st_mode) != mode:
        raise RuntimeError("Permissões do arquivo inesperadas")
    return info


def repair(home: Path, apply=False):
    if home.is_symlink() or not home.is_dir() or home.resolve() != home:
        raise RuntimeError("HOME não é diretório real")
    bootdir = home / ".termux" / "boot"
    target = bootdir / FILENAME
    if bootdir.is_symlink() or not bootdir.is_dir():
        raise RuntimeError("Diretório de boot recusado")
    info = regular_owned(target, mode=0o700)
    if not (home / "codex-bridge-main" / "autostart" / "supabase-launcher.py").is_file():
        raise RuntimeError("Novo checkout não localizado")
    # Refuse unexpected originals instead of trying to reconstruct an existing boot script.
    current = target.read_bytes()
    matches = list(PATTERN.finditer(current))
    if len(matches) != 1:
        raise RuntimeError("Atribuição bridge_dir ausente ou duplicada")
    raw = matches[0].group(2)
    old_variants = {OLD.encode(), ('"'+OLD+'"').encode(), ("'"+OLD+"'").encode()}
    new_variants = {NEW.encode(), ('"'+NEW+'"').encode(), ("'"+NEW+"'").encode()}
    if raw in new_variants:
        return "JÁ CORRIGIDO"
    if raw not in old_variants:
        raise RuntimeError("Atribuição bridge_dir inesperada")
    replacement = raw.replace(OLD.encode(), NEW.encode())
    patched = current[:matches[0].start(2)] + replacement + current[matches[0].end(2):]
    # Validate an isolated temporary copy, never execute boot hooks.
    with tempfile.TemporaryDirectory() as tmp:
        testfile = Path(tmp) / FILENAME
        testfile.write_bytes(patched)
        subprocess.run(["bash", "-n", str(testfile)], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if not apply:
        return "DRY-RUN APROVADO (sem alterações)"
    backupdir = home / "bridge-resgate"
    if not backupdir.exists():
        backupdir.mkdir(mode=0o700)
    if backupdir.is_symlink() or not backupdir.is_dir() or backupdir.stat().st_uid != os.getuid() or stat.S_IMODE(backupdir.stat().st_mode) != 0o700:
        raise RuntimeError("Diretório de backup inseguro")
    backup = backupdir / ("boot-path-"+datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")+".bak")
    with backup.open("xb") as f:
        os.fchmod(f.fileno(), 0o600)
        f.write(current)
        f.flush()
        os.fsync(f.fileno())
    if target.read_bytes() != current or target.lstat().st_ino != info.st_ino:
        raise RuntimeError("Arquivo mudou durante a operação; backup preservado")
    fd, name = tempfile.mkstemp(prefix=".boot-repair-", dir=bootdir)
    try:
        with os.fdopen(fd, "wb") as f:
            os.fchmod(f.fileno(), stat.S_IMODE(info.st_mode))
            f.write(patched)
            f.flush()
            os.fsync(f.fileno())
        os.replace(name, target)
        assert target.read_bytes() == patched
    finally:
        if os.path.exists(name):
            os.unlink(name)
    return "APLICADO E VALIDADO; backup criado: " + str(backup)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Aplicar após backup; padrão é apenas verificar")
    args = parser.parse_args()
    try:
        print(repair(Path.home(), args.apply))
    except (OSError, RuntimeError, subprocess.CalledProcessError) as exc:
        parser.exit(1, "RECUSADO: "+str(exc)+"\n")
