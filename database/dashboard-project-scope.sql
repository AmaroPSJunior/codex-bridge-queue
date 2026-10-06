begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

create or replace function bridge_dashboard_private.bridge_dashboard_projection(p_row jsonb)
returns jsonb language sql immutable set search_path = '' as $$
 select jsonb_build_object(
 'id',p_row->>'id','project_id',p_row->>'project_id','task_number',p_row->>'task_number',
 'task_name',bridge_dashboard_private.bridge_dashboard_safe(coalesce(nullif(p_row->>'task_name',''),nullif(p_row->>'title',''),'Tarefa sem título'),80),
 'status',p_row->>'status','created_at',p_row->>'created_at','claimed_at',p_row->>'claimed_at',
 'completed_at',p_row->>'completed_at','updated_at',p_row->>'updated_at',
 'progress_message',bridge_dashboard_private.bridge_dashboard_safe(p_row->>'progress_message',160),
 'progress_percent',case when coalesce(p_row->>'progress_percent','') ~ '^[0-9]+$' then least(100,greatest(0,(p_row->>'progress_percent')::integer)) else null end,
 'progress_seq',coalesce(p_row->>'progress_seq','0'),'last_progress_at',p_row->>'last_progress_at',
 'last_flush_reason',case when p_row->>'last_flush_reason' in ('lines','timeout','command_end','final') then p_row->>'last_flush_reason' end,
 'last_flush_line_count',p_row->'last_flush_line_count',
 'requested_provider',case when p_row->>'requested_provider' in ('codex','antigravity','claude','local','groq','auto') then p_row->>'requested_provider' end,
 'actual_provider',case when p_row->>'actual_provider' in ('codex','antigravity','claude','local','groq') then p_row->>'actual_provider' end,
 'provider_model',case when p_row->>'provider_model' in ('openai/gpt-oss-120b','openai/gpt-oss-20b') then p_row->>'provider_model' end,
 'fallback_from',case when p_row->>'fallback_from' in ('codex','antigravity','claude','local','groq') then p_row->>'fallback_from' end,
 'fallback_reason',case when p_row->>'fallback_reason' in ('rate_limit','quota','authentication','permission','network','http','timeout','unavailable','protocol','manual') then p_row->>'fallback_reason' end);
$$;

create or replace function public.bridge_dashboard_project_list(
 p_project_id uuid,
 p_limit integer default 50,
 p_status text default null,
 p_query text default null,
 p_before_created timestamptz default null,
 p_before_id uuid default null
)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare answer jsonb;
begin
 if not bridge_dashboard_private.bridge_dashboard_allowed() then raise exception 'Dashboard access denied' using errcode='42501'; end if;
 if p_project_id is null or not exists(select 1 from public.bridge_projects p where p.id=p_project_id and p.is_active) then raise exception 'Invalid project'; end if;
 if p_status is not null and p_status not in ('queued','paused','running','succeeded','failed','cancelled') then raise exception 'Invalid status'; end if;
 if length(p_query)>120 then raise exception 'Query too long'; end if;
 select coalesce(jsonb_agg(q.item order by q.created_at desc,q.id desc),'[]'::jsonb) into answer from (
   select bridge_dashboard_private.bridge_dashboard_projection(to_jsonb(t)) item,t.created_at,t.id
   from public.bridge_tasks t
   where t.project_id=p_project_id
     and (p_status is null or t.status=p_status)
     and (p_before_created is null or (t.created_at,t.id)<(p_before_created,p_before_id))
     and (coalesce(p_query,'')='' or position(lower(p_query) in lower(coalesce(to_jsonb(t)->>'task_number','')||' '||coalesce(to_jsonb(t)->>'task_name',to_jsonb(t)->>'title','Tarefa sem título')))>0)
   order by t.created_at desc,t.id desc
   limit greatest(1,least(coalesce(p_limit,50),50))
 ) q;
 return answer;
end $$;
revoke all on function public.bridge_dashboard_project_list(uuid,integer,text,text,timestamptz,uuid) from public,anon;
grant execute on function public.bridge_dashboard_project_list(uuid,integer,text,text,timestamptz,uuid) to authenticated;

create or replace function public.bridge_dashboard_project_stats(p_project_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare answer jsonb;
begin
 if not bridge_dashboard_private.bridge_dashboard_allowed() then raise exception 'Dashboard access denied' using errcode='42501'; end if;
 if p_project_id is null or not exists(select 1 from public.bridge_projects p where p.id=p_project_id and p.is_active) then raise exception 'Invalid project'; end if;
 with scoped as (
   select t.* from public.bridge_tasks t where t.project_id=p_project_id and t.created_at>=now()-interval '30 days'
 ), counts as (
   select count(*) total,
    count(*) filter(where status='queued') queued,
    count(*) filter(where status='paused') paused,
    count(*) filter(where status='running') running,
    count(*) filter(where status='succeeded') succeeded,
    count(*) filter(where status='failed') failed,
    count(*) filter(where status='cancelled') cancelled,
    avg(greatest(0,extract(epoch from claimed_at-created_at))) filter(where claimed_at is not null) wait,
    avg(greatest(0,extract(epoch from completed_at-claimed_at))) filter(where claimed_at is not null and completed_at is not null) duration
   from scoped
 ), days as (
   select to_char(created_at at time zone 'UTC','YYYY-MM-DD') "day",count(*) count from scoped group by 1
 ), buckets as (
   select case when extract(epoch from completed_at-claimed_at)<60 then 0 when extract(epoch from completed_at-claimed_at)<300 then 1 when extract(epoch from completed_at-claimed_at)<900 then 2 else 3 end bucket,count(*) n
   from scoped where completed_at is not null and claimed_at is not null group by 1
 )
 select jsonb_build_object(
   'total',c.total,
   'counts',jsonb_build_object('queued',c.queued,'paused',c.paused,'running',c.running,'succeeded',c.succeeded,'failed',c.failed,'cancelled',c.cancelled),
   'completionRate',coalesce(100.0*c.succeeded/nullif(c.succeeded+c.failed+c.cancelled,0),0),
   'avgWait',c.wait,'avgDuration',c.duration,
   'days',coalesce((select jsonb_agg(to_jsonb(d) order by "day") from days d),'[]'),
   'buckets',(select jsonb_agg(coalesce(b.n,0) order by i) from generate_series(0,3)i left join buckets b on b.bucket=i),
   'names','[]'::jsonb
 ) into answer from counts c;
 return answer;
end $$;
revoke all on function public.bridge_dashboard_project_stats(uuid) from public,anon;
grant execute on function public.bridge_dashboard_project_stats(uuid) to authenticated;

create or replace function bridge_dashboard_private.bridge_dashboard_notify()
returns trigger language plpgsql security definer set search_path='' as $$
declare r jsonb; rev bigint; safe_task jsonb;
begin
 r:=case when TG_OP='DELETE' then to_jsonb(old) else to_jsonb(new) end;
 update bridge_dashboard_private.dashboard_revision set revision=revision+1,updated_at=clock_timestamp()
 where singleton=true returning revision into rev;
 safe_task:=case when TG_OP='DELETE' then null else bridge_dashboard_private.bridge_dashboard_projection(r) end;
 begin
  perform realtime.send(jsonb_strip_nulls(jsonb_build_object(
    'id',r->>'id','project_id',r->>'project_id','progress_seq',coalesce(r->>'progress_seq','0'),
    'operation',TG_OP,'revision',rev,'task',safe_task
  )),'task_changed','bridge-dashboard',true);
 exception when others then null;
 end;
 return null;
end $$;

commit;