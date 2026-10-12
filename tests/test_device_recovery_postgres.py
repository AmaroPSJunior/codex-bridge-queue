"""Real concurrent sessions, exclusively in an explicitly disposable CI database."""
import concurrent.futures
import hashlib
import os
from pathlib import Path
import subprocess
import sys
import threading
import uuid


def main():
    if '--disposable-local-database' not in sys.argv or os.environ.get('PGDATABASE') != 'bridge_test' or os.environ.get('PGHOST') not in ('localhost', '127.0.0.1'):
        print('Refused: explicit disposable local bridge_test database required.')
        return 2
    schema = 'device_recovery_test_' + uuid.uuid4().hex
    root = Path(__file__).resolve().parents[1]
    def sql(query, reject=False):
        r = subprocess.run(['psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], input=query, capture_output=True, text=True, timeout=40)
        if reject:
            assert r.returncode != 0
            return ''
        assert r.returncode == 0, 'Disposable SQL failed; output suppressed'
        return r.stdout.strip()
    def fn(name):
        return schema + '.bridge_device_' + name
    device = '10000000-0000-4000-8000-000000000001'
    token = 'A' * 64  # Synthetic, never a service credential.
    auth = "'%s','%s'" % (device, token)
    def enqueue():
        task = str(uuid.uuid4())
        sql(f"INSERT INTO {schema}.bridge_tasks(id,instruction,status,executor_device_id,command_payload) VALUES('{task}','fixture','queued','{device}','{{\"command\":\"pwd\",\"args\":[],\"cwd\":\".\"}}');")
        return task
    def claim():
        return sql(f"SELECT task_id||'|'||claim_nonce FROM {fn('claim')}({auth});")
    def race(a, b):
        barrier = threading.Barrier(2)
        def call(query):
            barrier.wait(timeout=10)
            return sql(query)
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(call, x) for x in (a,b)]
            return [f.result() for f in futures]
    try:
        sql(f"CREATE SCHEMA {schema}; DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF; END $$;")
        sql(f"CREATE TABLE {schema}.bridge_tasks(id uuid PRIMARY KEY,task_number bigint,instruction text,status text,execution_mode text DEFAULT 'command',command_payload jsonb,executor_device_id uuid,created_at timestamptz DEFAULT now(),claimed_at timestamptz,updated_at timestamptz,completed_at timestamptz,result text,error text);")
        for phase in ('phase1','phase2-draft','phase3-recovery-proposal'):
            sql((root/f'database/multi-device-{phase}.sql').read_text().replace('public.',schema+'.'))
        digest = hashlib.sha256(token.encode()).hexdigest()
        sql(f"INSERT INTO {schema}.bridge_devices(id,display_name,device_kind,enabled,token_sha256) VALUES('{device}','fixture','android_head_unit',true,'{digest}'); GRANT USAGE ON SCHEMA {schema} TO anon,authenticated,service_role;")
        for role in ('anon','authenticated','service_role'):
            sql(f"SET ROLE {role}; SELECT {fn('recover')}(gen_random_uuid(),gen_random_uuid(),true,'review');", reject=True)
        tasks = {enqueue() for _ in range(8)}
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            claims = list(pool.map(lambda _:claim(),range(8)))
        assert all(claims) and {c.split('|')[0] for c in claims} == tasks
        assert len({c.split('|')[1] for c in claims}) == 8
        for _ in range(12):
            task = enqueue()
            claimed = claim().split('|'); assert claimed[0] == task
            nonce = claimed[1]
            sql(f"UPDATE {schema}.bridge_tasks SET device_lease_expires_at=now()-interval '1 second' WHERE id='{task}';")
            complete = f"SELECT {fn('complete')}({auth},'{task}','{nonce}',true,'ok');"
            recover = f"SELECT {fn('recover')}('{task}','{nonce}',true,'review');"
            result = race(complete,recover)
            assert sorted(result) == ['f','t'], result
            state = sql(f"SELECT status FROM {schema}.bridge_tasks WHERE id='{task}';")
            if state == 'succeeded':
                assert sql(complete) == 't' and sql(recover) == 'f'
            else:
                assert state == 'queued' and sql(complete) == 'f'
                new = claim().split('|'); assert new[0] == task and new[1] != nonce
                assert sql(complete) == 'f'
                assert sql(f"SELECT {fn('complete')}({auth},'{task}','{new[1]}',true,'ok');") == 't'
        task = enqueue(); nonce = claim().split('|')[1]
        complete = f"SELECT {fn('complete')}({auth},'{task}','{nonce}',true,'same');"
        assert race(complete,complete) == ['t','t']
        assert sql(f"SELECT count(*) FROM {schema}.bridge_device_completion_receipts WHERE task_id='{task}';") == '1'
        print('PASS real PostgreSQL: parallel claims, completion/recovery races, nonce fencing, concurrent idempotency, recovery ACL')
    finally:
        sql(f'DROP SCHEMA IF EXISTS {schema} CASCADE;')
    return 0


if __name__ == '__main__':
    sys.exit(main())
