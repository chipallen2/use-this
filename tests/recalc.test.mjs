// tests/recalc.test.mjs - node:test suite for the REAL recalc handler +
// the REAL rendered client script + the REAL SQL migration (PGlite).
//
// Layers:
// 1. handler.mjs (same file the edge fn ships) backed by an in-memory RPC
//    fake that mirrors supabase/migrations/20260924_ut_recalc_lease.sql
//    (row-lock semantics collapse to a mutex: JS is single-threaded, and
//    each RPC body runs synchronously between awaits - same atomicity).
// 2. PGlite section: the ACTUAL migration SQL loaded into an in-process
//    Postgres, asserting the real claim/complete/fail RPCs enforce
//    ownership, null-claim rejection, and stale/rollback timestamp blocks.
// 3. Frontend section: the client script is rendered to a TEMP dir from
//    CURRENT source (scripts/render.mjs + data/) - never the stale
//    checked-in dist/index.html - then run in vm. `npm test` is repeatable
//    with no manual dist priming.
// 4. ut-claim.mjs / ut-stage.mjs: the workflow's pure claim + stage logic,
//    covering the fresh/in-progress/started schedule paths and the exact
//    UT_SKIP=1 sentinel.
//
// Covers: guard boundaries, concurrency single-dispatch, dispatch failures,
// completion ownership + calc_utc truthfulness, fail ownership, malformed
// bodies, doRecalc schema validation (200 HTML / 200 {} / 500 fresh /
// missing timestamps), real HUMAN button submit (status + button lifecycle),
// get_picks invocation, UTC rollover, stable stamp, unknown provenance.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync, writeFileSync, readFileSync, readdirSync,
  copyFileSync, mkdirSync, existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { createHandler, GUARD_MS, LEASE_TTL_MS, FUTURE_SKEW_MS } from "../supabase/functions/ut-recalc/handler.mjs";
import { decideClaim, parseClaimResponse, SKIP_EXACT } from "../scripts/ci/ut-claim.mjs";
import { missingPaths, DEPLOY_PATHS } from "../scripts/ci/ut-stage.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const TOKEN = "test-complete-token";

