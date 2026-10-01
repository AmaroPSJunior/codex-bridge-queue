#!/usr/bin/env python3
"""Opt-in read-only reachability checks. Never enqueue or execute a task."""
import argparse
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import urllib.request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('transport', choices=['github', 'supabase'])
    parser.add_argument('--allow-network', action='store_true')
    args = parser.parse_args()
    if not args.allow_network:
        print('Not run: explicitly add --allow-network for a read-only smoke test.')
        return 2
    root = Path(__file__).resolve().parent.parent
    config = json.loads((root/'remote-config.json').read_text())
    if args.transport == 'github':
        repo = config['repository']
        for endpoint in [f'repos/{repo}', f'repos/{repo}/issues?state=open&per_page=1']:
            r = subprocess.run(['gh', 'api', '--hostname', 'github.com', endpoint, '--method', 'GET'],
                               capture_output=True, timeout=20)
            if r.returncode:
                raise RuntimeError()
            value = json.loads(r.stdout)
            if endpoint == f'repos/{repo}' and not (value.get('private') and value.get('has_issues')):
                raise RuntimeError()
    else:
        key = os.environ.get('CODEX_SUPABASE_SERVICE_ROLE_KEY')
        if not key:
            secret = Path.home()/'.config/codex-bridge/supabase-service-role.key'
            if secret.is_symlink() or stat.S_IMODE(secret.stat().st_mode) != 0o600:
                raise RuntimeError()
            key = secret.read_text()
        url = config['supabase']['url'].rstrip('/')
        if not url.startswith('https://'):
            raise RuntimeError()
        # Refuse redirects so authentication cannot move to another origin.
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *unused, **kwargs):
                return None
        request = urllib.request.Request(url+'/rest/v1/bridge_tasks?select=id&limit=1',
                    headers={'apikey':key, 'Authorization':'Bearer '+key}, method='GET')
        with urllib.request.build_opener(NoRedirect).open(request, timeout=20) as response:
            if response.status != 200 or not isinstance(json.load(response), list):
                raise RuntimeError()
    print(args.transport + ': read-only smoke passed; no task created or executed.')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        print('Smoke failed: check authentication, configuration and connectivity locally; response suppressed.', file=sys.stderr)
        sys.exit(1)
