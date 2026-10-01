"""Optional REAL PostgreSQL integration: only an explicitly disposable local database.
CI runs this separately. npm test does not need PostgreSQL or network.
"""
import concurrent.futures
import os
from pathlib import Path
import subprocess
import sys
import uuid


def main():
    if '--disposable-local-database' not in sys.argv or os.environ.get('PGDATABASE')!='bridge_test' or os.environ.get('PGHOST') not in ('127.0.0.1','localhost'):
        print('Refused: requires --disposable-local-database, PGDATABASE=bridge_test and local PGHOST.')
        return 2
    schema='bridge_test_'+uuid.uuid4().hex
    def sql(query, fail=False):
        p=subprocess.run(['psql','-X','-qAt','-v','ON_ERROR_STOP=1'],input=query,text=True,capture_output=True,timeout=40)
        if fail:
            assert p.returncode!=0, 'Expected database rejection'
            return ''
        if p.returncode:
            raise AssertionError('PostgreSQL test query failed; output suppressed')
        return p.stdout.strip()
    root=Path(__file__).resolve().parent.parent
    try:
        sql(f'CREATE SCHEMA {schema}; CREATE TABLE {schema}.bridge_tasks(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), instruction text NOT NULL, status text DEFAULT \'queued\', created_at timestamptz NOT NULL DEFAULT now()); INSERT INTO {schema}.bridge_tasks(instruction) VALUES (\'legacy one\'),(\'legacy two\');')
        sql(f"UPDATE {schema}.bridge_tasks SET created_at=CASE instruction WHEN 'legacy one' THEN '2026-01-02'::timestamptz ELSE '2026-01-01'::timestamptz END;")
        ids=sql(f'SELECT string_agg(id::text,\',\' ORDER BY id) FROM {schema}.bridge_tasks;')
        migration=(root/'database/task-identity.sql').read_text().replace('public.',schema+'.')
        sql(migration)
        assert sql(f'SELECT min(task_number)||\',\'||max(task_number)||\',\'||count(DISTINCT task_number) FROM {schema}.bridge_tasks;')=='1,2,2'
        assert sql(f"SELECT string_agg(title,',' ORDER BY task_number) FROM {schema}.bridge_tasks;")=='Tarefa 1,Tarefa 2'
        assert sql(f"SELECT instruction FROM {schema}.bridge_tasks WHERE task_number=1;")=='legacy two'
        sql(f"UPDATE {schema}.bridge_tasks SET status='running' WHERE instruction='legacy one';")
        assert sql(f"SELECT task_number FROM {schema}.bridge_tasks WHERE instruction='legacy one';")=='2'
        before=sql(f'SELECT string_agg(id::text,\',\' ORDER BY id) FROM {schema}.bridge_tasks;');assert before==ids
        def insert(i):
            return int(sql(f"INSERT INTO {schema}.bridge_tasks(instruction,title) VALUES ('concurrent','Task {i}') RETURNING task_number;"))
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            numbers=list(pool.map(insert,range(16)))
        assert len(set(numbers))==16 and sorted(numbers)==list(range(3,19))
        sql(f"INSERT INTO {schema}.bridge_tasks(instruction,task_number) VALUES ('forged',1);",fail=True)
        sql(f'UPDATE {schema}.bridge_tasks SET task_number=999 WHERE task_number=1;',fail=True)
        assert sql(f"INSERT INTO {schema}.bridge_tasks(instruction,title) VALUES ('blank','  ') RETURNING title;").startswith('Tarefa ')
        old=sql(f'SELECT string_agg(task_number::text,\',\' ORDER BY task_number) FROM {schema}.bridge_tasks;')
        sql(migration)
        assert sql(f'SELECT string_agg(task_number::text,\',\' ORDER BY task_number) FROM {schema}.bridge_tasks;')==old
        progress=(root/'database/task-progress.sql').read_text().replace('public.',schema+'.').replace("table_schema='public'",f"table_schema='{schema}'")
        sql(progress);sql(progress)
        assert sql(f'SELECT count(*) FROM {schema}.bridge_tasks WHERE progress_seq=0;') == sql(f'SELECT count(*) FROM {schema}.bridge_tasks;')
        sql(f"UPDATE {schema}.bridge_tasks SET status='running' WHERE task_number=1;")
        def flush_progress(_):
            return sql(f"UPDATE {schema}.bridge_tasks SET progress_seq=1,recent_output='line',progress_message='Working',last_flush_reason='lines',last_flush_line_count=1 WHERE task_number=1 AND progress_seq=0 RETURNING progress_seq;")
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            winners=list(pool.map(flush_progress,range(16)))
        assert winners.count('1')==1 and winners.count('')==15
        assert sql(f'SELECT last_progress_at IS NOT NULL FROM {schema}.bridge_tasks WHERE task_number=1;')=='t'
        sql(f'UPDATE {schema}.bridge_tasks SET progress_seq=0 WHERE task_number=1;',fail=True)
        sql(f'UPDATE {schema}.bridge_tasks SET progress_seq=NULL WHERE task_number=1;',fail=True)
        sql(f"UPDATE {schema}.bridge_tasks SET progress_seq=2,last_flush_line_count=0 WHERE task_number=1;",fail=True)
        sql(f"UPDATE {schema}.bridge_tasks SET progress_seq=2,last_flush_reason='invalid' WHERE task_number=1;",fail=True)
        sql(f"UPDATE {schema}.bridge_tasks SET progress_seq=2,recent_output=repeat(E'line\\n',500) WHERE task_number=1;",fail=True)
        sql(f"UPDATE {schema}.bridge_tasks SET progress_seq=2,recent_output=repeat('x',524288) WHERE task_number=1;",fail=True)
        assert sql(f'SELECT progress_seq FROM {schema}.bridge_tasks WHERE task_number=1;')=='1'
        sql(f"UPDATE {schema}.bridge_tasks SET progress_seq=2,recent_output='',last_flush_reason='command_end',last_flush_line_count=1 WHERE task_number=1;")
        sql(f"UPDATE {schema}.bridge_tasks SET status='succeeded' WHERE task_number=1;")
        assert sql(f'SELECT progress_seq FROM {schema}.bridge_tasks WHERE task_number=1;')=='2'
        sql(progress)
        assert sql(f'SELECT progress_seq FROM {schema}.bridge_tasks WHERE task_number=1;')=='2'
        sql(migration)
        assert sql(f'SELECT progress_seq FROM {schema}.bridge_tasks WHERE task_number=1;')=='2'
        print('POSTGRES progress: defaults, concurrent atomic increment, server time, metadata validation, rollback, bounds, empty line, rerun, lifecycle.')
        print('POSTGRES PASSED: backfill, UUID preservation, 16 concurrent inserts, uniqueness, immutable numbers, legacy titles, rerun.')
    finally:
        sql(f'DROP SCHEMA IF EXISTS {schema} CASCADE;')
    return 0


if __name__=='__main__':
    sys.exit(main())