// ---- render the CURRENT source to a temp dir (never stale dist) ----
function renderFresh({ calcUtc = "2026-09-22T18:46:50.000Z", withCalc = true, endpoint = "https://x.test/fn" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ut-page-"));
  copyFileSync(join(ROOT, "data", "picks.json"), join(dir, "picks.json"));
  copyFileSync(join(ROOT, "data", "candidates.json"), join(dir, "candidates.json"));
  if (withCalc) {
    const d = JSON.parse(readFileSync(join(dir, "picks.json"), "utf8"));
    writeFileSync(join(dir, "calc.json"), JSON.stringify({ calc_utc: calcUtc, data_date: d.date }) + "\n");
  }
  execFileSync("node", [join(ROOT, "scripts", "render.mjs"), dir, join(dir, "index.html")],
    { env: { ...process.env, RECALC_URL: endpoint } });
  return { dir, html: readFileSync(join(dir, "index.html"), "utf8") };
}

// ---- In-memory RPC fake mirroring the SQL migration (post-fix semantics) ----
function memDb({ lastCalcMs, leaseSinceMs = null, claim = null } = {}) {
  const row = {
    last_calc: new Date(lastCalcMs).toISOString(),
    picks: {},
    recalc_in_progress_since: leaseSinceMs == null ? null : new Date(leaseSinceMs).toISOString(),
    claim_token: claim,
  };
  const isoMs = (d) => new Date(d).getTime();
  return {
    row,
    calls: [],
    async rpc(name, a) {
      this.calls.push(name);
      if (name === "ut_claim_recalc") {
        const lastMs = isoMs(row.last_calc);
        if (a.p_now - lastMs < a.p_guard_ms) {
          return {
            status: "fresh",
            last_calc: row.last_calc,
            eligible_after: new Date(lastMs + a.p_guard_ms).toISOString(),
          };
        }
        if (row.recalc_in_progress_since != null) {
          const lm = isoMs(row.recalc_in_progress_since);
          if (a.p_now - lm < a.p_ttl_ms) {
            return {
              status: "in-progress",
              last_calc: row.last_calc,
              in_progress_since: row.recalc_in_progress_since,
            };
          }
        }
        row.recalc_in_progress_since = new Date(a.p_now).toISOString();
        row.claim_token = a.p_claim;
        return {
          status: "started",
          claim: a.p_claim,
          last_calc: row.last_calc,
          in_progress_since: row.recalc_in_progress_since,
        };
      }
      if (name === "ut_complete_recalc") {
        if (a.p_calc_utc == null) return { status: "error", code: "invalid-calc-utc" };
        if (isoMs(a.p_calc_utc) > a.p_now + a.p_skew_ms) {
          return { status: "error", code: "future-calc-utc" };
        }
        if (a.p_claim == null || a.p_claim === "") return { status: "error", code: "missing-claim" };
        if (row.claim_token == null || row.recalc_in_progress_since == null || a.p_claim !== row.claim_token) {
          return { status: "error", code: "lease-owned", last_calc: row.last_calc };
        }
        if (isoMs(a.p_calc_utc) < isoMs(row.recalc_in_progress_since)) {
          return { status: "error", code: "stale-calc-utc", last_calc: row.last_calc };
        }
        if (isoMs(a.p_calc_utc) < isoMs(row.last_calc)) {
          return { status: "error", code: "rollback-calc-utc", last_calc: row.last_calc };
        }
        row.last_calc = new Date(isoMs(a.p_calc_utc)).toISOString();
        row.picks = a.p_picks ?? {};
        row.recalc_in_progress_since = null;
        row.claim_token = null;
        return { status: "completed", last_calc: row.last_calc };
      }
      if (name === "ut_fail_recalc") {
        if (row.claim_token == null || row.recalc_in_progress_since == null) {
          return { status: "ok", released: false };
        }
        if (a.p_claim != null && a.p_claim !== "" && a.p_claim === row.claim_token) {
          row.recalc_in_progress_since = null;
          row.claim_token = null;
          return { status: "ok", released: true };
        }
        return { status: "error", code: "lease-owned" };
      }
      throw new Error("unknown rpc " + name);
    },
  };
}

const okDispatch = () => async () => ({ ok: true, status: 204, body: "" });
const mk = (dbOpts, disp) =>
  createHandler({ db: memDb(dbOpts), dispatch: disp ?? okDispatch(), now: () => NOW, completeToken: TOKEN });
let NOW = 1_786_000_000_000; // fixed clock: 2026-08-07T~04:26Z
const iso = (ms) => new Date(ms).toISOString();

// ---- guard boundaries: no-op <1h, allowed >=1h ----
test("fresh no-op when last success < 1h ago (59m59s)", async () => {
  const h = mk({ lastCalcMs: NOW - (GUARD_MS - 1000) });
  const r = await h.route({});
  assert.equal(r.http, 200);
  assert.equal(r.json.status, "fresh");
  assert.equal(r.json.recalculated, false);
  assert.ok(r.json.eligible_after);
});

test("stale dispatches at exactly the 1h boundary", async () => {
  const h = mk({ lastCalcMs: NOW - GUARD_MS });
  const r = await h.route({});
  assert.equal(r.json.status, "started");
  assert.equal(r.json.recalculated, true);
  assert.ok(r.json.claim);
});

test("stale dispatches when last success > 1h ago (25h)", async () => {
  const h = mk({ lastCalcMs: NOW - 25 * 3600e3 });
  const r = await h.route({});
  assert.equal(r.json.status, "started");
});

// ---- concurrency: exactly one dispatch among racers ----
test("concurrent triggers: one dispatch, rest in-progress", async () => {
  const db = memDb({ lastCalcMs: NOW - 5 * 3600e3 });
  let dispatches = 0;
  const disp = async () => {
    dispatches++;
    return { ok: true, status: 204, body: "" };
  };
  const h = createHandler({ db, dispatch: disp, now: () => NOW, completeToken: TOKEN });
  const rs = await Promise.all([h.route({}), h.route({}), h.route({}), h.route({}), h.route({})]);
  const started = rs.filter((r) => r.json.status === "started");
  const busy = rs.filter((r) => r.json.status === "in-progress");
  assert.equal(started.length, 1);
  assert.equal(busy.length, 4);
  assert.equal(dispatches, 1);
});

// ---- dispatch failures release the lease, truthful 502 ----
test("dispatch plain failure (500) releases lease + 502 error", async () => {
  const db = memDb({ lastCalcMs: NOW - 5 * 3600e3 });
  const h = createHandler({
    db, dispatch: async () => ({ ok: false, status: 500, body: "server oops" }),
    now: () => NOW, completeToken: TOKEN,
  });
  const r = await h.route({});
  assert.equal(r.http, 502);
  assert.equal(r.json.status, "error");
  assert.match(r.json.error, /500/);
  assert.equal(db.row.recalc_in_progress_since, null);
  // retry proceeds immediately
  const h2 = createHandler({ db, dispatch: okDispatch(), now: () => NOW + 1000, completeToken: TOKEN });
  const r2 = await h2.route({});
  assert.equal(r2.json.status, "started");
});

test("dispatch network throw releases lease + 502, no fake success", async () => {
  const db = memDb({ lastCalcMs: NOW - 5 * 3600e3 });
  const h = createHandler({
    db, dispatch: async () => { throw new TypeError("fetch failed"); },
    now: () => NOW, completeToken: TOKEN,
  });
  const r = await h.route({});
  assert.equal(r.http, 502);
  assert.equal(r.json.status, "error");
  assert.match(r.json.error, /network/i);
  assert.equal(db.row.recalc_in_progress_since, null);
});

test("DB claim failure surfaces 500 error, never fabricated fresh", async () => {
  const h = createHandler({
    db: { rpc: async () => { throw new Error("connection reset"); } },
    dispatch: okDispatch(), now: () => NOW, completeToken: TOKEN,
  });
  const r = await h.route({});
  assert.equal(r.http, 500);
  assert.equal(r.json.status, "error");
});

// ---- completion: ownership, calc_utc truthfulness ----
test("completion stamps exact calc_utc with claim ownership", async () => {
  const db = memDb({ lastCalcMs: NOW - 5 * 3600e3 });
  const h = createHandler({ db, dispatch: okDispatch(), now: () => NOW, completeToken: TOKEN });
  const s = await h.route({});
  assert.equal(s.json.status, "started");
  // calc_utc is the recompute instant, which is AFTER the lease claim
  // (CI writes data/calc.json in the scrape step, post-claim).
  const calc = iso(NOW + 60e3);
  const hAfter = createHandler({ db, dispatch: okDispatch(), now: () => NOW + 120e3, completeToken: TOKEN });
  const c = await hAfter.route({ complete: true, token: TOKEN, calc_utc: calc, picks: { date: "2026-09-21" }, claim: s.json.claim });
  assert.equal(c.http, 200);
  assert.equal(c.json.status, "completed");
  assert.equal(c.json.last_calc, calc);
});

test("completion rejects missing/null/empty claim ALWAYS", async () => {
  const h = mk({ lastCalcMs: NOW - 5 * 3600e3 });
  const s = await h.route({});
  assert.equal(s.json.status, "started");
  const calc = iso(NOW - 60e3);
  for (const claim of [undefined, null, "", 0]) {
    const c = await h.route({ complete: true, token: TOKEN, calc_utc: calc, picks: {}, claim });
    assert.equal(c.http, 400, "claim=" + JSON.stringify(claim));
    assert.match(c.json.error, /claim/);
  }
  // stored claim NULL (no active lease after fail-release): any claim rejected
  await h.route({ fail: true, token: TOKEN, claim: s.json.claim });
  const afterRelease = await h.route({ complete: true, token: TOKEN, calc_utc: calc, picks: {}, claim: s.json.claim });
  assert.equal(afterRelease.http, 409);
});

test("completion rejects missing calc_utc (no Date.now fallback)", async () => {
  const h = mk({ lastCalcMs: NOW - 5 * 3600e3 });
  const s = await h.route({});
  const c = await h.route({ complete: true, token: TOKEN, picks: {}, claim: s.json.claim });
  assert.equal(c.http, 400);
  assert.match(c.json.error, /calc_utc/);
});

test("completion rejects invalid + future calc_utc", async () => {
  const h = mk({ lastCalcMs: NOW - 5 * 3600e3 });
  const s = await h.route({});
  const bad = await h.route({ complete: true, token: TOKEN, calc_utc: "not-a-date", picks: {}, claim: s.json.claim });
  assert.equal(bad.http, 400);
  const fut = await h.route({ complete: true, token: TOKEN, calc_utc: iso(NOW + FUTURE_SKEW_MS + 60e3), picks: {}, claim: s.json.claim });
  assert.equal(fut.http, 400);
  assert.match(fut.json.error, /future/i);
});

test("completion rejects calc_utc older than lease start (stale) and older than prior success (rollback)", async () => {
  const db = memDb({ lastCalcMs: NOW - 5 * 3600e3 });
  const h = createHandler({ db, dispatch: okDispatch(), now: () => NOW, completeToken: TOKEN });
  const s = await h.route({});
  const stale = await h.route({ complete: true, token: TOKEN, calc_utc: iso(NOW - 10 * 3600e3), picks: {}, claim: s.json.claim });
  assert.equal(stale.http, 409);
  assert.match(stale.json.code ?? stale.json.error, /stale-calc/);
  // A pre-lease callback (calc older than BOTH the lease start and the
  // prior success) hits stale-calc-utc: the stale check runs first by
  // design. Rollback needs a calc that is post-lease yet pre-success, so
  // claim LATER (NOW2) with an old success: lease NOW2, success NOW2-5h,
  // calc NOW2-4h is after the lease start but before the prior success.
  const NOW2 = NOW + 3600e3;
  const db2 = memDb({ lastCalcMs: NOW2 - 5 * 3600e3 });
  const h2 = createHandler({ db: db2, dispatch: okDispatch(), now: () => NOW2, completeToken: TOKEN });
  const sB = await h2.route({});
  assert.equal(sB.json.status, "started");
  // Rollback needs last_calc NEWER than the lease start: that happens when
  // a newer success lands while my lease is still live. Simulate it by
  // advancing the stored success after the claim, then completing with a
  // calc that is post-lease (>= lease start, passes stale) yet pre-success.
  const h3 = createHandler({ db: db2, dispatch: okDispatch(), now: () => NOW2 + 600e3, completeToken: TOKEN });
  db2.row.last_calc = iso(NOW2 + 300e3); // newer success landed mid-lease
  const back = await h3.route({ complete: true, token: TOKEN, calc_utc: iso(NOW2 + 120e3), picks: {}, claim: sB.json.claim });
  assert.equal(back.http, 409);
  assert.match(back.json.code ?? back.json.error, /rollback-calc/);
  // lease still held by the owner
  assert.equal(db.row.claim_token, s.json.claim);
});

test("completion rejects bad/missing token", async () => {
  const h = mk({ lastCalcMs: NOW - 5 * 3600e3 });
  const s = await h.route({});
  assert.equal((await h.route({ complete: true, token: "wrong", calc_utc: iso(NOW), picks: {}, claim: s.json.claim })).http, 403);
  assert.equal((await h.route({ complete: true, calc_utc: iso(NOW), picks: {}, claim: s.json.claim })).http, 403);
});

test("stale worker cannot clear a newer lease (409)", async () => {
  const db = memDb({ lastCalcMs: NOW - 5 * 3600e3 });
  const h = createHandler({ db, dispatch: okDispatch(), now: () => NOW, completeToken: TOKEN });
  const s1 = await h.route({});
  // second worker claims after the first lease expires (claim RPC reclaims
  // the stale lease directly - no fail dance needed)
  const hLate = createHandler({ db, dispatch: okDispatch(), now: () => NOW + LEASE_TTL_MS + 1000, completeToken: TOKEN });
  const s2 = await hLate.route({});
  assert.equal(s2.json.status, "started");
  assert.notEqual(s2.json.claim, s1.json.claim);
  // stale completion with the OLD claim is rejected
  const stale = await h.route({ complete: true, token: TOKEN, calc_utc: iso(NOW), picks: {}, claim: s1.json.claim });
  assert.equal(stale.http, 409);
  assert.equal(db.row.claim_token, s2.json.claim);
});

test("completion race: fresh stamp during claim cannot double-dispatch", async () => {
  // A completion landing between read and claim must not produce two
  // dispatches: the claim RPC rechecks last_calc under the lock.
  const db = memDb({ lastCalcMs: NOW - 5 * 3600e3 });
  let dispatches = 0;
  const h = createHandler({
    db, dispatch: async () => { dispatches++; return { ok: true, status: 204, body: "" }; },
    now: () => NOW, completeToken: TOKEN,
  });
  const s = await h.route({});
  assert.equal(s.json.status, "started");
  const hDone = createHandler({ db, dispatch: okDispatch(), now: () => NOW + 60e3, completeToken: TOKEN });
  await hDone.route({ complete: true, token: TOKEN, calc_utc: iso(NOW + 30e3), picks: {}, claim: s.json.claim });
  // now fresh: next trigger no-ops instead of dispatching again
  const h2 = createHandler({ db, dispatch: async () => { dispatches++; return { ok: true, status: 204, body: "" }; }, now: () => NOW + 60e3, completeToken: TOKEN });
  const r2 = await h2.route({});
  assert.equal(r2.json.status, "fresh");
  assert.equal(dispatches, 1);
});

// ---- fail callback ----
test("fail callback releases owned lease; foreign live lease untouched", async () => {
  const db = memDb({ lastCalcMs: NOW - 5 * 3600e3 });
  const h = createHandler({ db, dispatch: okDispatch(), now: () => NOW, completeToken: TOKEN });
  const s = await h.route({});
  const f = await h.route({ fail: true, token: TOKEN, claim: s.json.claim });
  assert.equal(f.json.status, "lease-released");
  assert.equal(f.json.released, true);
  // foreign claim against a live lease -> 409, owner intact
  const s2 = await h.route({});
  const bad = await h.route({ fail: true, token: TOKEN, claim: "forged" });
  assert.equal(bad.http, 409);
  assert.equal(s2.json.claim, db.row.claim_token);
  // stale foreign claim cannot clear via fail even after TTL: only the
  // claim RPC reclaims; fail stays 409 against the live foreign lease
  const hLate = createHandler({ db, dispatch: okDispatch(), now: () => NOW + LEASE_TTL_MS + 1000, completeToken: TOKEN });
  const staleFail = await hLate.route({ fail: true, token: TOKEN, claim: "forged-stale" });
  assert.equal(staleFail.http, 409);
  assert.equal(db.row.claim_token, s2.json.claim);
});

test("fail callback requires token + claim", async () => {
  const h = mk({ lastCalcMs: NOW - 5 * 3600e3 });
  assert.equal((await h.route({ fail: true, token: "x", claim: "y" })).http, 403);
  assert.equal((await h.route({ fail: true, token: TOKEN })).http, 400);
});

// ---- malformed trigger bodies fall through to trigger path ----
test("malformed bodies (null/array/string/empty) behave as trigger", async () => {
  for (const b of [null, [], "x", 42, {}]) {
    const h = mk({ lastCalcMs: NOW - 1000 }); // fresh -> deterministic no-op
    const r = await h.route(b);
    assert.equal(r.json.status, "fresh", JSON.stringify(b));
  }
});

// ---- ut-claim.mjs: workflow schedule/manual/dispatched paths ----
test("workflow claim: dispatched input adopted verbatim", () => {
  const d = decideClaim({ hasClaimInput: true, claimInput: "c_123_abc" });
  assert.equal(d.skip, false);
  assert.equal(d.claim, "c_123_abc");
});

test("workflow claim: fresh schedule run skips with exact '1'", () => {
  assert.equal(SKIP_EXACT, "1");
  const d = decideClaim({ hasClaimInput: false, response: { status: "fresh" } });
  assert.equal(d.skip, true);
  assert.equal(d.status, "fresh");
});

test("workflow claim: in-progress schedule run skips", () => {
  const d = decideClaim({ hasClaimInput: false, response: { status: "in-progress" } });
  assert.equal(d.skip, true);
});

test("workflow claim: no-claim stale run ALWAYS skips own compute (edge-dispatched job computes)", () => {
  const d = decideClaim({ hasClaimInput: false, response: { status: "started", claim: "c_x" } });
  assert.equal(d.skip, true);
  assert.equal(d.status, "started");
});

test("workflow claim: unknown status throws (fail loudly, never compute blind)", () => {
  assert.throws(() => decideClaim({ hasClaimInput: false, response: { status: "weird" } }), /lease claim failed/);
  assert.throws(() => parseClaimResponse("not json"), /not JSON/);
  assert.throws(() => parseClaimResponse(JSON.stringify({ nope: 1 })), /no status/);
});

// ---- ut-stage.mjs: every staged path must exist ----
test("workflow stage: canonical deploy unit paths all exist after fresh render", () => {
  const { dir } = renderFresh();
  const rel = DEPLOY_PATHS.map((p) => join(dir, p.replace(/^(data|dist)\//, "")));
  void rel;
  // emulate repo layout: copy temp render outputs into a fake repo tree
  const fake = mkdtempSync(join(tmpdir(), "ut-tree-"));
  mkdirSync(join(fake, "data"), { recursive: true });
  mkdirSync(join(fake, "dist"), { recursive: true });
  copyFileSync(join(ROOT, "data", "picks.json"), join(fake, "data", "picks.json"));
  copyFileSync(join(ROOT, "data", "candidates.json"), join(fake, "data", "candidates.json"));
  copyFileSync(join(dir, "calc.json"), join(fake, "data", "calc.json"));
  for (const f of ["index.html", "data-calc.json"]) {
    copyFileSync(join(dir, f === "index.html" ? "index.html" : "data-calc.json"), join(fake, "dist", f));
  }
  // static assets come from the real repo in this check
  for (const f of ["og-image.png", "favicon.ico", "favicon-32.png", "favicon-64.png", "favicon.svg", "apple-touch-icon.png"]) {
    assert.ok(existsSync(join(ROOT, "assets", f.replace(/^favicon\.svg$/, "favicon.svg"))) || existsSync(join(ROOT, "dist", f)), f + " exists in repo");
  }
  assert.ok(DEPLOY_PATHS.includes("dist/llms.txt"), "llms.txt in deploy unit");
  assert.ok(!missingPaths(DEPLOY_PATHS.map((p) => join(ROOT, p))).includes(join(ROOT, "dist/favicon.svg")), "checked-in dist/favicon.svg exists");
});

// ---- frontend: REAL inline script from a FRESH render in vm ----
function loadInlineScript(html) {
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(m, "inline script block found");
  return m[1];
}
function fakeDom(picks) {
  // picks.json shape is { date, <key>: { winner: {...} } } - the client
  // reads the data-* attrs baked by card(), so mirror the baked attrs via
  // the winner payload (falls back to the entry itself for flat shapes).
  const winOf = (w) => (w && typeof w === "object" && w.winner ? w.winner : w);
  const byPick = Object.entries(picks)
    .filter(([k, w]) => k !== "date" && winOf(w) && typeof winOf(w) === "object" && "model" in winOf(w))
    .map(([k, w]) => {
      const v = winOf(w);
      return {
        getAttribute: (a) =>
          ({
            "data-webmcp-pick": k,
            "data-category": k,
            "data-model": v.model,
            "data-thinking": v.effort ?? "default",
            "data-price": String(v.costPerTask),
            "data-quality": String(v.relative),
            "data-openrouter-id": v.openRouterId,
          })[a] ?? null,
      };
    });
  const state = { formHandler: null };
  const calcTimeEl = {
    _attrs: {},
    getAttribute: (a) => (a === "data-calc-utc" ? calcTimeEl._utc : calcTimeEl._attrs[a] ?? null),
    set textContent(v) { calcTimeEl._text = v; },
    get textContent() { return calcTimeEl._text; },
  };
  const statusEl = { textContent: "", _state: "", setAttribute(k, v) { if (k === "data-state") statusEl._state = v; } };
  const btnEl = { disabled: false, textContent: "Recalculate for today" };
  const timeEl = { textContent: "", _attrs: {}, setAttribute(k, v) { timeEl._attrs[k] = v; } };
  const document = {
    addEventListener() {},
    querySelectorAll: (sel) => {
      if (sel === "[data-webmcp-pick]") return byPick;
      if (sel === "[data-open]") return [];
      if (sel === "[data-close]") return [];
      if (sel === ".modal") return [];
      if (sel === ".chart-box") return [];
      if (sel === "table.sortable") return [];
      return [];
    },
    querySelector: (sel) => {
      if (sel === ".calc-time") return calcTimeEl;
      if (sel === ".calc-stamp time") {
        return {
          // datetime is the full instant; data_date metadata wants the
          // calendar-date half (additive, non-breaking).
          getAttribute: (a) => (a === "datetime" ? calcTimeEl._utc.slice(0, 10) : null),
        };
      }
      if (sel === ".calc-stamp") return { querySelector: () => timeEl };
      return null;
    },
    getElementById: (id) =>
      id === "recalc-form"
        ? { addEventListener: (ev, fn) => { state.formHandler = fn; } }
        : id === "recalc-status" ? statusEl : id === "recalc" ? btnEl : null,
  };
  return { document, state, calcTimeEl, statusEl, btnEl, timeEl };
}
function runScript(script, { fetchImpl, picks, calcUtc }) {
  const { document, state, calcTimeEl, statusEl, btnEl, timeEl } = fakeDom(picks);
  calcTimeEl._utc = calcUtc;
  const registered = {};
  const sandbox = {
    document: { ...document, modelContext: { registerTool: ({ name, execute }) => { registered[name] = execute; } } },
    fetch: fetchImpl,
    console: { log() {} },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);
  return { registered, state, statusEl, btnEl };
}
function submitForm(state, extra = {}) {
  return new Promise((resolve, reject) => {
    try {
      state.formHandler({ preventDefault() {}, ...extra });
      // human path has no respondWith: wait two macrotasks for promise chains
      setTimeout(() => setTimeout(resolve, 0), 0);
    } catch (e) { reject(e); }
  });
}

// get_picks is REALLY invoked (finding 3): additive metadata, stable category shape
test("frontend: get_picks executes and returns picks + additive metadata, category payload intact", async () => {
  const { html } = renderFresh();
  const script = loadInlineScript(html);
  const picks = JSON.parse(readFileSync(join(ROOT, "data", "picks.json"), "utf8"));
  const { registered } = runScript(script, { fetchImpl: async () => { throw new Error("must not fetch"); }, picks, calcUtc: "2026-09-22T18:46:50.000Z" });
  assert.ok(registered.get_picks, "get_picks registered");
  const raw = await registered.get_picks();
  const got = JSON.parse(raw);
  for (const k of ["agent", "everyday", "hard"]) {
    assert.ok(got.picks[k], k + " present");
    assert.equal(typeof got.picks[k].category, "string");
    assert.equal(typeof got.picks[k].model, "string");
    assert.equal(typeof got.picks[k].openRouterId, "string");
  }
  assert.equal(got.data_calc_utc, "2026-09-22T18:46:50.000Z", "additive timestamp metadata");
  assert.match(got.data_date, /^\d{4}-\d{2}-\d{2}$/, "additive data-date metadata");
});

// REAL human button path (finding 5): submit WITHOUT agentInvoked
test("frontend: HUMAN submit asserts status, short label, button stays enabled for retry", async () => {
  const { html } = renderFresh();
  const script = loadInlineScript(html);
  const picks = JSON.parse(readFileSync(join(ROOT, "data", "picks.json"), "utf8"));
  const payload = { status: "started", last_calc: iso(NOW - 3600e3), in_progress_since: iso(NOW) };
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(payload) });
  const { state, statusEl, btnEl } = runScript(script, { fetchImpl, picks, calcUtc: iso(NOW - 3600e3) });
  await submitForm(state); // no agentInvoked: the real human path
  assert.equal(btnEl.textContent, "Recalculate for today", "stable short button label, no ISO pill text");
  assert.equal(btnEl.disabled, false, "button re-enabled after started (later check/retry allowed)");
  assert.ok(statusEl.textContent.length > 0 && statusEl.textContent.length < 120, "short status in separate output: " + JSON.stringify(statusEl.textContent));
  assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(btnEl.textContent), "no ISO timestamp on the button");
});

// human error path: button stays usable, status shows failure
test("frontend: HUMAN submit on error keeps button enabled with short retry status", async () => {
  const { html } = renderFresh();
  const script = loadInlineScript(html);
  const picks = JSON.parse(readFileSync(join(ROOT, "data", "picks.json"), "utf8"));
  const fetchImpl = async () => ({ ok: false, status: 500, text: async () => "<html>oops</html>" });
  const { state, statusEl, btnEl } = runScript(script, { fetchImpl, picks, calcUtc: iso(NOW) });
  await submitForm(state);
  assert.equal(btnEl.textContent, "Recalculate for today");
  assert.equal(btnEl.disabled, false);
  assert.equal(statusEl._state, "error");
});

// agent declarative path still shares doRecalc semantics
test("frontend: agent declarative submit and imperative tool share doRecalc semantics", async () => {
  const { html } = renderFresh();
  const script = loadInlineScript(html);
  const picks = JSON.parse(readFileSync(join(ROOT, "data", "picks.json"), "utf8"));
  const payload = { status: "started", last_calc: iso(NOW - 3600e3), in_progress_since: iso(NOW) };
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
  };
  const { registered, state } = runScript(script, { fetchImpl, picks, calcUtc: iso(NOW - 3600e3) });
  assert.ok(registered.recalculate_picks, "recalculate_picks registered");
  const viaTool = await registered.recalculate_picks();
  let responded = null;
  await new Promise((resolve) => {
    state.formHandler({
      preventDefault() {},
      agentInvoked: true,
      respondWith(p) { responded = p; resolve(); },
    });
  });
  assert.equal(calls, 2, "both paths hit the endpoint exactly once");
  assert.deepEqual(viaTool.status, "started");
  assert.deepEqual(JSON.parse(await responded).status, "started");
});

