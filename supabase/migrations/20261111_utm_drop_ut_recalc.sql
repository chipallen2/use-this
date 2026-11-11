-- supabase/migrations/20261111_utm_drop_ut_recalc.sql
-- FOR CHIP TO REVIEW AND RUN MANUALLY. Not executed by the PR author.
--
-- Use This Model is now stateless (all settings in the URL, no precalculated
-- picks, no recalc lease), so it needs NO database objects at all. This
-- removes everything the old weekly-recalc design created:
--   - pg_cron job  ut-weekly-recalc   (supabase/setup.sql, now deleted)
--   - table        public.ut_state    (setup.sql + 20260924_ut_recalc_lease.sql)
--   - functions    public.ut_claim_recalc / ut_complete_recalc / ut_fail_recalc
--
-- SHARED PROJECT SAFETY: every statement names an object prefixed ut_ by
-- its exact name. Nothing else is touched. No utm_ objects are created.
-- Idempotent: safe to re-run.
--
-- The ut-recalc EDGE FUNCTION is not SQL; delete it separately:
--   supabase functions delete ut-recalc --project-ref cmohqhotfywhmgikeatc
-- and remove its secrets (UT_COMPLETE_TOKEN, GITHUB_TOKEN) if set only for it.

BEGIN;

-- Dynamic SQL: cron.job is only referenced when pg_cron is installed.
DO $$
DECLARE has_job boolean := false;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM cron.job WHERE jobname = $1)' INTO has_job USING 'ut-weekly-recalc';
    IF has_job THEN
      EXECUTE 'SELECT cron.unschedule($1)' USING 'ut-weekly-recalc';
    END IF;
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.ut_claim_recalc(bigint, text, integer, integer);
DROP FUNCTION IF EXISTS public.ut_complete_recalc(timestamptz, jsonb, text, bigint, integer);
DROP FUNCTION IF EXISTS public.ut_fail_recalc(text, bigint, integer);
DROP TABLE IF EXISTS public.ut_state;

COMMIT;
