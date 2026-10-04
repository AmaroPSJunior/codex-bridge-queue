-- Optional dashboard read API. Apply as database administrator after review.
-- No bridge_tasks grants/policies are relaxed; no task lifecycle changes.
-- Uses JSON projection so pending identity/progress migrations remain optional.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
create schema if not exists bridge_dashboard_private;
revoke all on schema bridge_dashboard_private from public,anon;
grant usage on schema bridge_dashboard_private to authenticated;
create or replace function bridge_dashboard_private.bridge_dashboard_allowed(p_logs boolean default false)
returns boolean language sql stable security definer set search_path = '' as $$
 select exists(select 1 from auth.users u where u.id=auth.uid()
   and coalesce(to_jsonb(u)->>'is_anonymous','false')='false'
   and coalesce(u.raw_app_meta_data->>'bridge_dashboard','true')<>'false'
   and (not p_logs or u.raw_app_meta_data->>'bridge_dashboard_logs'='true'));
$$;
revoke all on function bridge_dashboard_private.bridge_dashboard_allowed(boolean) from public,anon;
grant execute on function bridge_dashboard_private.bridge_dashboard_allowed(boolean) to authenticated;

-- Defense in depth; this is NOT proof that arbitrary terminal text is safe.
-- Logs additionally require verified upstream redaction + explicit account grant.
create or replace function bridge_dashboard_private.bridge_dashboard_safe(p_text text,p_max integer default 160)
returns text language sql immutable set search_path = '' as $$
 select left(regexp_replace(case when coalesce(p_text,'') ~* '(secret|token|password|passwd|senha|authorization|bearer|service.role|api.key|sb_secret_|eyJ[A-Za-z0-9_-]{12}|gh[pousr]_|AKIA[0-9A-Z]|-----BEGIN.*KEY)' then '[conteúdo restrito]' else coalesce(p_text,'') end,
 '[[:cntrl:]]',' ','g'),greatest(0,least(p_max,524288)));
$$;
revoke all on function bridge_dashboard_private.bridge_dashboard_safe(text,integer) from public,anon,authenticated;

create or replace function bridge_dashboard_private.bridge_dashboard_projection(p_row jsonb)
returns jsonb language sql immutable set search_path = '' as $$
 select jsonb_build_object(
 'id',p_row->>'id', 'task_number',p_row->>'task_number',
 'task_name',bridge_dashboard_private.bridge_dashboard_safe(coalesce(nullif(p_row->>'task_name',''),nullif(p_row->>'title',''),'Tarefa sem título'),80),
 'status',p_row->>'status','created_at',p_row->>'created_at','claimed_at',p_row->>'claimed_at',
 'completed_at',p_row->>'completed_at','updated_at',p_row->>'updated_at',
 'progress_message',bridge_dashboard_private.bridge_dashboard_safe(p_row->>'progress_message',160),
 'progress_seq',coalesce(p_row->>'progress_seq','0'), 'last_progress_at',p_row->>'last_progress_at',
 'last_flush_reason',case when p_row->>'last_flush_reason' in ('lines','timeout','command_end','final') then p_row->>'last_flush_reason' else null end,
 'last_flush_line_count',p_row->'last_flush_line_count',
 'requested_provider',case when p_row->>'requested_provider' in ('codex','antigravity','claude','local','groq','auto') then p_row->>'requested_provider' end,
 'actual_provider',case when p_row->>'actual_provider' in ('codex','antigravity','claude','local','groq') then p_row->>'actual_provider' end,
 'provider_model',case when p_row->>'provider_model' in ('openai/gpt-oss-120b','openai/gpt-oss-20b') then p_row->>'provider_model' end,
 'fallback_from',case when p_row->>'fallback_from' in ('codex','antigravity','claude','local','groq') then p_row->>'fallback_from' end,
 'fallback_reason',case when p_row->>'fallback_reason' in ('rate_limit','quota','authentication','permission','network','http','timeout','unavailable','protocol','manual') then p_row->>'fallback_reason' end);
$$;
revoke all on function bridge_dashboard_private.bridge_dashboard_projection(jsonb) from public,anon,authenticated;

