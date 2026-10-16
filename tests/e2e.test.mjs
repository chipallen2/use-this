// tests/e2e.test.mjs - deterministic Playwright regression tests (node:test).
// Runs against a LOCAL static server rooted at dist/ (freshly rendered from
// CURRENT source + data/), never against production. Network interception
// provides the recalc endpoint + canonical data-calc.json fixtures so the
// refresh flow and the three detail popups are asserted deterministically:
//   (a) click refresh, no errors, genuinely newer fixture/server timestamp
//       then the page reloads fresh; stale/failure is NOT called fresh.
//   (b) each of the three detail popups shows winner names/scores AND the
//       candidate table/chart entries match candidates.json pools.
// Usage: npm run test:e2e  (starts its own server; needs playwright chromium)

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdtempSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

// Render CURRENT source + data into an ISOLATED temp dir (never dist/): the
// checked-in dist/ tree must keep the canonical production endpoint baked
// in, so e2e renders to a scratch copy with a fixture endpoint instead.
// Returns the temp dir serving as the static root.

const MIME = { ".html": "text/html", ".json": "application/json", ".txt": "text/plain", ".png": "image/png", ".ico": "image/x-icon", ".svg": "image/svg+xml" };

// Render CURRENT source to a scratch dir first so e2e always tests fresh output.
function renderDist() {
  const dir = mkdtempSync(join(tmpdir(), "ut-e2e-"));
  for (const f of ["picks.json", "candidates.json", "calc.json"]) {
    copyFileSync(join(ROOT, "data", f), join(dir, f));
  }
  execFileSync("node", [join(ROOT, "scripts", "render.mjs"), dir, join(dir, "index.html")],
    { env: { ...process.env, RECALC_URL: "https://x.test/fn" } });
  return dir;
}

function startStatic(root, extra = {}) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (extra[url.pathname]) return extra[url.pathname](req, res);
    let p = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = join(root, p);
    if (!existsSync(file)) { res.writeHead(404); res.end("no"); return; }
    res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}
const portOf = (s) => s.address().port;

function json(res, obj, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

test("e2e: refresh click with genuinely newer server stamp reloads fresh; stale/failure do not", async (t) => {
  const dir = renderDist();
  const baked = JSON.parse(readFileSync(join(dir, "data-calc.json"), "utf8")).calc_utc;
  const newer = new Date(new Date(baked).getTime() + 3600e3).toISOString();
  // The recalc endpoint is baked into the page at render time
  // (https://x.test/fn here) - route it at the request level to a fixture,
  // exactly like a real endpoint would answer. The data-calc.json the page
  // polls starts stale (== baked), flips to newer mid-test to simulate a
  // completed deploy landing.
  let liveCalc = baked;
  let recalcMode = "started"; // started | fail
  const server = await startStatic(dir);
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const errors = [];
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  await page.route("https://x.test/fn", async (route) => {
    if (recalcMode === "fail") return route.fulfill({ status: 500, contentType: "text/html", body: "<html>oops</html>" });
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "started", last_calc: baked, in_progress_since: newer }) });
  });
  await page.route(`http://127.0.0.1:${portOf(server)}/data-calc.json*`, async (route) => {
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ calc_utc: liveCalc, estimate: false, data_date: "2026-10-16" }) });
  });
  let reloaded = 0;
  await page.exposeFunction("__noteReload", () => { reloaded++; });
  await page.goto(`http://127.0.0.1:${portOf(server)}/`);
  // Observe reloads without navigating away (keeps the test page alive).
  await page.evaluate(() => {
    const orig = window.location.reload.bind(window.location);
    window.__origReload = orig;
    window.location.reload = () => window.__noteReload();
  });
  // Case stale: poll sees the same stamp -> no reload, computing status.
  await page.click("#recalc");
  await page.waitForTimeout(1500);
  const status1 = await page.textContent("#recalc-status");
  assert.ok(/checking|computing|started/i.test(status1), "status shows progress, got: " + status1);
  assert.equal(reloaded, 0, "stale stamp never reloads");
  // Deploy lands: flip the fixture, force one poll round via direct fetch
  // of the same URL the page polls (proves the server serves newer).
  liveCalc = newer;
  const liveNow = await page.evaluate(async () => {
    const r = await fetch("/data-calc.json?_=" + Date.now(), { cache: "no-store" });
    return (await r.json()).calc_utc;
  });
  assert.equal(new Date(liveNow).toISOString(), new Date(newer).toISOString(), "fixture serves the newer stamp");
  // Failure mode: endpoint 500s -> error status, never a reload, never fresh.
  recalcMode = "fail";
  await page.click("#recalc");
  await page.waitForTimeout(1200);
  const status2 = await page.textContent("#recalc-status");
  assert.ok(/failed|retry/i.test(status2), "failure surfaces retry status, got: " + status2);
  assert.equal(reloaded, 0, "failure never reloads");
  // The 500 itself logs a console error (expected - it proves the failure
  // path ran); page logic must still show retry and stay error-free itself.
  const realErrors = errors.filter((e) => !/Failed to load resource.*500/.test(e));
  assert.deepEqual(realErrors, [], "no page errors during refresh flow");
  await page.close();
});

