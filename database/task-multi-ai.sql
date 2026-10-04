-- Stage 09 proposal. Apply only after disposable SQL tests and live-schema review.
-- No status, task IDs, existing policies, or task-table grants are changed.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='bridge_tasks' AND c.relrowsecurity) THEN
  RAISE EXCEPTION 'Existing bridge_tasks RLS required';
 END IF;
END $$;
ALTER TABLE public.bridge_tasks
 ADD COLUMN IF NOT EXISTS requested_provider text,
 ADD COLUMN IF NOT EXISTS actual_provider text,
 ADD COLUMN IF NOT EXISTS provider_model text,
 ADD COLUMN IF NOT EXISTS provider_session_id text,
 ADD COLUMN IF NOT EXISTS fallback_from text,
 ADD COLUMN IF NOT EXISTS fallback_reason text;
DO $$ BEGIN
 IF (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='bridge_tasks' AND data_type='text'
 AND column_name IN ('requested_provider','actual_provider','provider_model','provider_session_id','fallback_from','fallback_reason'))<>6 THEN RAISE EXCEPTION 'Incompatible Multi-IA columns'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.bridge_tasks'::regclass AND conname='bridge_multi_ai_values') THEN
  ALTER TABLE public.bridge_tasks ADD CONSTRAINT bridge_multi_ai_values CHECK (
   (requested_provider IS NULL OR requested_provider IN ('codex','antigravity','claude','local','groq','auto')) AND
   (actual_provider IS NULL OR actual_provider IN ('codex','antigravity','claude','local','groq')) AND
   (fallback_from IS NULL OR fallback_from IN ('codex','antigravity','claude','local','groq')) AND
   (fallback_reason IS NULL OR fallback_reason IN ('rate_limit','quota','authentication','permission','network','http','timeout','unavailable','protocol','manual')) AND
   ((fallback_from IS NULL AND fallback_reason IS NULL) OR (fallback_from IS NOT NULL AND fallback_reason IS NOT NULL AND actual_provider IS NOT NULL AND actual_provider<>fallback_from)) AND
   (provider_model IS NULL OR (actual_provider IS NOT NULL AND length(provider_model) BETWEEN 1 AND 128 AND provider_model ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]*$' AND provider_model !~* '(secret|token|password|credential|bearer|gsk_|sk-|sb_|github_pat_|gh[pousr]_)')) AND
   (provider_session_id IS NULL OR (actual_provider IS NOT NULL AND length(provider_session_id) BETWEEN 1 AND 256 AND provider_session_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]*$' AND provider_session_id !~* '(secret|token|password|credential|bearer|gsk_|sk-|sb_|github_pat_|gh[pousr]_)'))
  );
 END IF;
END $$;
CREATE TABLE IF NOT EXISTS public.bridge_provider_state (
 provider text PRIMARY KEY CHECK(provider IN ('codex','antigravity','claude','local','groq')),
 state text NOT NULL CHECK(state IN ('ready','quota_exceeded','auth_error','unavailable')),
 observed_since timestamptz NOT NULL,
 checked_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.bridge_provider_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.bridge_provider_state FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON TABLE public.bridge_provider_state TO service_role;
-- Authenticated clients have no direct policy or grant. No credentials/error bodies stored.
CREATE OR REPLACE FUNCTION public.bridge_record_multi_ai(p_task_id uuid,p_requested text,p_actual text,p_model text,p_session text,p_state text)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE started timestamptz;
BEGIN
 IF p_actual IS NULL OR p_requested IS NULL OR p_state IS NULL THEN RAISE EXCEPTION 'Missing provider observation'; END IF;
 UPDATE public.bridge_tasks SET requested_provider=coalesce(requested_provider,p_requested),actual_provider=p_actual,
  provider_model=p_model,provider_session_id=p_session
 WHERE id=p_task_id AND status='running' RETURNING coalesce(claimed_at,created_at) INTO started;
 IF NOT FOUND THEN RETURN false; END IF;
 INSERT INTO public.bridge_provider_state(provider,state,observed_since,checked_at)
 VALUES(p_actual,p_state,started,now())
 ON CONFLICT(provider) DO UPDATE SET state=excluded.state,observed_since=excluded.observed_since,checked_at=excluded.checked_at
 WHERE excluded.observed_since>=bridge_provider_state.observed_since;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.bridge_record_multi_ai(uuid,text,text,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.bridge_record_multi_ai(uuid,text,text,text,text,text) TO service_role;
-- Gated dashboard RPCs: optional existing account authorization must already exist.
CREATE SCHEMA IF NOT EXISTS bridge_dashboard_private;
REVOKE ALL ON SCHEMA bridge_dashboard_private FROM PUBLIC,anon;
GRANT USAGE ON SCHEMA bridge_dashboard_private TO authenticated;
CREATE OR REPLACE FUNCTION bridge_dashboard_private.bridge_multi_ai_projection(p jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path='' AS $$
 SELECT jsonb_build_object(
 'requested_provider',CASE WHEN p->>'requested_provider' IN ('codex','antigravity','claude','local','groq','auto') THEN p->>'requested_provider' END,
 'actual_provider',CASE WHEN p->>'actual_provider' IN ('codex','antigravity','claude','local','groq') THEN p->>'actual_provider' END,
 -- Only explicitly reviewed public model identifiers may be displayed.
 'provider_model',CASE WHEN p->>'provider_model' IN ('openai/gpt-oss-120b','openai/gpt-oss-20b') THEN p->>'provider_model' END,
 'fallback_from',CASE WHEN p->>'fallback_from' IN ('codex','antigravity','claude','local','groq') THEN p->>'fallback_from' END,
 'fallback_reason',CASE WHEN p->>'fallback_reason' IN ('rate_limit','quota','authentication','permission','network','http','timeout','unavailable','protocol','manual') THEN p->>'fallback_reason' END);
$$;
REVOKE ALL ON FUNCTION bridge_dashboard_private.bridge_multi_ai_projection(jsonb) FROM PUBLIC,anon,authenticated;
CREATE OR REPLACE FUNCTION bridge_dashboard_private.bridge_dashboard_multi_ai(p_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE task_meta jsonb; providers jsonb;
BEGIN
 IF to_regprocedure('bridge_dashboard_private.bridge_dashboard_allowed(boolean)') IS NULL THEN RAISE EXCEPTION 'Dashboard access denied' USING errcode='42501'; END IF;
 IF NOT bridge_dashboard_private.bridge_dashboard_allowed() THEN RAISE EXCEPTION 'Dashboard access denied' USING errcode='42501'; END IF;
 SELECT bridge_dashboard_private.bridge_multi_ai_projection(to_jsonb(t)) INTO task_meta FROM public.bridge_tasks t WHERE t.id=p_id;
 SELECT coalesce(jsonb_agg(jsonb_build_object('provider',provider,'state',state,'checked_at',checked_at) ORDER BY provider),'[]'::jsonb) INTO providers FROM public.bridge_provider_state;
 RETURN jsonb_build_object('task',task_meta,'providers',providers);
END $$;
REVOKE ALL ON FUNCTION bridge_dashboard_private.bridge_dashboard_multi_ai(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION bridge_dashboard_private.bridge_dashboard_multi_ai(uuid) TO authenticated;
CREATE OR REPLACE FUNCTION public.bridge_dashboard_multi_ai(p_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $$ SELECT bridge_dashboard_private.bridge_dashboard_multi_ai(p_id); $$;
REVOKE ALL ON FUNCTION public.bridge_dashboard_multi_ai(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.bridge_dashboard_multi_ai(uuid) TO authenticated;

-- Upgrade only the reviewed projection; preserve unknown remote customizations.
DO $upgrade$
DECLARE body text;
BEGIN
 SELECT prosrc INTO body FROM pg_proc WHERE oid=to_regprocedure('bridge_dashboard_private.bridge_dashboard_projection(jsonb)');
 IF body IS NOT NULL AND md5(btrim(body))=md5(btrim($old$ select jsonb_build_object(
 'id',p_row->>'id', 'task_number',p_row->>'task_number',
 'task_name',bridge_dashboard_private.bridge_dashboard_safe(coalesce(nullif(p_row->>'task_name',''),nullif(p_row->>'title',''),'Tarefa sem título'),80),
 'status',p_row->>'status','created_at',p_row->>'created_at','claimed_at',p_row->>'claimed_at',
 'completed_at',p_row->>'completed_at','updated_at',p_row->>'updated_at',
 'progress_message',bridge_dashboard_private.bridge_dashboard_safe(p_row->>'progress_message',160),
 'progress_seq',coalesce(p_row->>'progress_seq','0'), 'last_progress_at',p_row->>'last_progress_at',
 'last_flush_reason',case when p_row->>'last_flush_reason' in ('lines','timeout','command_end','final') then p_row->>'last_flush_reason' else null end,
 'last_flush_line_count',p_row->'last_flush_line_count');$old$)) THEN
  EXECUTE $ddl$CREATE OR REPLACE FUNCTION bridge_dashboard_private.bridge_dashboard_projection(p_row jsonb)
  RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path='' AS $body$ select jsonb_build_object(
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
 'fallback_reason',case when p_row->>'fallback_reason' in ('rate_limit','quota','authentication','permission','network','http','timeout','unavailable','protocol','manual') then p_row->>'fallback_reason' end);$body$$ddl$;
 ELSIF body IS NOT NULL AND md5(btrim(body))<>md5(btrim($new$ select jsonb_build_object(
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
 'fallback_reason',case when p_row->>'fallback_reason' in ('rate_limit','quota','authentication','permission','network','http','timeout','unavailable','protocol','manual') then p_row->>'fallback_reason' end);$new$)) THEN
  RAISE NOTICE 'Custom dashboard projection preserved; use bridge_dashboard_multi_ai RPC';
 END IF;
END $upgrade$;
COMMIT;
