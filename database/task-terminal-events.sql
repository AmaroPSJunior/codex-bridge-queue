-- Durable, sanitized terminal transcript for each bridge task.
-- The worker writes with service_role; dashboard reads go through a gated RPC.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

create table if not exists public.bridge_task_terminal_events (
  seq bigint generated always as identity primary key,
  event_key uuid not null unique,
  task_id uuid not null references public.bridge_tasks(id) on delete cascade,
  event_type text not null check (event_type in ('command_start','output','command_end')),
  command_key text,
  command text,
  stream text check (stream is null or stream in ('stdout','stderr')),
  content text,
  exit_code integer,
  created_at timestamptz not null default now(),
  check (command is null or octet_length(command)<=8192),
  check (content is null or octet_length(content)<=524288)
);
create index if not exists bridge_task_terminal_events_task_seq_idx
  on public.bridge_task_terminal_events(task_id,seq);
alter table public.bridge_task_terminal_events enable row level security;
revoke all on public.bridge_task_terminal_events from public,anon,authenticated;
grant all on public.bridge_task_terminal_events to service_role;

create or replace function bridge_dashboard_private.bridge_dashboard_terminal_events(
  p_id uuid,p_after_seq bigint default 0,p_limit integer default 500
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare answer jsonb;
begin
  if not bridge_dashboard_private.bridge_dashboard_allowed(true) then
    raise exception 'Dashboard log access denied' using errcode='42501';
  end if;
  if p_after_seq<0 then raise exception 'Invalid cursor'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'seq',q.seq::text,'event_type',q.event_type,'command_key',q.command_key,
    'command',q.command,'stream',q.stream,'content',q.content,
    'exit_code',q.exit_code,'created_at',q.created_at
  ) order by q.seq),'[]'::jsonb) into answer
  from (
    select e.seq,e.event_type,e.command_key,
      bridge_dashboard_private.bridge_dashboard_safe(e.command,2000) as command,
      e.stream,bridge_dashboard_private.bridge_dashboard_safe(e.content,524288) as content,
      e.exit_code,e.created_at
    from public.bridge_task_terminal_events e
    where e.task_id=p_id and e.seq>p_after_seq
    order by e.seq asc limit greatest(1,least(coalesce(p_limit,500),501))
  ) q;
  return answer;
end; $$;
revoke all on function bridge_dashboard_private.bridge_dashboard_terminal_events(uuid,bigint,integer) from public,anon;
grant execute on function bridge_dashboard_private.bridge_dashboard_terminal_events(uuid,bigint,integer) to authenticated;

create or replace function public.bridge_dashboard_terminal_events(p_id uuid,p_after_seq bigint default 0,p_limit integer default 500)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select bridge_dashboard_private.bridge_dashboard_terminal_events(p_id,p_after_seq,p_limit);
$$;
revoke all on function public.bridge_dashboard_terminal_events(uuid,bigint,integer) from public,anon;
grant execute on function public.bridge_dashboard_terminal_events(uuid,bigint,integer) to authenticated;
commit;