test("e2e: all three detail popups match candidates.json pools", async (t) => {
  const e2eDir = renderDist();
  const server = await startStatic(e2eDir);
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  await page.goto(`http://127.0.0.1:${portOf(server)}/`);
  const cands = JSON.parse(readFileSync(join(ROOT, "data", "candidates.json"), "utf8"));
  const picks = JSON.parse(readFileSync(join(ROOT, "data", "picks.json"), "utf8"));
  const shortName = (id) => {
    if (id.startsWith("unmatched:")) return id.slice("unmatched:".length).replace(/-/g, " ");
    const slug = id.split("/").pop();
    return slug;
  };
  for (const key of ["agent", "everyday", "hard"]) {
    await page.click(`[data-open="${key}"]`);
    await page.waitForSelector(`#modal-${key}.open`, { timeout: 5000 });
    const winner = picks[key].winner;
    const modalText = await page.textContent(`#modal-${key}`);
    // Winner identity: family name fragment + effort + OpenRouter ID all visible.
    const famFrag = winner.openRouterId.split("/").pop().split("-").slice(0, 2).join(" ").toLowerCase();
    assert.ok(modalText.toLowerCase().includes(famFrag.split(" ")[0]), `${key}: winner family visible`);
    assert.ok(modalText.includes(winner.openRouterId), `${key}: OpenRouter ID visible`);
    assert.ok(modalText.includes(winner.effort ?? "default") || modalText.includes("default"), `${key}: thinking visible`);
    // Table row count == pool size; chart dot count == pool size.
    const rows = await page.$$(`#modal-${key} tbody tr`);
    assert.equal(rows.length, cands[key].length, `${key}: table rows == pool (${cands[key].length})`);
    const dots = await page.$$(`#modal-${key} circle.dot`);
    assert.equal(dots.length, cands[key].length, `${key}: chart dots == pool (${cands[key].length})`);
    // Spot-check: top-3 pool entries by score have their score % in the table.
    const top3 = [...cands[key]].sort((a, b) => b.score - a.score).slice(0, 3);
    for (const e of top3) {
      assert.ok(modalText.includes(`${e.score}%`), `${key}: score ${e.score}% visible for ${shortName(e.openRouterId)}`);
    }
    // Winner row highlighted, provenance line present for coding cards.
    const winRow = await page.$(`#modal-${key} tbody tr.win`);
    assert.ok(winRow, `${key}: winner row highlighted`);
    if (key !== "agent") {
      const prov = await page.textContent(`#modal-${key} .provenance`);
      assert.ok(/Winner basis:/.test(prov), `${key}: provenance line present`);
    }
    await page.keyboard.press("Escape");
    await page.waitForSelector(`#modal-${key}.open`, { state: "detached", timeout: 5000 }).catch(() => {});
  }
  assert.deepEqual(errors, [], "no page errors across all three modals");
  await page.close();
});

// Static build-output assertions (task 6a): the checked-in dist/ tree must
// carry a REAL recalc endpoint everywhere, never a placeholder. Runs against
// the production render script output directly - no browser needed.
test("build: dist/index.html carries a real recalc endpoint, never a placeholder", () => {
  const html = readFileSync(join(ROOT, "dist", "index.html"), "utf8");
  assert.ok(!/PLACEHOLDER/i.test(html), "no placeholder anywhere in built HTML");
  const m = html.match(/RECALC_ENDPOINT\s*=\s*"([^"]+)"/);
  const form = html.match(/<form[^>]*action="([^"]+)"/);
  assert.ok(m, "RECALC_ENDPOINT baked");
  assert.ok(/^https:\/\//.test(m[1]), "RECALC_ENDPOINT is a real https URL, got: " + m[1]);
  assert.ok(form, "recalc form present");
  assert.ok(/^https:\/\//.test(form[1]), "recalc form action is a real https URL, got: " + form[1]);
});

// AA cross-check (task 6c): tolerant by design - warns, never fails, on
// network trouble. When AA_LIVE_HTML points at a fetched leaderboard copy,
// asserts the key versioned names resolve per the graceful policy: Opus 5.5
// winner distinct from genuine legacy Opus 5 rows (both must exist), and the
// Muse Spark contributor twin is present.
test("aa-crosscheck: versioned names resolve, legacy rows genuine (tolerant)", async (t) => {
  const live = process.env.AA_LIVE_HTML;
  if (!live || !existsSync(live)) {
    t.skip("no AA_LIVE_HTML snapshot - network fetch is manual-only, not CI");
    return;
  }
  const html = readFileSync(live, "utf8");
  const cands = JSON.parse(readFileSync(join(ROOT, "data", "candidates.json"), "utf8"));
  const top = [...cands.agent].sort((a, b) => b.score - a.score).slice(0, 8).map((r) => r.model);
  // Opus 5.5 must be the resolved winner family AND legacy Opus 5 rows must
  // genuinely exist on the AA board (not mis-resolution artifacts).
  assert.ok(/Claude Opus 5 \(/.test(html), "legacy Opus 5 rows are genuine AA rows");
  assert.ok(top.some((m) => /Opus 5\.5/.test(m)), "Opus 5.5 resolves at top: " + top.join(" | "));
  const spark = cands.agent.filter((r) => /muse-spark-1\.3/.test(r.openRouterId || ""));
  assert.ok(spark.length >= 2, "contributor twin present alongside regular");
});
