-- Idempotent activation SQL: apply explicitly, never at worker startup.
-- Existing installations must verify the schema before applying.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';
ALTER TABLE public.bridge_tasks
 ADD COLUMN IF NOT EXISTS execution_mode text NOT NULL DEFAULT 'agent',
 ADD COLUMN IF NOT EXISTS command_payload jsonb,
 ADD COLUMN IF NOT EXISTS command_result jsonb;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.bridge_tasks'::regclass AND conname='bridge_execution_mode_valid') THEN
  ALTER TABLE public.bridge_tasks ADD CONSTRAINT bridge_execution_mode_valid CHECK (
   execution_mode IS NOT NULL AND execution_mode IN ('agent','command') AND
   ((execution_mode='agent' AND command_payload IS NULL) OR
    (execution_mode='command' AND command_payload IS NOT NULL AND jsonb_typeof(command_payload)='object' AND octet_length(command_payload::text)<=8192)) AND
   (command_result IS NULL OR (execution_mode='command' AND jsonb_typeof(command_result)='object' AND octet_length(command_result::text)<=524288))
  );
 END IF;
END $$;
-- Keep existing status constraints, RLS, grants, UUIDs and claim semantics.
-- No public read of payload/result and no provider-state entries for commands.
COMMIT;
