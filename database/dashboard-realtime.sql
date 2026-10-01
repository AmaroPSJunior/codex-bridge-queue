-- Optional: run AFTER dashboard-read.sql, only on Supabase with Realtime enabled.
-- Private Broadcast sends no instructions, names, output, result or errors.
-- Review existing realtime.messages policies: permissive policies combine with OR.
begin;
set local lock_timeout='5s';
create or replace function bridge_dashboard_private.bridge_dashboard_notify()
returns trigger language plpgsql security definer set search_path = '' as $$
declare r jsonb;
begin
 r:=case when TG_OP='DELETE' then to_jsonb(old) else to_jsonb(new) end;
 perform realtime.send(jsonb_build_object('id',r->>'id','progress_seq',coalesce(r->>'progress_seq','0'),'operation',TG_OP),'task_changed','bridge-dashboard',true);
 return null;
exception when others then
 -- Observability must not prevent claiming/finalization. Fallback/manual refresh
 -- still works; Realtime availability must be checked during deployment.
 return null;
end; $$;
revoke all on function bridge_dashboard_private.bridge_dashboard_notify() from public,anon,authenticated;
drop trigger if exists bridge_dashboard_changed on public.bridge_tasks;
create trigger bridge_dashboard_changed after insert or update or delete on public.bridge_tasks for each row execute function bridge_dashboard_private.bridge_dashboard_notify();
drop policy if exists bridge_dashboard_receive on realtime.messages;
create policy bridge_dashboard_receive on realtime.messages for select to authenticated
using (realtime.topic()='bridge-dashboard' and public.bridge_dashboard_allowed());
commit;
