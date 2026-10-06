-- Authenticated dashboard task deletion.
-- Running tasks are protected from deletion.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

create or replace function public.bridge_dashboard_delete(p_id uuid)
returns boolean
language plpgsql
security definer
set search_path=''
as $$
declare
  current_status text;
begin
  if not bridge_dashboard_private.bridge_dashboard_allowed() then
    raise exception 'Dashboard access denied' using errcode='42501';
  end if;

  select status into current_status
  from public.bridge_tasks
  where id=p_id
  for update;

  if current_status is null then
    return false;
  end if;

  if current_status='running' then
    raise exception 'Running tasks cannot be deleted' using errcode='55000';
  end if;

  delete from public.bridge_tasks where id=p_id;
  return true;
end;
$$;

revoke all on function public.bridge_dashboard_delete(uuid) from public,anon;
grant execute on function public.bridge_dashboard_delete(uuid) to authenticated;
commit;