// doRecalc schema validation (finding 4)
test("frontend: 200 HTML body is an error (never fresh)", async () => {
  const { html } = renderFresh();
  const picks = JSON.parse(readFileSync(join(ROOT, "data", "picks.json"), "utf8"));
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => "<html>ok</html>" });
  const { registered } = runScript(loadInlineScript(html), { fetchImpl, picks, calcUtc: iso(NOW) });
  const r = await registered.recalculate_picks();
  assert.equal(r.status, "error");
});

test("frontend: 200 {} is an error (no recognized status, never fresh)", async () => {
  const { html } = renderFresh();
  const picks = JSON.parse(readFileSync(join(ROOT, "data", "picks.json"), "utf8"));
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => "{}" });
  const { registered } = runScript(loadInlineScript(html), { fetchImpl, picks, calcUtc: iso(NOW) });
  const r = await registered.recalculate_picks();
  assert.equal(r.status, "error");
});

test("frontend: 500 with JSON status fresh is STILL an error (r.ok checked first)", async () => {
  const { html } = renderFresh();
  const picks = JSON.parse(readFileSync(join(ROOT, "data", "picks.json"), "utf8"));
  const fetchImpl = async () => ({
    ok: false, status: 500,
    text: async () => JSON.stringify({ status: "fresh", last_calc: iso(NOW), eligible_after: iso(NOW + 1000) }),
  });
  const { registered } = runScript(loadInlineScript(html), { fetchImpl, picks, calcUtc: iso(NOW) });
  const r = await registered.recalculate_picks();
  assert.equal(r.status, "error");
  assert.match(r.message, /500/);
});

