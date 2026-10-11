-- PHASE 2 PROPOSAL. Not deployed automatically; requires phase1, migration
-- review, disposable-db tests, and explicit production rollout authorization.
-- Token provisioner is intentionally NOT included: credential issue/revoke
-- remains a separate administrative operation.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE public.bridge_devices
  ADD COLUMN IF NOT EXISTS token_sha256 text,
  ADD COLUMN IF NOT EXISTS revoked_at timestamptz;
ALTER TABLE public.bridge_tasks
  ADD COLUMN IF NOT EXISTS device_claim_nonce uuid;

-- Do not expose credential hashes to client roles.
REVOKE ALL ON public.bridge_devices FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.bridge_tasks FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.bridge_device_token_valid(
  p_device_id uuid, p_token text
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT p_token IS NOT NULL
    AND length(p_token) BETWEEN 43 AND 128
    AND p_token ~ '^[A-Za-z0-9_-]+$'
    AND EXISTS (
      SELECT 1 FROM public.bridge_devices d
      WHERE d.id=p_device_id
        AND d.enabled
        AND d.revoked_at IS NULL
        AND d.token_sha256 IS NOT NULL
        AND d.token_sha256=encode(sha256(convert_to(p_token,'UTF8')),'hex')
    );
$$;

-- Keep the phase1 safety trigger. Only this reviewed RPC may enable the
-- transaction-local marker before the transition queued -> running.
CREATE OR REPLACE FUNCTION public.bridge_guard_targeted_legacy_claim()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.status='queued' AND NEW.status='running'
     AND NEW.executor_device_id IS NOT NULL
     AND (
       coalesce(current_setting('bridge.authorized_device_claim',true),'') <> NEW.id::text
       OR NEW.device_claim_nonce IS NULL
     )
  THEN
    RAISE EXCEPTION 'Targeted tasks require authenticated device claim RPC';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.bridge_device_claim(
  p_device_id uuid, p_token text
) RETURNS TABLE(task_id uuid, task_number bigint, instruction text,
                execution_mode text, command_payload jsonb, claim_nonce uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE v_id uuid;
BEGIN
  IF NOT public.bridge_device_token_valid(p_device_id,p_token) THEN
    RETURN;
  END IF;
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
      device_claim_nonce=gen_random_uuid()
    WHERE t.id=v_id AND t.status='queued' AND t.executor_device_id=p_device_id
    RETURNING t.id,t.task_number,t.instruction,t.execution_mode,
              t.command_payload,t.device_claim_nonce;
END;
$$;

-- The worker can only submit a small, sanitized result with the original
-- claim nonce; a stale worker cannot complete a newer reservation.
CREATE OR REPLACE FUNCTION public.bridge_device_complete(
  p_device_id uuid, p_token text, p_task_id uuid, p_claim_nonce uuid,
  p_success boolean, p_result text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE updated_count integer;
BEGIN
  IF NOT public.bridge_device_token_valid(p_device_id,p_token)
     OR p_claim_nonce IS NULL OR p_success IS NULL
     OR p_result IS NULL OR octet_length(p_result)>8192 THEN RETURN false; END IF;
  UPDATE public.bridge_tasks t SET
    status=CASE WHEN p_success THEN 'succeeded' ELSE 'failed' END,
    result=CASE WHEN p_success THEN p_result ELSE NULL END,
    error=CASE WHEN p_success THEN NULL ELSE p_result END,
    completed_at=now(),updated_at=now()
    WHERE t.id=p_task_id AND t.status='running'
      AND t.executor_device_id=p_device_id
      AND t.device_claim_nonce=p_claim_nonce;
  GET DIAGNOSTICS updated_count=ROW_COUNT;
  RETURN updated_count=1;
END;
$$;

-- A credential is required even when a function is called with anon JWT.
REVOKE ALL ON FUNCTION public.bridge_device_token_valid(uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bridge_device_claim(uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bridge_device_complete(uuid,text,uuid,uuid,boolean,text) FROM PUBLIC;
-- Token validation is used only as an internal function.
GRANT EXECUTE ON FUNCTION public.bridge_device_claim(uuid,text) TO anon;
GRANT EXECUTE ON FUNCTION public.bridge_device_complete(uuid,text,uuid,uuid,boolean,text) TO anon;
COMMIT;
