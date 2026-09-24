-- supabase/migrations/20260924_ut_recalc_lease.sql
-- Atomic recalc guard for USE THIS. Apply ONCE (supabase db push / dashboard SQL).
-- Does NOT touch existing rows: last_calc/picks preserved, new columns NULL.
-- NOTE: setup.sql schedules pg_cron ut-weekly-recalc at 12:05 UTC while
-- .github/workflows/weekly.yml schedules GH cron at 12:00 UTC. Both funnel
-- through ut_claim_recalc (same guard): whichever claims first runs, the
-- other cleanly no-ops. Dedup to a single scheduler is deferred to deploy.
--
-- Design: three SECURITY DEFINER RPCs, EXECUTE granted to service_role ONLY
-- (edge fn uses the service key; anon/authenticated get nothing). The claim
-- RPC rechecks last_calc UNDER the row lock, so a concurrent completion
-- cannot slip a fresh stamp between check and claim - single dispatch even
-- under a completion race. NULL-safe: missing lease uses IS NULL, never
-- .eq(col, null). Completion requires claim-token ownership, so a stale
-- worker can never clear a newer lease.

ALTER TABLE public.ut_state
  ADD COLUMN IF NOT EXISTS recalc_in_progress_since timestamptz,
  ADD COLUMN IF NOT EXISTS claim_token text;

