-- PROPOSAL ONLY. Apply after phase2, review and disposable PostgreSQL tests.
-- No scheduler, automatic requeue, credentials or production rollout.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';
ALTER TABLE public.bridge_tasks ADD COLUMN IF NOT EXISTS device_lease_expires_at timestamptz;
ALTER TABLE public.bridge_tasks ADD COLUMN IF NOT EXISTS device_replay_safe boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS public.bridge_device_recovery_config (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 lease_seconds integer NOT NULL CHECK(lease_seconds BETWEEN 30 AND 86400)
);
INSERT INTO public.bridge_device_recovery_config VALUES(true,300) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS public.bridge_device_completion_receipts (
 task_id uuid NOT NULL, claim_nonce uuid NOT NULL, device_id uuid NOT NULL,
 success boolean NOT NULL, result_digest text NOT NULL,
 completed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(task_id,claim_nonce)
);
CREATE TABLE IF NOT EXISTS public.bridge_device_recovery_audit (
 task_id uuid NOT NULL, claim_nonce uuid NOT NULL,
 retry boolean NOT NULL, reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 500),
 authorized_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(task_id,claim_nonce)
);
ALTER TABLE public.bridge_device_recovery_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bridge_device_completion_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bridge_device_recovery_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bridge_device_recovery_config,public.bridge_device_completion_receipts,public.bridge_device_recovery_audit FROM PUBLIC,anon,authenticated;
-- Configuration updates are administrative only. No default lease for old claims.
CREATE OR REPLACE FUNCTION public.bridge_device_claim(
  p_device_id uuid, p_token text
) RETURNS TABLE(task_id uuid, task_number bigint, instruction text,
                execution_mode text, command_payload jsonb, claim_nonce uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE v_id uuid; v_lease integer;
BEGIN
  IF NOT public.bridge_device_token_valid(p_device_id,p_token) THEN
    RETURN;
  END IF;
  SELECT lease_seconds INTO v_lease FROM public.bridge_device_recovery_config WHERE singleton;
  IF v_lease IS NULL THEN RAISE EXCEPTION 'Recovery lease configuration missing'; END IF;
  SELECT t.id INTO v_id
    FROM public.bridge_tasks t
   WHERE t.status='queued' AND t.executor_device_id=p_device_id
     AND t.execution_mode='command'
   ORDER BY t.created_at,t.id
   FOR UPDATE SKIP LOCKED LIMIT 1;
  IF v_id IS NULL THEN RETURN; END IF;
  PERFORM set_config('bridge.authorized_device_claim',v_id::text,true);
  RETURN QUERY
    UPDATE public.bridge_tasks t SET
      status='running',claimed_at=now(),updated_at=now(),
      device_claim_nonce=gen_random_uuid(),
      device_lease_expires_at=now()+make_interval(secs=>v_lease),
      device_replay_safe=coalesce((t.execution_mode='command' AND t.command_payload='{"command":"pwd","args":[],"cwd":"."}'::jsonb),false)
    WHERE t.id=v_id AND t.status='queued' AND t.executor_device_id=p_device_id
    RETURNING t.id,t.task_number,t.instruction,t.execution_mode,
              t.command_payload,t.device_claim_nonce;
END;
$$;

CREATE OR REPLACE FUNCTION public.bridge_device_complete(
 p_device_id uuid,p_token text,p_task_id uuid,p_claim_nonce uuid,p_success boolean,p_result text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v_count integer; v_digest text;
BEGIN
 IF NOT public.bridge_device_token_valid(p_device_id,p_token)
    OR p_claim_nonce IS NULL OR p_success IS NULL OR p_result IS NULL
    OR octet_length(p_result)>8192 THEN RETURN false; END IF;
 v_digest:=encode(sha256(convert_to(p_result,'UTF8')),'hex');
 -- Serialize completion and recovery for the same reservation.
 PERFORM 1 FROM public.bridge_tasks WHERE id=p_task_id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM public.bridge_device_completion_receipts
   WHERE task_id=p_task_id AND claim_nonce=p_claim_nonce AND device_id=p_device_id
     AND success=p_success AND result_digest=v_digest) THEN RETURN true; END IF;
 -- Expiration permits administrative review; it does not itself invalidate a claim.
 UPDATE public.bridge_tasks SET
   status=CASE WHEN p_success THEN 'succeeded' ELSE 'failed' END,
   result=CASE WHEN p_success THEN p_result ELSE NULL END,
   error=CASE WHEN p_success THEN NULL ELSE p_result END,
   completed_at=now(),updated_at=now()
 WHERE id=p_task_id AND status='running' AND executor_device_id=p_device_id
   AND device_claim_nonce=p_claim_nonce;
 GET DIAGNOSTICS v_count=ROW_COUNT;
 IF v_count<>1 THEN RETURN false; END IF;
 INSERT INTO public.bridge_device_completion_receipts(task_id,claim_nonce,device_id,success,result_digest)
 VALUES(p_task_id,p_claim_nonce,p_device_id,p_success,v_digest);
 RETURN true;
END; $$;
CREATE OR REPLACE FUNCTION public.bridge_device_recover(
 p_task_id uuid,p_claim_nonce uuid,p_retry boolean,p_reason text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t public.bridge_tasks%ROWTYPE;
BEGIN
 IF p_retry IS NULL OR p_reason IS NULL OR length(p_reason)>500 OR length(trim(p_reason))<1 THEN RETURN false; END IF;
 SELECT * INTO t FROM public.bridge_tasks WHERE id=p_task_id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM public.bridge_device_recovery_audit
   WHERE task_id=p_task_id AND claim_nonce=p_claim_nonce AND retry=p_retry AND reason=p_reason) THEN RETURN true; END IF;
 IF EXISTS(SELECT 1 FROM public.bridge_device_recovery_audit
   WHERE task_id=p_task_id AND claim_nonce=p_claim_nonce) THEN RETURN false; END IF;
 IF t.id IS NULL OR t.status<>'running' OR t.executor_device_id IS NULL
   OR t.device_claim_nonce IS DISTINCT FROM p_claim_nonce OR p_claim_nonce IS NULL
   OR t.device_lease_expires_at IS NULL OR t.device_lease_expires_at>now() THEN RETURN false; END IF;
 -- Only the literal audited pilot operation is replayable, checked at claim AND recovery.
 IF p_retry AND (NOT t.device_replay_safe OR t.execution_mode<>'command'
    OR t.command_payload IS DISTINCT FROM '{"command":"pwd","args":[],"cwd":"."}'::jsonb) THEN RETURN false; END IF;
 INSERT INTO public.bridge_device_recovery_audit(task_id,claim_nonce,retry,reason)
 VALUES(p_task_id,p_claim_nonce,p_retry,p_reason);
 IF p_retry THEN
   UPDATE public.bridge_tasks SET status='queued',device_claim_nonce=gen_random_uuid(),
     device_lease_expires_at=NULL,device_replay_safe=false,claimed_at=NULL,updated_at=now()
   WHERE id=p_task_id;
 END IF;
 -- retry=false records uncertainty without changing task state or claiming it again.
 RETURN true;
END; $$;
REVOKE ALL ON FUNCTION public.bridge_device_recover(uuid,uuid,boolean,text) FROM PUBLIC,anon,authenticated,service_role;
-- Only the administrative migration owner can recover; no API role grant.
REVOKE ALL ON FUNCTION public.bridge_device_token_valid(uuid,text) FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