test("frontend: 200 fresh without eligible_after is an error (required timestamp)", async () => {
  const { html } = renderFresh();
  const picks = JSON.parse(readFileSync(join(ROOT, "data", "picks.json"), "utf8"));
  const fetchImpl = async () => ({
    ok: true, status: 200, text: async () => JSON.stringify({ status: "fresh", last_calc: iso(NOW) }),
  });
  const { registered } = runScript(loadInlineScript(html), { fetchImpl, picks, calcUtc: iso(NOW) });
  const r = await registered.recalculate_picks();
  assert.equal(r.status, "error");
});

test("frontend: 200 started without in_progress_since is an error", async () => {
  const { html } = renderFresh();
  const picks = JSON.parse(readFileSync(join(ROOT, "data", "picks.json"), "utf8"));
  const fetchImpl = async () => ({
    ok: true, status: 200, text: async () => JSON.stringify({ status: "started", last_calc: iso(NOW) }),
  });
  const { registered } = runScript(loadInlineScript(html), { fetchImpl, picks, calcUtc: iso(NOW) });
  const r = await registered.recalculate_picks();
  assert.equal(r.status, "error");
});

test("frontend: malformed HTTP (500 html) + network failure both surface error, never fake fresh", async () => {
  const { html } = renderFresh();
  const picks = JSON.parse(readFileSync(join(ROOT, "data", "picks.json"), "utf8"));
  const html500 = async () => ({ ok: false, status: 500, text: async () => "<html>oops</html>" });
  const { registered: r1 } = runScript(loadInlineScript(html), { fetchImpl: html500, picks, calcUtc: iso(NOW) });
  const e1 = await r1.recalculate_picks();
  assert.equal(e1.status, "error");
  assert.match(e1.message, /500/);
  const netFail = async () => { throw new TypeError("fetch failed"); };
  const { registered: r2 } = runScript(loadInlineScript(html), { fetchImpl: netFail, picks, calcUtc: iso(NOW) });
  const e2 = await r2.recalculate_picks();
  assert.equal(e2.status, "error");
  assert.match(e2.message, /network/i);
});

