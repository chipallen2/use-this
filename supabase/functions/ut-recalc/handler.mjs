// supabase/functions/ut-recalc/handler.mjs
// Pure recalc-guard logic: no Deno/Node imports, all side effects injected.
// Shared by the edge adapter (index.ts) and the node:test suite, so tests
// exercise the REAL decision path (same RPC contract as the SQL migration),
// never a hand-copied proxy.
//
// Freshness model (truthful, atomic):
// - ut_state.last_calc = last SUCCESSFUL recompute completion, stamped only
//   by the completion callback after CI verifies scrape+render+commit+deploy.
// - ut_state.recalc_in_progress_since + claim_token = lease claimed at
//   dispatch time. Concurrent callers get { status: "in-progress" }. Stale
//   leases (> LEASE_TTL_MS) are reclaimable. Failed dispatches release it.
// - GUARD_MS since last_calc = true no-op { status: "fresh" }.
// - The claim RPC rechecks last_calc under the row lock, so a concurrent
//   completion cannot slip a fresh stamp between check and claim (no double
//   dispatch). Only the completion callback writes last_calc.
// - DB failures return 5xx { status: "error" } - never a fabricated
//   fresh/in-progress/success.

export const GUARD_MS = 60 * 60 * 1000; // recalc allowed >=1h since success; no-op <1h
export const LEASE_TTL_MS = 2 * 60 * 60 * 1000; // bounded lease covering a full CI run; stale leases reclaimable
export const FUTURE_SKEW_MS = 5 * 60 * 1000; // completion stamps beyond now+skew are rejected

const ok = (http, json) => ({ http, json });
const err = (http, code, message, extra) => ({
  http,
  json: { status: "error", code, error: message, ...(extra ?? {}) },
});
const msgOf = (e) => (e && e.message ? e.message : String(e));

