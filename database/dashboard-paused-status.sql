begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

create or replace function bridge_dashboard_private.bridge_dashboard_list(
 p_limit integer default 50,
 p_status text default null,
 p_query text default null,
 p_before_created timestamptz default null,
 p_before_id uuid default null
)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare answer jsonb;
begin
 if not bridge_dashboard_private.bridge_dashboard_allowed() then raise exception 'Dashboard access denied' using errcode='42501'; end if;
 if p_status is not null and p_status not in ('queued','paused','running','succeeded','failed','cancelled') then raise exception 'Invalid status'; end if;
 if length(p_query)>120 then raise exception 'Query too long'; end if;
 select coalesce(jsonb_agg(q.item order by q.created_at desc,q.id desc),'[]'::jsonb) into answer from (
  select bridge_dashboard_private.bridge_dashboard_projection(to_jsonb(t)) item,t.created_at,t.id
  from public.bridge_tasks t
  where (p_status is null or t.status=p_status)
    and (p_before_created is null or (t.created_at,t.id)<(p_before_created,p_before_id))
    and (coalesce(p_query,'')='' or position(lower(p_query) in lower(coalesce(to_jsonb(t)->>'task_number','')||' '||coalesce(to_jsonb(t)->>'task_name',to_jsonb(t)->>'title','Tarefa sem título')))>0)
  order by t.created_at desc,t.id desc
  limit greatest(1,least(coalesce(p_limit,50),50))
 ) q;
 return answer;
end; $$;

revoke all on function bridge_dashboard_private.bridge_dashboard_list(integer,text,text,timestamptz,uuid) from public,anon;
grant execute on function bridge_dashboard_private.bridge_dashboard_list(integer,text,text,timestamptz,uuid) to authenticated;
commit;
