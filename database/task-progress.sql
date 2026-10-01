-- Pending transactional proposal; no change to status lifecycle, RLS or grants.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE public.bridge_tasks
  ADD COLUMN IF NOT EXISTS progress_message text,
  ADD COLUMN IF NOT EXISTS recent_output text,
  ADD COLUMN IF NOT EXISTS last_progress_at timestamptz,
  ADD COLUMN IF NOT EXISTS progress_seq bigint DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_flush_reason text,
  ADD COLUMN IF NOT EXISTS last_flush_line_count integer;
DO $$
BEGIN
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema='public'
      AND table_name='bridge_tasks' AND
      ((column_name IN ('progress_message','recent_output','last_flush_reason') AND data_type='text') OR
       (column_name='last_progress_at' AND data_type='timestamp with time zone') OR
       (column_name='last_flush_line_count' AND data_type='integer') OR
       (column_name='progress_seq' AND data_type='bigint'))) <> 6 THEN
    RAISE EXCEPTION 'Incompatible progress columns';
  END IF;
END; $$;
DROP TRIGGER IF EXISTS bridge_progress_guard ON public.bridge_tasks;
UPDATE public.bridge_tasks SET progress_seq=0 WHERE progress_seq IS NULL;
ALTER TABLE public.bridge_tasks ALTER COLUMN progress_seq SET DEFAULT 0,
  ALTER COLUMN progress_seq SET NOT NULL;
CREATE OR REPLACE FUNCTION public.bridge_progress_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.progress_seq <> 0 OR NEW.last_progress_at IS NOT NULL OR
       NEW.last_flush_reason IS NOT NULL OR NEW.last_flush_line_count IS NOT NULL OR
       NEW.recent_output IS NOT NULL OR NEW.progress_message IS NOT NULL THEN
      RAISE EXCEPTION 'Progress starts empty';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'running' OR NEW.status <> OLD.status OR
     NEW.progress_seq IS DISTINCT FROM OLD.progress_seq+1 OR
     NEW.last_flush_reason IS NULL OR NEW.last_flush_reason NOT IN ('lines','timeout','command_end','final') OR
     NEW.last_flush_line_count IS NULL OR NEW.last_flush_line_count NOT BETWEEN 1 AND 500 OR
     NEW.recent_output IS NULL THEN
    RAISE EXCEPTION 'Invalid progress flush';
  END IF;
  IF octet_length(to_json(NEW.recent_output)::text) > 524288 OR
     (1+length(NEW.recent_output)-length(replace(NEW.recent_output,E'\n',''))) > 500 OR
     NEW.last_flush_line_count > (1+length(NEW.recent_output)-length(replace(NEW.recent_output,E'\n',''))) OR
     length(NEW.progress_message) > 240 THEN
    RAISE EXCEPTION 'Progress exceeds bounded window';
  END IF;
  -- PostgreSQL row lock + client CAS: one atomic increment and server timestamp.
  NEW.progress_seq := OLD.progress_seq+1;
  NEW.last_progress_at := now();
  RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION public.bridge_progress_guard() FROM PUBLIC;
CREATE TRIGGER bridge_progress_guard BEFORE INSERT OR UPDATE OF
  progress_seq,recent_output,progress_message,last_progress_at,last_flush_reason,last_flush_line_count
  ON public.bridge_tasks FOR EACH ROW EXECUTE FUNCTION public.bridge_progress_guard();
COMMIT;