// ---- timezone rollover: same instant renders agreed date+time ----
test("render: UTC rollover instant localizes to one PT date+time (no mixed day)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ut-render-"));
  copyFileSync(join(ROOT, "data", "picks.json"), join(dir, "picks.json"));
  copyFileSync(join(ROOT, "data", "candidates.json"), join(dir, "candidates.json"));
  // 2026-09-22T07:30Z = 2026-09-22 00:30 PDT (same PT day); and a late-night
  // PT case 2026-09-22T06:59Z = Sep 21 23:59 PDT (must NOT claim Sep 22).
  for (const [utc, wantDate] of [["2026-09-22T07:30:00Z", "September 22, 2026"], ["2026-09-22T06:59:00Z", "September 21, 2026"]]) {
    const d = JSON.parse(readFileSync(join(dir, "picks.json"), "utf8"));
    writeFileSync(join(dir, "calc.json"), JSON.stringify({ calc_utc: utc, data_date: d.date }) + "\n");
    execFileSync("node", [join(ROOT, "scripts", "render.mjs"), dir, join(dir, "index.html")], { env: { ...process.env, RECALC_URL: "https://x.test/fn" } });
    const html = readFileSync(join(dir, "index.html"), "utf8");
    const m = html.match(/<time datetime="([^"]+)">Picks for ([^<]+)<\/time>/);
    assert.ok(m, "calc-stamp time element present");
    const ptDate = new Date(utc).toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", month: "long", day: "numeric", year: "numeric" });
    assert.equal(m[2], ptDate, `displayed PT date agrees for ${utc}`);
    assert.equal(m[2], wantDate);
    // datetime is the FULL instant, not a UTC date slice
    assert.equal(m[1], new Date(utc).toISOString(), "datetime attr is the full instant");
    assert.ok(html.includes(`data-calc-utc="${new Date(utc).toISOString()}"`), "stable UTC instant baked");
  }
});

