-- Pending idempotent identity migration. Does not change UUIDs, statuses or CHECKs.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';
LOCK TABLE public.bridge_tasks IN ACCESS EXCLUSIVE MODE;
ALTER TABLE public.bridge_tasks ADD COLUMN IF NOT EXISTS task_number bigint,
  ADD COLUMN IF NOT EXISTS title text;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='public.bridge_tasks'::regclass
      AND attname='task_number' AND atttypid='bigint'::regtype AND attidentity IN ('','a') AND NOT attisdropped)
     OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='public.bridge_tasks'::regclass
      AND attname='title' AND atttypid='text'::regtype AND NOT attisdropped) THEN
    RAISE EXCEPTION 'Conflicting identity schema';
  END IF;
END; $$;
-- Assign only missing numbers, oldest first; UUID breaks timestamp ties.
-- MAX is a migration-only offset under exclusive lock, never an application allocator.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='public.bridge_tasks'::regclass AND attname='task_number' AND attidentity='') THEN
WITH missing AS (
  SELECT id,row_number() OVER (ORDER BY created_at ASC NULLS LAST,id ASC)
    +(SELECT coalesce(max(task_number),0) FROM public.bridge_tasks) AS assigned
  FROM public.bridge_tasks WHERE task_number IS NULL
)
UPDATE public.bridge_tasks t SET task_number=m.assigned FROM missing m WHERE t.id=m.id;
  END IF;
END; $$;
ALTER TABLE public.bridge_tasks ALTER COLUMN task_number SET NOT NULL;
DO $$
DECLARE seqname text; highest bigint; sequence_value bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='public.bridge_tasks'::regclass
      AND attname='task_number' AND attidentity='') THEN
    ALTER TABLE public.bridge_tasks ALTER COLUMN task_number DROP DEFAULT;
    ALTER TABLE public.bridge_tasks ALTER COLUMN task_number ADD GENERATED ALWAYS AS IDENTITY;
  END IF;
  seqname := pg_get_serial_sequence('public.bridge_tasks','task_number');
  SELECT max(task_number) INTO highest FROM public.bridge_tasks;
  EXECUTE format('SELECT last_value FROM %s',seqname::regclass) INTO sequence_value;
  -- Never reset a previously advanced sequence on rerun.
  IF highest IS NOT NULL AND highest >= sequence_value THEN
    PERFORM setval(seqname::regclass,highest,true);
  END IF;
END; $$;
CREATE UNIQUE INDEX IF NOT EXISTS bridge_tasks_task_number_key ON public.bridge_tasks(task_number);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_index WHERE indexrelid='public.bridge_tasks_task_number_key'::regclass
    AND indrelid='public.bridge_tasks'::regclass AND indisunique AND indisvalid
    AND indnkeyatts=1 AND indpred IS NULL AND indkey[0]=(
      SELECT attnum FROM pg_attribute WHERE attrelid='public.bridge_tasks'::regclass AND attname='task_number')) THEN
    RAISE EXCEPTION 'Conflicting task number index';
  END IF;
END; $$;
-- Fixed category names only; never copy arbitrary instruction/result fragments.
DROP TRIGGER IF EXISTS bridge_tasks_human_identity ON public.bridge_tasks;
WITH named AS (SELECT id,left(coalesce(
  nullif(nullif(btrim(regexp_replace(title,'[[:space:][:cntrl:]]+',' ','g')),''),'Tarefa sem título'),
  CASE WHEN lower(coalesce(instruction,'')) ~ 'diagnóstico adb|adb diagnostic' THEN 'Diagnóstico ADB do BYD' WHEN lower(coalesce(instruction,'')) ~ 'live.progress|monitoramento de progresso' THEN 'Monitoramento de progresso' WHEN lower(coalesce(instruction,'')) ~ 'teste da ponte|teste de integração|test.*bridge' THEN 'Teste da ponte' ELSE 'Tarefa '||task_number::text END),80) AS new_title FROM public.bridge_tasks)
UPDATE public.bridge_tasks t SET title=n.new_title FROM named n
WHERE t.id=n.id AND t.title IS DISTINCT FROM n.new_title;
ALTER TABLE public.bridge_tasks ALTER COLUMN title DROP DEFAULT;
ALTER TABLE public.bridge_tasks ALTER COLUMN title SET NOT NULL;
CREATE OR REPLACE FUNCTION public.bridge_tasks_human_identity()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.task_number IS DISTINCT FROM OLD.task_number THEN
    RAISE EXCEPTION 'task_number is immutable';
  END IF;
  NEW.title := left(coalesce(nullif(btrim(regexp_replace(NEW.title,'[[:space:][:cntrl:]]+',' ','g')),''),
    CASE WHEN lower(coalesce(NEW.instruction,'')) ~ 'diagnóstico adb|adb diagnostic' THEN 'Diagnóstico ADB do BYD' WHEN lower(coalesce(NEW.instruction,'')) ~ 'live.progress|monitoramento de progresso' THEN 'Monitoramento de progresso' WHEN lower(coalesce(NEW.instruction,'')) ~ 'teste da ponte|teste de integração|test.*bridge' THEN 'Teste da ponte' ELSE 'Tarefa '||NEW.task_number::text END),80);
  RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION public.bridge_tasks_human_identity() FROM PUBLIC;
CREATE TRIGGER bridge_tasks_human_identity BEFORE INSERT OR UPDATE ON public.bridge_tasks
  FOR EACH ROW EXECUTE FUNCTION public.bridge_tasks_human_identity();
COMMIT;
