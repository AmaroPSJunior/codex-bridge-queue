-- Realtime synchronization v2: safe row payload + durable revision fallback.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

create table if not exists bridge_dashboard_private.dashboard_revision(
  singleton boolean primary key default true check(singleton),
  revision bigint not null default 0,
  updated_at timestamptz not null default clock_timestamp()
);
revoke all on bridge_dashboard_private.dashboard_revision from public,anon,authenticated;
insert into bridge_dashboard_private.dashboard_revision(singleton,revision)
values(true,0) on conflict(singleton) do nothing;

create or replace function bridge_dashboard_private.bridge_dashboard_notify()
returns trigger language plpgsql security definer set search_path = '' as $$
declare r jsonb; rev bigint; safe_task jsonb;
begin
 r:=case when TG_OP='DELETE' then to_jsonb(old) else to_jsonb(new) end;
 update bridge_dashboard_private.dashboard_revision
 set revision=revision+1,updated_at=clock_timestamp()
 where singleton=true returning revision into rev;
 safe_task:=case when TG_OP='DELETE' then null else bridge_dashboard_private.bridge_dashboard_projection(r) end;
 begin
  perform realtime.send(
   jsonb_strip_nulls(jsonb_build_object(
    'id',r->>'id',
    'progress_seq',coalesce(r->>'progress_seq','0'),
    'operation',TG_OP,
    'revision',rev,
    'task',safe_task
   )),
   'task_changed','bridge-dashboard',true
  );
 exception when others then
  null;
 end;
 return null;
end; $$;
revoke all on function bridge_dashboard_private.bridge_dashboard_notify() from public,anon,authenticated;

drop trigger if exists bridge_dashboard_changed on public.bridge_tasks;
create trigger bridge_dashboard_changed
after insert or update or delete on public.bridge_tasks
for each row execute function bridge_dashboard_private.bridge_dashboard_notify();

create or replace function bridge_dashboard_private.bridge_dashboard_revision()
returns bigint language plpgsql stable security definer set search_path='' as $$
declare answer bigint;
begin
 if not bridge_dashboard_private.bridge_dashboard_allowed() then raise exception 'Dashboard access denied' using errcode='42501'; end if;
 select revision into answer from bridge_dashboard_private.dashboard_revision where singleton=true;
 return coalesce(answer,0);
end; $$;
revoke all on function bridge_dashboard_private.bridge_dashboard_revision() from public,anon;
grant execute on function bridge_dashboard_private.bridge_dashboard_revision() to authenticated;

create or replace function public.bridge_dashboard_revision()
returns bigint language sql stable security invoker set search_path='' as $$
 select bridge_dashboard_private.bridge_dashboard_revision();
$$;
revoke all on function public.bridge_dashboard_revision() from public,anon;
grant execute on function public.bridge_dashboard_revision() to authenticated;

commit;