-- Claim the recalc lease iff last_calc is older than the guard AND no live
-- lease exists. Returns fresh | in-progress | started (never raises for
-- contention; raises only for a missing row / DB failure -> caller 500s).
CREATE OR REPLACE FUNCTION public.ut_claim_recalc(
  p_now bigint, p_claim text, p_guard_ms integer, p_ttl_ms integer
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r public.ut_state%ROWTYPE;
  last_ms bigint;
  lease_ms bigint;
BEGIN
  SELECT * INTO r FROM public.ut_state WHERE id = 1 FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ut_state row missing'; END IF;
  IF r.last_calc IS NULL THEN RAISE EXCEPTION 'ut_state.last_calc is null'; END IF;
  last_ms := (extract(epoch FROM r.last_calc) * 1000)::bigint;
  IF p_now - last_ms < p_guard_ms THEN
    RETURN jsonb_build_object(
      'status', 'fresh',
      'last_calc', r.last_calc,
      'eligible_after', to_timestamp((last_ms + p_guard_ms) / 1000.0)
    );
  END IF;
  IF r.recalc_in_progress_since IS NOT NULL THEN
    lease_ms := (extract(epoch FROM r.recalc_in_progress_since) * 1000)::bigint;
    IF p_now - lease_ms < p_ttl_ms THEN
      RETURN jsonb_build_object(
        'status', 'in-progress',
        'last_calc', r.last_calc,
        'in_progress_since', r.recalc_in_progress_since
      );
    END IF;
  END IF;
  -- Guard rechecked above under the lock: atomic claim, one winner.
  UPDATE public.ut_state
     SET recalc_in_progress_since = to_timestamp(p_now / 1000.0),
         claim_token = p_claim
   WHERE id = 1
  RETURNING recalc_in_progress_since INTO r.recalc_in_progress_since;
  RETURN jsonb_build_object(
    'status', 'started',
    'claim', p_claim,
    'last_calc', r.last_calc,
    'in_progress_since', r.recalc_in_progress_since
  );
END $$;

-- Stamp a VERIFIED successful recompute. Rejects, in order: missing claim
-- (null/empty never completes), future calc_utc (beyond skew), a claim that
-- does not own the current lease (NULL stored token = no active lease, so
-- ANY claim without a live lease is lease-owned - never auto-accepted),
-- calc_utc older than the lease start (stale pre-lease callback), and
-- calc_utc older than the prior success (rollback block). No Date.now
-- fallback anywhere.
CREATE OR REPLACE FUNCTION public.ut_complete_recalc(
  p_calc_utc timestamptz, p_picks jsonb, p_claim text, p_now bigint, p_skew_ms integer
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r public.ut_state%ROWTYPE;
  lease_ms bigint;
  last_ms bigint;
BEGIN
  IF p_calc_utc IS NULL THEN
    RETURN jsonb_build_object('status', 'error', 'code', 'invalid-calc-utc');
  END IF;
  IF p_claim IS NULL OR p_claim = '' THEN
    RETURN jsonb_build_object('status', 'error', 'code', 'missing-claim');
  END IF;
  IF p_calc_utc > to_timestamp(p_now / 1000.0) + make_interval(secs => p_skew_ms / 1000.0) THEN
    RETURN jsonb_build_object('status', 'error', 'code', 'future-calc-utc');
  END IF;
  SELECT * INTO r FROM public.ut_state WHERE id = 1 FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ut_state row missing'; END IF;
  -- No active lease, or a different lease owns the row: never auto-accept.
  IF r.claim_token IS NULL OR r.recalc_in_progress_since IS NULL OR p_claim <> r.claim_token THEN
    RETURN jsonb_build_object('status', 'error', 'code', 'lease-owned', 'last_calc', r.last_calc);
  END IF;
  -- Stale callback from before this lease started: refuse.
  lease_ms := (extract(epoch FROM r.recalc_in_progress_since) * 1000)::bigint;
  IF (extract(epoch FROM p_calc_utc) * 1000)::bigint < lease_ms THEN
    RETURN jsonb_build_object('status', 'error', 'code', 'stale-calc-utc', 'last_calc', r.last_calc);
  END IF;
  -- Never roll last_calc backwards.
  last_ms := (extract(epoch FROM r.last_calc) * 1000)::bigint;
  IF (extract(epoch FROM p_calc_utc) * 1000)::bigint < last_ms THEN
    RETURN jsonb_build_object('status', 'error', 'code', 'rollback-calc-utc', 'last_calc', r.last_calc);
  END IF;
  UPDATE public.ut_state
     SET last_calc = p_calc_utc,
         picks = COALESCE(p_picks, '{}'::jsonb),
         recalc_in_progress_since = NULL,
         claim_token = NULL
   WHERE id = 1
  RETURNING last_calc INTO r.last_calc;
  RETURN jsonb_build_object('status', 'completed', 'last_calc', r.last_calc);
END $$;

-- Release the OWNED lease after dispatch/pipeline failure. A NULL stored
-- token means no active lease (nothing to release, released=false). A
-- foreign live lease is never touched (lease-owned); only an exact claim
-- match releases early. Stale leases (>= TTL) are reclaimed by the CLAIM
-- rpc, not here - a stale foreign claim cannot use fail to clear a lease
-- it does not own.
CREATE OR REPLACE FUNCTION public.ut_fail_recalc(
  p_claim text, p_now bigint, p_ttl_ms integer
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r public.ut_state%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.ut_state WHERE id = 1 FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ut_state row missing'; END IF;
  IF r.claim_token IS NULL OR r.recalc_in_progress_since IS NULL THEN
    RETURN jsonb_build_object('status', 'ok', 'released', false);
  END IF;
  IF p_claim IS NOT NULL AND p_claim <> '' AND p_claim = r.claim_token THEN
    UPDATE public.ut_state
       SET recalc_in_progress_since = NULL, claim_token = NULL
     WHERE id = 1;
    RETURN jsonb_build_object('status', 'ok', 'released', true);
  END IF;
  RETURN jsonb_build_object('status', 'error', 'code', 'lease-owned');
END $$;

REVOKE ALL ON FUNCTION public.ut_claim_recalc(bigint, text, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ut_complete_recalc(timestamptz, jsonb, text, bigint, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ut_fail_recalc(text, bigint, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ut_claim_recalc(bigint, text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.ut_complete_recalc(timestamptz, jsonb, text, bigint, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.ut_fail_recalc(text, bigint, integer) TO service_role;
