-- Durable GitHub activity feed for the dashboard Ao Vivo.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

create table if not exists public.bridge_live_events(
  id bigint generated always as identity primary key,
  project_id uuid not null references public.bridge_projects(id) on delete cascade,
  source text not null check(source in ('github','bridge')),
  delivery_id text not null,
  event_type text not null,
  action text,
  stage text,
  status text,
  percent integer check(percent between 0 and 100),
  title text not null,
  message text,
  repo_full_name text,
  ref text,
  sha text,
  run_id bigint,
  run_url text,
  occurred_at timestamptz not null default clock_timestamp(),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp(),
  unique(source,delivery_id)
);
create index if not exists bridge_live_events_project_time_idx on public.bridge_live_events(project_id,occurred_at desc,id desc);
alter table public.bridge_live_events enable row level security;
revoke all on public.bridge_live_events from public,anon,authenticated;

create or replace function bridge_dashboard_private.bridge_dashboard_live_events(p_project_id uuid,p_limit integer default 100)
returns table(id bigint,project_id uuid,source text,delivery_id text,event_type text,action text,stage text,status text,percent integer,title text,message text,repo_full_name text,ref text,sha text,run_id bigint,run_url text,occurred_at timestamptz,created_at timestamptz) language plpgsql stable security definer set search_path='' as $
begin
 if not bridge_dashboard_private.bridge_dashboard_allowed() then raise exception 'Dashboard access denied' using errcode='42501'; end if;
 return query select e.id,e.project_id,e.source,e.delivery_id,e.event_type,e.action,e.stage,e.status,e.percent,e.title,e.message,e.repo_full_name,e.ref,e.sha,e.run_id,e.run_url,e.occurred_at,e.created_at from public.bridge_live_events e where e.project_id=p_project_id order by e.occurred_at desc,e.id desc limit greatest(1,least(coalesce(p_limit,100),200));
end; $fn$;
revoke all on function bridge_dashboard_private.bridge_dashboard_live_events(uuid,integer) from public,anon;
grant execute on function bridge_dashboard_private.bridge_dashboard_live_events(uuid,integer) to authenticated;

create or replace function public.bridge_dashboard_live_events(p_project_id uuid,p_limit integer default 100)
returns table(id bigint,project_id uuid,source text,delivery_id text,event_type text,action text,stage text,status text,percent integer,title text,message text,repo_full_name text,ref text,sha text,run_id bigint,run_url text,occurred_at timestamptz,created_at timestamptz) language sql stable security invoker set search_path='' as $
 select * from bridge_dashboard_private.bridge_dashboard_live_events(p_project_id,p_limit);
$fn$;
revoke all on function public.bridge_dashboard_live_events(uuid,integer) from public,anon;
grant execute on function public.bridge_dashboard_live_events(uuid,integer) to authenticated;

create or replace function bridge_dashboard_private.bridge_live_event_notify()
returns trigger language plpgsql security definer set search_path='' as $fn$
begin
 begin
  perform realtime.send(jsonb_build_object(
    'id',new.id,'project_id',new.project_id,'source',new.source,'event_type',new.event_type,
    'action',new.action,'stage',new.stage,'status',new.status,'percent',new.percent,
    'title',new.title,'message',new.message,'repo_full_name',new.repo_full_name,'ref',new.ref,
    'sha',new.sha,'run_id',new.run_id,'run_url',new.run_url,'occurred_at',new.occurred_at
  ),'github_activity','bridge-dashboard',true);
 exception when others then null;
 end;
 return null;
end; $fn$;
revoke all on function bridge_dashboard_private.bridge_live_event_notify() from public,anon,authenticated;
drop trigger if exists bridge_live_event_changed on public.bridge_live_events;
create trigger bridge_live_event_changed after insert on public.bridge_live_events for each row execute function bridge_dashboard_private.bridge_live_event_notify();
commit;
