-- Apply after dashboard-read.sql. Project-wide authenticated summaries only.
-- Logs still require an explicit server-managed grant; no table grants/RLS changes.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
create or replace function bridge_dashboard_private.bridge_dashboard_allowed(p_logs boolean default false)
returns boolean language sql stable security definer set search_path = '' as $$
 select exists(select 1 from auth.users u where u.id=auth.uid()
   and coalesce(to_jsonb(u)->>'is_anonymous','false')='false'
   and coalesce(u.raw_app_meta_data->>'bridge_dashboard','true')<>'false'
   and (not p_logs or u.raw_app_meta_data->>'bridge_dashboard_logs'='true'));
$$;
revoke all on function bridge_dashboard_private.bridge_dashboard_allowed(boolean) from public,anon;
grant execute on function bridge_dashboard_private.bridge_dashboard_allowed(boolean) to authenticated;

commit;
