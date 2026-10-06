-- Public aggregate Realtime support for GitHub Pages.
-- Exposes counts/provider state only; never task names, instructions, results or output.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

create or replace function public.bridge_dashboard_public_stats()
returns jsonb
language sql
stable
security definer
set search_path=''
as $$
  with counts as (
    select
      count(*) filter (where status='queued')::int queued,
      count(*) filter (where status='running')::int running,
      count(*) filter (where status='succeeded')::int succeeded,
      count(*) filter (where status='failed')::int failed,
      count(*) filter (where status='cancelled')::int cancelled
    from public.bridge_tasks
  ),
  providers as (
    select coalesce(
      jsonb_agg(jsonb_build_object('provider',provider,'state',state) order by provider)
      filter (where provider in ('codex','groq','antigravity','claude','local')
        and state in ('ready','quota_exceeded','auth_error','unavailable')),
      '[]'::jsonb
    ) value
    from public.bridge_provider_state
  )
  select jsonb_build_object(
    'counts',jsonb_build_object(
      'queued',c.queued,'running',c.running,'succeeded',c.succeeded,
      'failed',c.failed,'cancelled',c.cancelled
    ),
    'updated_at',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'providers',p.value
  )
  from counts c cross join providers p;
$$;

revoke all on function public.bridge_dashboard_public_stats() from public;
grant execute on function public.bridge_dashboard_public_stats() to anon,authenticated;

create or replace function bridge_dashboard_private.bridge_dashboard_notify()
returns trigger language plpgsql security definer set search_path='' as $$
declare r jsonb;
begin
 r:=case when TG_OP='DELETE' then to_jsonb(old) else to_jsonb(new) end;
 perform realtime.send(
   jsonb_build_object('id',r->>'id','progress_seq',coalesce(r->>'progress_seq','0'),'operation',TG_OP),
   'task_changed','bridge-dashboard',true
 );
 perform realtime.send(jsonb_build_object('changed',true),'public_summary_changed','bridge-dashboard-public',false);
 return null;
exception when others then
 return null;
end; $$;

create or replace function bridge_dashboard_private.bridge_dashboard_provider_notify()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 perform realtime.send(jsonb_build_object('changed',true),'public_summary_changed','bridge-dashboard-public',false);
 return null;
exception when others then
 return null;
end; $$;
revoke all on function bridge_dashboard_private.bridge_dashboard_provider_notify() from public,anon,authenticated;

drop trigger if exists bridge_dashboard_provider_changed on public.bridge_provider_state;
create trigger bridge_dashboard_provider_changed
after insert or update or delete on public.bridge_provider_state
for each row execute function bridge_dashboard_private.bridge_dashboard_provider_notify();

commit;
