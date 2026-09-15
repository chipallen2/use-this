-- ut_state: last calc timestamp + last 3 picks (server-side recalc guard)
CREATE TABLE IF NOT EXISTS public.ut_state (
  id int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_calc timestamptz NOT NULL DEFAULT now(),
  picks jsonb NOT NULL DEFAULT '{}'::jsonb
);
ALTER TABLE public.ut_state ENABLE ROW LEVEL SECURITY;
-- service_role bypasses RLS; no public policies by design (edge fn uses service key)
INSERT INTO public.ut_state (id, last_calc, picks)
VALUES (1, now(), '{}'::jsonb)
ON CONFLICT (id) DO NOTHING;

-- Weekly trigger: Mondays 12:05 UTC, calls ut-recalc edge fn (guard inside fn)
SELECT cron.schedule(
  'ut-weekly-recalc',
  '5 12 * * 1',
  $$
  SELECT net.http_post(
    url := current_setting('app.settings.supabase_url') || '/functions/v1/ut-recalc',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
  $$
);
