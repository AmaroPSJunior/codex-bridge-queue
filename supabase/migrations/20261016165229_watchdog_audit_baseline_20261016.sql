-- Baseline idempotente da trilha de auditoria do watchdog.
CREATE TABLE IF NOT EXISTS public.bridge_watchdog_events (
 id uuid PRIMARY KEY,
 created_at timestamptz NOT NULL DEFAULT now(),
 event_at timestamptz NOT NULL,
 event_type text NOT NULL CHECK (length(event_type) BETWEEN 1 AND 80),
 verdict text,
 worker_id text,
 task_id uuid,
 reason text,
 evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
 action text,
 outcome text
);
ALTER TABLE public.bridge_watchdog_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bridge_watchdog_events FROM anon, authenticated;
GRANT ALL ON public.bridge_watchdog_events TO service_role;
CREATE INDEX IF NOT EXISTS bridge_watchdog_events_event_at_idx
 ON public.bridge_watchdog_events (event_at DESC);