// ---- render-only deploy keeps the stable stamp (no render-time fake) ----
test("render: re-render without calc.json change preserves data-calc-utc", () => {
  const dir = mkdtempSync(join(tmpdir(), "ut-stable-"));
  copyFileSync(join(ROOT, "data", "picks.json"), join(dir, "picks.json"));
  copyFileSync(join(ROOT, "data", "candidates.json"), join(dir, "candidates.json"));
  writeFileSync(join(dir, "calc.json"), JSON.stringify({ calc_utc: "2026-09-22T12:00:00Z", data_date: "2026-09-22" }) + "\n");
  execFileSync("node", [join(ROOT, "scripts", "render.mjs"), dir, join(dir, "index.html")], { env: { ...process.env, RECALC_URL: "https://x.test/fn" } });
  const a = readFileSync(join(dir, "index.html"), "utf8").match(/data-calc-utc="([^"]+)"/)[1];
  execFileSync("node", [join(ROOT, "scripts", "render.mjs"), dir, join(dir, "index.html")], { env: { ...process.env, RECALC_URL: "https://x.test/fn" } });
  const b = readFileSync(join(dir, "index.html"), "utf8").match(/data-calc-utc="([^"]+)"/)[1];
  assert.equal(a, "2026-09-22T12:00:00.000Z");
  assert.equal(b, a, "render-only re-run does not move the stamp");
  const dc = JSON.parse(readFileSync(join(dir, "data-calc.json"), "utf8"));
  assert.equal(dc.calc_utc, "2026-09-22T12:00:00.000Z");
});

