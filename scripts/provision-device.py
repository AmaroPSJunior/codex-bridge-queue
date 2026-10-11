#!/usr/bin/env python3
"""Generate device identity and one-time credentials locally, never in GitHub Actions.
Does not contact Supabase, register a device or install a worker.
Run on a trusted provisioning machine only; output directory MUST be private.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import stat
import uuid

def provision(output: Path, name: str, kind: str):
    if kind not in ('android_phone', 'android_head_unit'):
        raise ValueError('Invalid device kind')
    if not 1 <= len(name) <= 80 or any(ord(c) < 32 for c in name):
        raise ValueError('Invalid device name')
    if output.is_symlink() or not output.is_dir() or output.stat().st_uid != os.getuid() or stat.S_IMODE(output.stat().st_mode) != 0o700:
        raise ValueError('Output directory must be owned by user and mode 0700')
    device_id = str(uuid.uuid4())
    token = secrets.token_urlsafe(48)
    digest = hashlib.sha256(token.encode()).hexdigest()
    # Write one private secret file with exclusive create, no stdout secret.
    secret = output / ('device-' + device_id + '.json')
    fd = os.open(secret, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump({'device_id':device_id,'token':token}, f)
            f.flush()
            os.fsync(f.fileno())
    except BaseException:
        secret.unlink(missing_ok=True)
        raise
    # An admin must separately register hash through a controlled, authenticated path.
    return {'device_id':device_id, 'display_name':name, 'device_kind':kind, 'token_sha256':digest,
            'secret_path':str(secret), 'enabled':False}

if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--private-dir', required=True)
    p.add_argument('--name', required=True)
    p.add_argument('--kind', choices=['android_phone','android_head_unit'],required=True)
    args=p.parse_args()
    result=provision(Path(args.private_dir),args.name,args.kind)
    print(json.dumps(result,ensure_ascii=False))