create or replace function bridge_dashboard_private.bridge_dashboard_list(p_limit integer default 50,p_status text default null,p_query text default null,p_before_created timestamptz default null,p_before_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare answer jsonb;
begin
 if not bridge_dashboard_private.bridge_dashboard_allowed() then raise exception 'Dashboard access denied' using errcode='42501'; end if;
 if p_status is not null and p_status not in ('queued','running','succeeded','failed','cancelled') then raise exception 'Invalid status'; end if;
 if length(p_query)>120 then raise exception 'Query too long'; end if;
 select coalesce(jsonb_agg(q.item order by q.created_at desc,q.id desc),'[]'::jsonb) into answer from (
  select bridge_dashboard_private.bridge_dashboard_projection(to_jsonb(t)) item,t.created_at,t.id from public.bridge_tasks t
  where (p_status is null or t.status=p_status)
    and (p_before_created is null or (t.created_at,t.id)<(p_before_created,p_before_id))
    and (coalesce(p_query,'')='' or position(lower(p_query) in lower(coalesce(to_jsonb(t)->>'task_number','')||' '||coalesce(to_jsonb(t)->>'task_name',to_jsonb(t)->>'title','Tarefa sem título')))>0)
  order by t.created_at desc,t.id desc limit greatest(1,least(coalesce(p_limit,50),50))
 ) q;
 return answer;
end; $$;
revoke all on function bridge_dashboard_private.bridge_dashboard_list(integer,text,text,timestamptz,uuid) from public,anon;
grant execute on function bridge_dashboard_private.bridge_dashboard_list(integer,text,text,timestamptz,uuid) to authenticated;

-- Single-row metadata refresh for Broadcast; never retrieves output bodies.
create or replace function bridge_dashboard_private.bridge_dashboard_summary(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare answer jsonb;
begin
 if not bridge_dashboard_private.bridge_dashboard_allowed() then raise exception 'Dashboard access denied' using errcode='42501'; end if;
 select bridge_dashboard_private.bridge_dashboard_projection(to_jsonb(t)) into answer from public.bridge_tasks t where t.id=p_id;
 return answer;
end; $$;
revoke all on function bridge_dashboard_private.bridge_dashboard_summary(uuid) from public,anon;
grant execute on function bridge_dashboard_private.bridge_dashboard_summary(uuid) to authenticated;

create or replace function bridge_dashboard_private.bridge_dashboard_detail(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare row_data jsonb; answer jsonb; lines text[]; clean text:=''; line_text text; logs boolean;
begin
 if not bridge_dashboard_private.bridge_dashboard_allowed() then raise exception 'Dashboard access denied' using errcode='42501'; end if;
 select to_jsonb(t) into row_data from public.bridge_tasks t where t.id=p_id;
 if row_data is null then return null; end if;
 logs:=bridge_dashboard_private.bridge_dashboard_allowed(true) and row_data ? 'recent_output';
 if logs then
  -- Discard oldest first. 512 KiB counts JSON serialized UTF-8 including escapes.
  lines:=string_to_array(coalesce(row_data->>'recent_output',''),E'\n');
  if cardinality(lines)>500 then lines:=lines[cardinality(lines)-499:cardinality(lines)]; end if;
  foreach line_text in array lines loop
   clean:=clean||case when clean='' then '' else E'\n' end||bridge_dashboard_private.bridge_dashboard_safe(line_text,524288);
  end loop;
  lines:=string_to_array(clean,E'\n');
  while octet_length(to_jsonb(array_to_string(lines,E'\n'))::text)>524288 and cardinality(lines)>0 loop
   lines:=lines[2:cardinality(lines)];
  end loop;
  clean:=array_to_string(lines,E'\n');
 end if;
 answer:=bridge_dashboard_private.bridge_dashboard_projection(row_data)||jsonb_build_object('output_available',logs,'recent_output',case when logs then clean else null end,
 'result_summary',case row_data->>'status' when 'succeeded' then 'Tarefa finalizada com sucesso. Consulte o resultado completo pela integração autorizada.' when 'failed' then 'Tarefa finalizada com falha. Consulte o erro pela integração autorizada.' else 'Conteúdo completo disponível pela integração autorizada.' end);
 return answer;
end; $$;
revoke all on function bridge_dashboard_private.bridge_dashboard_detail(uuid) from public,anon;
grant execute on function bridge_dashboard_private.bridge_dashboard_detail(uuid) to authenticated;

create or replace function bridge_dashboard_private.bridge_dashboard_stats()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare answer jsonb;
begin
 if not bridge_dashboard_private.bridge_dashboard_allowed() then raise exception 'Dashboard access denied' using errcode='42501'; end if;
 with scoped as (select t.* from public.bridge_tasks t where created_at>=now()-interval '30 days'),
 counts as (select count(*) total,count(*) filter(where status='queued') queued,count(*) filter(where status='running') running,count(*) filter(where status='succeeded') succeeded,count(*) filter(where status='failed') failed,count(*) filter(where status='cancelled') cancelled,
 avg(greatest(0,extract(epoch from claimed_at-created_at))) filter(where claimed_at is not null) wait,
 avg(greatest(0,extract(epoch from completed_at-claimed_at))) filter(where claimed_at is not null and completed_at is not null) duration from scoped),
 days as (select to_char(created_at at time zone 'UTC','YYYY-MM-DD') as "day",count(*) count from scoped group by 1),
 throughput as (select to_char(completed_at at time zone 'UTC','YYYY-MM-DD') as "day",count(*) count from scoped where completed_at is not null group by 1),
 buckets as (select case when extract(epoch from completed_at-claimed_at)<60 then 0 when extract(epoch from completed_at-claimed_at)<300 then 1 when extract(epoch from completed_at-claimed_at)<900 then 2 else 3 end bucket,count(*) n from scoped where completed_at is not null and claimed_at is not null group by 1),
 names as (select bridge_dashboard_private.bridge_dashboard_safe(coalesce(to_jsonb(s)->>'task_name',to_jsonb(s)->>'title','Tarefa sem título'),80) name,count(*) n from scoped s group by 1 order by 2 desc,1 limit 6)
 select jsonb_build_object('total',c.total,'counts',jsonb_build_object('queued',c.queued,'running',c.running,'succeeded',c.succeeded,'failed',c.failed,'cancelled',c.cancelled),
 'completionRate',coalesce(100.0*c.succeeded/nullif(c.succeeded+c.failed+c.cancelled,0),0),'avgWait',c.wait,'avgDuration',c.duration,
 'days',coalesce((select jsonb_agg(to_jsonb(d) order by "day") from days d),'[]'),
 'throughput',coalesce((select jsonb_agg(to_jsonb(d) order by "day") from throughput d),'[]'),
 'buckets',(select jsonb_agg(coalesce(b.n,0) order by i) from generate_series(0,3) i left join buckets b on b.bucket=i),
 'names',coalesce((select jsonb_agg(jsonb_build_array(name,n)) from names),'[]')) into answer from counts c;
 return answer;
end; $$;
revoke all on function bridge_dashboard_private.bridge_dashboard_stats() from public,anon;
grant execute on function bridge_dashboard_private.bridge_dashboard_stats() to authenticated;
-- Public RPC entry points invoke gated functions in a non-exposed schema.
create or replace function public.bridge_dashboard_allowed(p_logs boolean default false)
returns boolean language sql stable security invoker set search_path = '' as $$ select bridge_dashboard_private.bridge_dashboard_allowed(p_logs); $$;
create or replace function public.bridge_dashboard_list(p_limit integer default 50,p_status text default null,p_query text default null,p_before_created timestamptz default null,p_before_id uuid default null)
returns jsonb language sql stable security invoker set search_path = '' as $$ select bridge_dashboard_private.bridge_dashboard_list(p_limit,p_status,p_query,p_before_created,p_before_id); $$;
create or replace function public.bridge_dashboard_summary(p_id uuid)
returns jsonb language sql stable security invoker set search_path = '' as $$ select bridge_dashboard_private.bridge_dashboard_summary(p_id); $$;
create or replace function public.bridge_dashboard_detail(p_id uuid)
returns jsonb language sql stable security invoker set search_path = '' as $$ select bridge_dashboard_private.bridge_dashboard_detail(p_id); $$;
create or replace function public.bridge_dashboard_stats()
returns jsonb language sql stable security invoker set search_path = '' as $$ select bridge_dashboard_private.bridge_dashboard_stats(); $$;
revoke all on function public.bridge_dashboard_allowed(boolean),public.bridge_dashboard_list(integer,text,text,timestamptz,uuid),public.bridge_dashboard_summary(uuid),public.bridge_dashboard_detail(uuid),public.bridge_dashboard_stats() from public,anon;
grant execute on function public.bridge_dashboard_allowed(boolean),public.bridge_dashboard_list(integer,text,text,timestamptz,uuid),public.bridge_dashboard_summary(uuid),public.bridge_dashboard_detail(uuid),public.bridge_dashboard_stats() to authenticated;
commit;