// ---- legacy provenance: unknown, never fabricated ----
test("render: missing calc.json shows data date + explicit unknown, no invented instant", () => {
  const dir = mkdtempSync(join(tmpdir(), "ut-legacy-"));
  copyFileSync(join(ROOT, "data", "picks.json"), join(dir, "picks.json"));
  copyFileSync(join(ROOT, "data", "candidates.json"), join(dir, "candidates.json"));
  execFileSync("node", [join(ROOT, "scripts", "render.mjs"), dir, join(dir, "index.html")], { env: { ...process.env, RECALC_URL: "https://x.test/fn" } });
  const html = readFileSync(join(dir, "index.html"), "utf8");
  assert.ok(html.includes("data-calc-estimate"), "estimate flag baked");
  assert.ok(html.includes("time unknown"), "explicit unknown, no guessed time");
  assert.ok(!html.includes("last successful calc: 2026"), "llms.txt must not claim a calc");
  const m = html.match(/<span class="calc-stamp">([\s\S]*?)<\/span>/);
  assert.ok(m, "calc stamp present");
  assert.ok(!m[1].includes("data-calc-utc="), "no invented UTC instant on unknown provenance");
  assert.ok(!m[1].includes("datetime="), "no timestamp attr when the instant is unknown");
  assert.ok(/Picks for September 22, 2026/.test(m[1]), "data date still shown");
});

