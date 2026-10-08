-- Aplicado ao Supabase em 2026-10-08. Mantém as 100 tarefas mais novas.
-- Tarefas queued/running/paused são protegidas, mesmo fora das 100 mais recentes.
create or replace function bridge_dashboard_private.bridge_tasks_retain_latest_100()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  delete from public.bridge_tasks t
  where t.task_number in (
    select old.task_number from public.bridge_tasks old
    where old.task_number is not null
      and old.status in ('succeeded','failed','cancelled')
      and old.task_number not in (
        select recent.task_number from public.bridge_tasks recent
        order by recent.task_number desc limit 100
      )
  );
  return null;
end;
$$;
revoke all on function bridge_dashboard_private.bridge_tasks_retain_latest_100() from public, anon, authenticated;
drop trigger if exists bridge_tasks_retention_100_insert on public.bridge_tasks;
create trigger bridge_tasks_retention_100_insert after insert on public.bridge_tasks
for each statement execute function bridge_dashboard_private.bridge_tasks_retain_latest_100();
drop trigger if exists bridge_tasks_retention_100_update on public.bridge_tasks;
create trigger bridge_tasks_retention_100_update after update on public.bridge_tasks
for each statement execute function bridge_dashboard_private.bridge_tasks_retain_latest_100();
