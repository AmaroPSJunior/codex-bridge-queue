-- Ephemeral live telemetry for the authenticated dashboard.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
create or replace function public.bridge_dashboard_live_emit(p_task_id uuid,p_events jsonb)
returns boolean language plpgsql security definer set search_path='' as $$
declare item jsonb; clean jsonb; kind text; msg text; n integer:=0; pct integer; step_i integer; step_n integer;
begin
 if jsonb_typeof(p_events)<>'array' or jsonb_array_length(p_events)>20 then raise exception 'Invalid live event batch'; end if;
 for item in select value from jsonb_array_elements(p_events) loop
  n:=n+1; kind:=item->>'kind'; if kind not in ('output','stage','system','retry','command') then kind:='system'; end if;
  msg:=bridge_dashboard_private.bridge_dashboard_safe(item->>'message',1000);
  begin pct:=(item->>'percent')::integer; exception when others then pct:=null; end; if pct is not null then pct:=greatest(0,least(100,pct)); end if;
  begin step_i:=(item->>'step_index')::integer; exception when others then step_i:=null; end; begin step_n:=(item->>'step_total')::integer; exception when others then step_n:=null; end;
  clean:=jsonb_strip_nulls(jsonb_build_object('id',p_task_id::text,'event_seq',left(coalesce(item->>'event_seq',n::text),32),'kind',kind,'message',msg,'stage',left(coalesce(item->>'stage',''),32),'step_index',case when step_i between 0 and 999 then step_i end,'step_total',case when step_n between 1 and 1000 then step_n end,'percent',pct,'at',coalesce(item->>'at',clock_timestamp()::text)));
  perform realtime.send(clean,'live_activity','bridge-dashboard',true);
 end loop; return true;
end; $$;
revoke all on function public.bridge_dashboard_live_emit(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.bridge_dashboard_live_emit(uuid,jsonb) to service_role;
commit;
