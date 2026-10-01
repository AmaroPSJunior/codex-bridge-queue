"""Optional SQL integration; CI only, disposable bridge_test on localhost.
PGHOST=127.0.0.1 PGDATABASE=bridge_test python3 tests/test_dashboard_postgres.py --disposable-local-database
No production credentials, no Supabase service calls. Auth/Broadcast functions are stubs.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import uuid


def main():
    if '--disposable-local-database' not in sys.argv or os.environ.get('PGDATABASE') != 'bridge_test' or os.environ.get('PGHOST') not in ('localhost', '127.0.0.1'):
        print('Refused: disposable local bridge_test required.')
        return 2
    root = Path(__file__).resolve().parent.parent
    schema = 'dash_test_' + uuid.uuid4().hex
    auth = schema + '_auth'
    realtime = schema + '_rt'
    private = schema + '_private'
    uid = '00000000-0000-0000-0000-000000000001'
    tid = '00000000-0000-0000-0000-000000000002'
    def sql(query, fail=False):
        p = subprocess.run(['psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], input=query, text=True, capture_output=True, timeout=40)
        if fail:
            assert p.returncode != 0, 'Expected rejection'
            return ''
        assert p.returncode == 0, 'SQL test failed; potentially sensitive output suppressed'
        return p.stdout.strip()
    def read(query, fail=False):
        return sql(f"SET ROLE authenticated; SET request.jwt.claim.sub='{uid}'; " + query, fail)
    def migration(name):
        return (root / 'database' / name).read_text().replace('public.', schema+'.').replace('auth.', auth+'.').replace('realtime.', realtime+'.').replace('bridge_dashboard_private',private)
    try:
        sql(f"CREATE SCHEMA {schema}; CREATE SCHEMA {auth}; CREATE SCHEMA {realtime};")
        sql("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF; IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; END $$;")
        sql(f"GRANT USAGE ON SCHEMA {schema} TO anon,authenticated; CREATE TABLE {auth}.users(id uuid,raw_app_meta_data jsonb); INSERT INTO {auth}.users VALUES ('{uid}','{{}}'); CREATE FUNCTION {auth}.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;")
        sql(f"CREATE TABLE {schema}.bridge_tasks(id uuid PRIMARY KEY,instruction text,status text,created_at timestamptz DEFAULT now(),claimed_at timestamptz,completed_at timestamptz,updated_at timestamptz); INSERT INTO {schema}.bridge_tasks(id,instruction,status) VALUES ('{tid}','PRIVATE INSTRUCTION','queued');")
        sql(migration('dashboard-read.sql')); sql(migration('dashboard-read.sql'))
        read(f'SELECT {schema}.bridge_dashboard_list();', fail=True)
        sql(f"SET ROLE anon; SELECT {schema}.bridge_dashboard_list();", fail=True)
        sql(f"UPDATE {auth}.users SET raw_app_meta_data='{{\"bridge_dashboard\":true}}';")
        rows = json.loads(read(f'SELECT {schema}.bridge_dashboard_list();'))
        assert rows[0]['task_name'] == 'Tarefa sem título'
        assert 'instruction' not in rows[0] and 'recent_output' not in rows[0]
        assert rows[0]['progress_seq'] == '0'
        read(f'SELECT * FROM {schema}.bridge_tasks;', fail=True)
        read(f"UPDATE {schema}.bridge_tasks SET status='running';", fail=True)
        read(f"SELECT {schema}.bridge_dashboard_list(p_status=>'invalid');", fail=True)
        assert json.loads(read(f"SELECT {schema}.bridge_dashboard_list(p_query=>'missing');")) == []
        sql(f"ALTER TABLE {schema}.bridge_tasks ADD task_number bigint,ADD title text,ADD recent_output text,ADD progress_seq bigint; UPDATE {schema}.bridge_tasks SET task_number=12,title='Diagnóstico',recent_output=E'normal\\nAuthorization: fixture\\nlast',progress_seq=9007199254740993;")
        row = json.loads(read(f"SELECT {schema}.bridge_dashboard_detail('{tid}');"))
        assert row['task_number'] == '12' and row['progress_seq'] == '9007199254740993'
        assert not row['output_available'] and row['recent_output'] is None
        sql(f"UPDATE {auth}.users SET raw_app_meta_data='{{\"bridge_dashboard\":true,\"bridge_dashboard_logs\":true}}';")
        row = json.loads(read(f"SELECT {schema}.bridge_dashboard_detail('{tid}');"))
        assert row['output_available'] and 'fixture' not in row['recent_output'] and 'last' in row['recent_output']
        sql(f"UPDATE {schema}.bridge_tasks SET recent_output=repeat(E'line\\n',700);")
        row = json.loads(read(f"SELECT {schema}.bridge_dashboard_detail('{tid}');"))
        assert len(row['recent_output'].split('\n')) <= 500
        sql(f"UPDATE {schema}.bridge_tasks SET recent_output=repeat(repeat('é',1000)||E'\\n',500);")
        row = json.loads(read(f"SELECT {schema}.bridge_dashboard_detail('{tid}');"))
        assert len(json.dumps(row['recent_output'],ensure_ascii=False).encode()) <= 524288
        stats = json.loads(read(f'SELECT {schema}.bridge_dashboard_stats();'))
        assert stats['counts']['queued'] == 1 and stats['total'] == 1 and len(stats['buckets']) == 4
        sql(f"CREATE TABLE {realtime}.messages(payload jsonb); ALTER TABLE {realtime}.messages ENABLE ROW LEVEL SECURITY; CREATE FUNCTION {realtime}.topic() RETURNS text LANGUAGE sql AS $$ SELECT 'bridge-dashboard'::text $$; CREATE FUNCTION {realtime}.send(jsonb,text,text,boolean) RETURNS void LANGUAGE sql AS $$ INSERT INTO {realtime}.messages VALUES ($1) $$;")
        sql(migration('dashboard-realtime.sql')); sql(migration('dashboard-realtime.sql'))
        sql(f"UPDATE {schema}.bridge_tasks SET status='running';")
        payload = json.loads(sql(f'SELECT payload FROM {realtime}.messages LIMIT 1;'))
        assert set(payload) == {'id','progress_seq','operation'}
        sql(f"CREATE OR REPLACE FUNCTION {realtime}.send(jsonb,text,text,boolean) RETURNS void LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture unavailable'; END $$;")
        sql(f"UPDATE {schema}.bridge_tasks SET status='succeeded';")
        assert sql(f'SELECT status FROM {schema}.bridge_tasks;') == 'succeeded'
        print('DASHBOARD SQL PASSED: denied anon/unapproved, no direct table access, legacy schema, bigint, redaction gate, bounds, aggregates, idempotence, private minimal broadcast, queue isolation.')
    finally:
        sql(f'DROP SCHEMA IF EXISTS {schema} CASCADE; DROP SCHEMA IF EXISTS {private} CASCADE; DROP SCHEMA IF EXISTS {auth} CASCADE; DROP SCHEMA IF EXISTS {realtime} CASCADE;')
    return 0

if __name__ == '__main__':
    sys.exit(main())