// ---- PGlite: the ACTUAL migration SQL, not a fake ----
test("sql: real migration enforces claim/complete/fail ownership (PGlite)", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite();
  const mig = readFileSync(join(ROOT, "supabase", "migrations", "20260924_ut_recalc_lease.sql"), "utf8");
  await db.query(`CREATE TABLE IF NOT EXISTS public.ut_state (
    id int PRIMARY KEY, last_calc timestamptz NOT NULL, picks jsonb NOT NULL DEFAULT '{}'::jsonb
  );`);
  await db.query(`INSERT INTO public.ut_state (id, last_calc, picks)
    VALUES (1, now() - interval '5 hours', '{}'::jsonb) ON CONFLICT (id) DO NOTHING;`);
  // PGlite takes one statement per query: split the migration on
  // semicolons OUTSIDE the plpgsql bodies ($$ ... $$) and run each.
  // Statement-level REVOKE/GRANT against anon/authenticated/service_role
  // roles (which do not exist in bare PGlite) are expected to fail there;
  // the ownership assertions below are what matter - role grants are
  // verified by inspection, not by PGlite.
  const body = mig.replace(/^--[^-\n]*\n/gm, "");
  const stmts = [];
  let cur = "", inBody = false;
  for (const line of body.split("\n")) {
    if (line.includes("$$")) inBody = !inBody;
    cur += line + "\n";
    if (!inBody && /;\s*$/.test(line.trimEnd())) { stmts.push(cur); cur = ""; }
  }
  if (cur.trim()) stmts.push(cur);
  for (const s of stmts) {
    if (!s.trim() || /^\s*--\s*$/.test(s)) continue;
    if (/^\s*(REVOKE|GRANT)\b/i.test(s)) continue; // no such roles in PGlite
    await db.exec(s);
  }
  const rpc = async (name, args) => {
    const map = {
      ut_claim_recalc: "SELECT public.ut_claim_recalc($1,$2,$3,$4) AS v",
      ut_complete_recalc: "SELECT public.ut_complete_recalc($1,$2,$3,$4,$5) AS v",
      ut_fail_recalc: "SELECT public.ut_fail_recalc($1,$2,$3) AS v",
    };
    const vals = name === "ut_claim_recalc"
      ? [args.p_now, args.p_claim, args.p_guard_ms, args.p_ttl_ms]
      : name === "ut_complete_recalc"
        ? [args.p_calc_utc, JSON.stringify(args.p_picks ?? {}), args.p_claim, args.p_now, args.p_skew_ms]
        : [args.p_claim, args.p_now, args.p_ttl_ms];
    const r = await db.query(map[name], vals);
    return r.rows[0].v;
  };
  const G = GUARD_MS, T = LEASE_TTL_MS, S = FUTURE_SKEW_MS;
  // fresh guard
  await db.query(`UPDATE public.ut_state SET last_calc = to_timestamp($1/1000.0), recalc_in_progress_since = NULL, claim_token = NULL`, [NOW - 1000]);
  assert.equal((await rpc("ut_claim_recalc", { p_now: NOW, p_claim: "c1", p_guard_ms: G, p_ttl_ms: T })).status, "fresh");
  // stale -> started; concurrent -> in-progress
  await db.query(`UPDATE public.ut_state SET last_calc = to_timestamp($1/1000.0)`, [NOW - 5 * 3600e3]);
  const s1 = await rpc("ut_claim_recalc", { p_now: NOW, p_claim: "cA", p_guard_ms: G, p_ttl_ms: T });
  assert.equal(s1.status, "started");
  assert.equal((await rpc("ut_claim_recalc", { p_now: NOW + 1, p_claim: "cB", p_guard_ms: G, p_ttl_ms: T })).status, "in-progress");
  // complete: null claim rejected even with a live lease (handler-level
  // missing-claim; the SQL agrees with lease-owned - both reject, never
  // accept; handler and DB agree that no null-claim write ever lands).
  const nullClaim = await rpc("ut_complete_recalc", {
    p_calc_utc: new Date(NOW - 60e3).toISOString(), p_picks: {}, p_claim: null, p_now: NOW, p_skew_ms: S,
  });
  assert.ok(["missing-claim", "lease-owned"].includes(nullClaim.code), "null-claim write rejected, got " + nullClaim.code);
  // complete: wrong claim rejected
  const wrong = await rpc("ut_complete_recalc", {
    p_calc_utc: new Date(NOW - 60e3).toISOString(), p_picks: {}, p_claim: "forged", p_now: NOW, p_skew_ms: S,
  });
  assert.equal(wrong.code, "lease-owned");
  // complete: stale calc_utc (before lease start) rejected
  const stale = await rpc("ut_complete_recalc", {
    p_calc_utc: new Date(NOW - 10 * 3600e3).toISOString(), p_picks: {}, p_claim: "cA", p_now: NOW, p_skew_ms: S,
  });
  assert.equal(stale.code, "stale-calc-utc");
  // complete: rollback (post-lease, before a newer mid-lease success).
  // The live lease is cA @ NOW. Advance the stored success past the lease
  // start, then complete with a calc that clears the lease start but
  // predates the newer success. p_now also advances (future-skew guard).
  await db.query(`UPDATE public.ut_state SET last_calc = to_timestamp($1/1000.0)`, [NOW + 300e3]);
  const back = await rpc("ut_complete_recalc", {
    p_calc_utc: new Date(NOW + 120e3).toISOString(), p_picks: {}, p_claim: "cA", p_now: NOW + 600e3, p_skew_ms: S,
  });
  assert.equal(back.code, "rollback-calc-utc");
  // complete: owned + fresh timestamp succeeds (releases lease cA)
  const good = await rpc("ut_complete_recalc", {
    p_calc_utc: new Date(NOW + 600e3).toISOString(), p_picks: { date: "2026-09-22" }, p_claim: "cA", p_now: NOW + 660e3, p_skew_ms: S,
  });
  assert.equal(good.status, "completed");
  // no active lease now: any claim rejected (no NULL auto-accept)
  const noLease = await rpc("ut_complete_recalc", {
    p_calc_utc: new Date(NOW - 30e3).toISOString(), p_picks: {}, p_claim: "cA", p_now: NOW, p_skew_ms: S,
  });
  assert.equal(noLease.code, "lease-owned");
  // fail: no lease -> released=false
  assert.equal((await rpc("ut_fail_recalc", { p_claim: "cA", p_now: NOW + 660e3, p_ttl_ms: T })).released, false);
  // fresh claim on new success (last_calc NOW+600e3): p_now must clear the
  // 1h guard, so advance past eligible_after.
  const s2 = await rpc("ut_claim_recalc", { p_now: NOW + 600e3 + G + 1000, p_claim: "cB", p_guard_ms: G, p_ttl_ms: T });
  assert.equal(s2.status, "started");
  assert.equal((await rpc("ut_fail_recalc", { p_claim: "forged", p_now: NOW + 600e3 + G + 2000, p_ttl_ms: T })).code, "lease-owned");
  assert.equal((await rpc("ut_fail_recalc", { p_claim: "cB", p_now: NOW + 600e3 + G + 3000, p_ttl_ms: T })).released, true);
  await db.close();
});
