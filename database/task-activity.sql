-- Reviewed deployment SQL; NOT applied by the worker. Existing RLS/grants stay unchanged.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
alter table public.bridge_tasks add column if not exists activity_seq bigint not null default 0 check(activity_seq>=0);
alter table public.bridge_tasks add column if not exists last_activity_at timestamptz;
alter table public.bridge_tasks add column if not exists activity_max_gap_ms bigint not null default 0 check(activity_max_gap_ms>=0);
-- Preserve the deployed projection, including fields added by other migrations.
do $$ begin
 if to_regprocedure('bridge_dashboard_private.bridge_dashboard_projection_before_activity(jsonb)') is null then
  alter function bridge_dashboard_private.bridge_dashboard_projection(jsonb) rename to bridge_dashboard_projection_before_activity;
 end if;
end $$;
create or replace function bridge_dashboard_private.bridge_dashboard_projection(p_row jsonb)
returns jsonb language sql immutable set search_path='' as $$
 select bridge_dashboard_private.bridge_dashboard_projection_before_activity(p_row) || jsonb_build_object(
 'activity_seq',p_row->>'activity_seq','last_activity_at',p_row->>'last_activity_at','activity_max_gap_ms',p_row->'activity_max_gap_ms');
$$;
revoke all on function bridge_dashboard_private.bridge_dashboard_projection(jsonb) from public,anon,authenticated;
commit;