// Deps:
// - db: { rpc(name, args) } mirroring supabase/migrations/20260924_ut_recalc_lease.sql
// - dispatch: async ({ claim }) -> { ok, status, body } (GitHub workflow dispatch w/ claim input)
// - now: () -> epoch ms (injectable clock for tests)
// - completeToken: shared secret gating complete/fail callbacks
export function createHandler({ db, dispatch, now = () => Date.now(), completeToken = "" }) {
  const t = () => now();

  async function releaseQuietly(claim) {
    try {
      await db.rpc("ut_fail_recalc", { p_claim: claim, p_now: t(), p_ttl_ms: LEASE_TTL_MS });
    } catch {
      /* TTL backstop covers a failed release */
    }
  }

  // Trigger path: human button, imperative/declarative WebMCP, pg_cron tick,
  // scheduled workflow claim step - all identical.
  async function trigger() {
    const at = t();
    let s;
    try {
      s = await db.rpc("ut_claim_recalc", {
        p_now: at,
        p_claim: `c_${at}_${Math.floor(Math.random() * 1e9).toString(36)}`,
        p_guard_ms: GUARD_MS,
        p_ttl_ms: LEASE_TTL_MS,
      });
    } catch (e) {
      return err(500, "db-claim-failed", "ut_state claim failed: " + msgOf(e));
    }
    if (!s || typeof s !== "object" || typeof s.status !== "string") {
      return err(500, "db-bad-shape", "ut_state claim returned a malformed row");
    }
    if (s.status === "fresh") {
      return ok(200, {
        status: "fresh",
        recalculated: false,
        last_calc: s.last_calc,
        eligible_after: s.eligible_after,
      });
    }
    if (s.status === "in-progress") {
      return ok(200, {
        status: "in-progress",
        recalculated: false,
        last_calc: s.last_calc,
        in_progress_since: s.in_progress_since,
      });
    }
    if (s.status !== "started") {
      return err(500, "db-bad-status", "ut_state claim returned unknown status: " + s.status);
    }
    // We own the lease. Dispatch; ANY dispatch failure releases it so a
    // retry can proceed immediately. Truthful error, never fake fresh/success.
    let d;
    try {
      d = await dispatch({ claim: s.claim });
    } catch (e) {
      await releaseQuietly(s.claim);
      return err(502, "dispatch-network", "workflow dispatch failed (network): " + msgOf(e), {
        last_calc: s.last_calc,
      });
    }
    if (!d || !d.ok) {
      await releaseQuietly(s.claim);
      const detail = `${(d && d.status) ?? "?"} ${((d && d.body) || "").slice(0, 200)}`.trim();
      return err(502, "dispatch-failed", "workflow dispatch failed: " + detail, {
        last_calc: s.last_calc,
      });
    }
    return ok(200, {
      status: "started",
      recalculated: true,
      claim: s.claim,
      last_calc: s.last_calc,
      in_progress_since: s.in_progress_since,
    });
  }

  // Completion callback from CI after a VERIFIED successful recompute
  // (scrape+render+commit+push+deploy+canonical-timestamp check all green).
  // Requires token ownership AND an OWNED, LIVE lease claim: null/empty
  // claims and claims that do not match the stored token are ALWAYS
  // rejected (a NULL stored token means no active lease - nothing to
  // complete). calc_utc must be valid, non-future, >= the lease start
  // (stale pre-lease callback) and >= the prior success (rollback block).
  // Missing/invalid/future/stale timestamps are rejected with 400/409,
  // never Date.now().
  async function complete(body) {
    if (!completeToken || body.token !== completeToken) {
      return err(403, "bad-token", "bad completion token");
    }
    if (typeof body.claim !== "string" || !body.claim) {
      return err(400, "missing-claim", "complete requires the owned lease claim token");
    }
    const raw = body.calc_utc;
    const ms = typeof raw === "string" ? Date.parse(raw) : NaN;
    if (typeof raw !== "string" || Number.isNaN(ms)) {
      return err(400, "invalid-calc-utc", "complete requires a valid calc_utc ISO timestamp (no server-time fallback)");
    }
    if (ms > t() + FUTURE_SKEW_MS) {
      return err(400, "future-calc-utc", "calc_utc is in the future; refusing to stamp");
    }
    // Node-side guards mirror the SQL (defense in depth): the migration
    // enforces the same, so handler and DB agree even if one is stale.
    let s;
    try {
      s = await db.rpc("ut_complete_recalc", {
        p_calc_utc: new Date(ms).toISOString(),
        p_picks: body.picks && typeof body.picks === "object" ? body.picks : {},
        p_claim: body.claim,
        p_now: t(),
        p_skew_ms: FUTURE_SKEW_MS,
      });
    } catch (e) {
      return err(500, "db-complete-failed", "ut_state completion write failed: " + msgOf(e));
    }
    if (s && s.status === "completed") {
      return ok(200, { status: "completed", last_calc: s.last_calc });
    }
    if (s && s.code === "lease-owned") {
      return err(409, "lease-owned", "a newer recalc lease owns ut_state; stale completion rejected", {
        last_calc: s.last_calc ?? null,
      });
    }
    if (s && (s.code === "stale-calc-utc" || s.code === "rollback-calc-utc")) {
      return err(409, s.code, "calc_utc predates the lease start or the prior success; stale completion rejected", {
        last_calc: s.last_calc ?? null,
      });
    }
    if (s && s.code === "future-calc-utc") {
      return err(400, "future-calc-utc", "calc_utc is in the future; refusing to stamp");
    }
    return err(500, "db-bad-status", "completion returned an unknown status");
  }

  // Failure callback from CI when the pipeline breaks after claiming.
  // Releases ONLY the owned claim; the 2h TTL backstops a missed call.
  async function failOpen(body) {
    if (!completeToken || body.token !== completeToken) {
      return err(403, "bad-token", "bad failure-callback token");
    }
    if (typeof body.claim !== "string" || !body.claim) {
      return err(400, "missing-claim", "fail requires the lease claim token");
    }
    let s;
    try {
      s = await db.rpc("ut_fail_recalc", { p_claim: body.claim, p_now: t(), p_ttl_ms: LEASE_TTL_MS });
    } catch (e) {
      return err(500, "db-fail-failed", "lease release failed: " + msgOf(e));
    }
    if (s && s.status === "ok") {
      return ok(200, { status: "lease-released", released: !!s.released });
    }
    if (s && s.code === "lease-owned") {
      return err(409, "lease-owned", "lease owned by a different claim; not released");
    }
    return err(500, "db-bad-status", "fail callback returned an unknown status");
  }

  async function route(body) {
    const b = body && typeof body === "object" ? body : {};
    if (b.complete === true) return complete(b);
    if (b.fail === true) return failOpen(b);
    return trigger();
  }

  return { route, trigger, complete, fail: failOpen, GUARD_MS, LEASE_TTL_MS, FUTURE_SKEW_MS };
}
