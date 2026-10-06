BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';

ALTER TABLE public.bridge_tasks
 ADD COLUMN IF NOT EXISTS execution_mode text NOT NULL DEFAULT 'agent',
 ADD COLUMN IF NOT EXISTS command_payload jsonb,
 ADD COLUMN IF NOT EXISTS command_result jsonb,
 ADD COLUMN IF NOT EXISTS plan_payload jsonb,
 ADD COLUMN IF NOT EXISTS plan_result jsonb;

DO $$
BEGIN
 IF EXISTS (
   SELECT 1 FROM pg_constraint
   WHERE conrelid='public.bridge_tasks'::regclass
     AND conname='bridge_execution_mode_valid'
 ) THEN
   ALTER TABLE public.bridge_tasks DROP CONSTRAINT bridge_execution_mode_valid;
 END IF;

 ALTER TABLE public.bridge_tasks
 ADD CONSTRAINT bridge_execution_mode_valid CHECK (
   execution_mode IS NOT NULL
   AND execution_mode IN ('agent','command','plan')
   AND (
     (execution_mode='agent' AND command_payload IS NULL AND plan_payload IS NULL)
     OR
     (execution_mode='command' AND command_payload IS NOT NULL AND plan_payload IS NULL
      AND jsonb_typeof(command_payload)='object'
      AND octet_length(command_payload::text)<=8192)
     OR
     (execution_mode='plan' AND plan_payload IS NOT NULL AND command_payload IS NULL
      AND jsonb_typeof(plan_payload)='object'
      AND octet_length(plan_payload::text)<=262144)
   )
   AND (
     command_result IS NULL
     OR (
       execution_mode='command'
       AND jsonb_typeof(command_result)='object'
       AND octet_length(command_result::text)<=524288
     )
   )
   AND (
     plan_result IS NULL
     OR (
       execution_mode='plan'
       AND jsonb_typeof(plan_result)='object'
       AND octet_length(plan_result::text)<=1048576
     )
   )
 );
END
$$;

COMMIT;
