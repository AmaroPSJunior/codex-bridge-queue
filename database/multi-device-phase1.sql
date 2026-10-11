-- Phase 1: inert multi-device schema. DO NOT deploy until the authenticated claim RPC
-- and production compatibility plan have been reviewed. No second worker is enabled.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';

CREATE TABLE IF NOT EXISTS public.bridge_devices (
  id uuid PRIMARY KEY,
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 80),
  device_kind text NOT NULL CHECK (device_kind IN ('android_phone','android_head_unit')),
  enabled boolean NOT NULL DEFAULT false,
  capabilities text[] NOT NULL DEFAULT ARRAY[]::text[],
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.bridge_devices ENABLE ROW LEVEL SECURITY;
-- Deliberately no GRANT and no permissive RLS policy. Authentication and access
-- will be supplied by a separately reviewed, tightly scoped RPC in phase 2.

ALTER TABLE public.bridge_tasks
  ADD COLUMN IF NOT EXISTS executor_device_id uuid;

-- Keep nullable for legacy tasks. No FK yet: scope/integrity must be audited
-- against existing access control before enforcing one.

-- A legacy service-role worker may update any row without RLS. Until the new
-- authenticated claim RPC exists, fail closed on targeted tasks at database level.
CREATE OR REPLACE FUNCTION public.bridge_guard_targeted_legacy_claim()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status='queued' AND NEW.status='running'
     AND NEW.executor_device_id IS NOT NULL THEN
    RAISE EXCEPTION 'Targeted tasks require authenticated device claim RPC';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS bridge_guard_targeted_legacy_claim ON public.bridge_tasks;
CREATE TRIGGER bridge_guard_targeted_legacy_claim
BEFORE UPDATE ON public.bridge_tasks
FOR EACH ROW EXECUTE FUNCTION public.bridge_guard_targeted_legacy_claim();

-- The trigger is a temporary fail-closed guard, NOT an authorization mechanism.
-- It must be replaced atomically with the authenticated device claim mechanism,
-- after both workers can consume only explicitly routed tasks.
COMMIT;
