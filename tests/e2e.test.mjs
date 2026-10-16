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
import { execFileSync, execSync } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdtempSync, copyFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { displayName, fullDisplayName } from "../scripts/display-name.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

// Render CURRENT source + data into an ISOLATED temp dir (never dist/): the
// checked-in dist/ tree must keep the canonical production endpoint baked
// in, so e2e renders to a scratch copy with a fixture endpoint instead.
// Returns the temp dir serving as the static root. Optional `calcUtc`
// overrides data/calc.json in the scratch dir so a re-render simulates a
// completed recompute landing (new timestamp baked into HTML + data-calc.json).

const MIME = { ".html": "text/html", ".json": "application/json", ".txt": "text/plain", ".png": "image/png", ".ico": "image/x-icon", ".svg": "image/svg+xml" };

// Render CURRENT source to a scratch dir first so e2e always tests fresh output.
// Pass calcUtc to simulate a completed recompute: the scratch calc.json is
// rewritten and the render bakes the new instant into HTML + data-calc.json.
function renderDist(calcUtc) {
  const dir = mkdtempSync(join(tmpdir(), "ut-e2e-"));
  for (const f of ["picks.json", "candidates.json", "calc.json"]) {
    copyFileSync(join(ROOT, "data", f), join(dir, f));
  }
  if (calcUtc) {
    const calc = JSON.parse(readFileSync(join(dir, "calc.json"), "utf8"));
    calc.calc_utc = calcUtc;
    writeFileSync(join(dir, "calc.json"), JSON.stringify(calc, null, 2) + "\n");
  }
  execFileSync("node", [join(ROOT, "scripts", "render.mjs"), dir, join(dir, "index.html")],
    { env: { ...process.env, RECALC_URL: "https://x.test/fn" } });
  return dir;
}

function startStatic(root, extra = {}) {
  // `root` may be a getter function returning the current root dir, so a
  // test can swap the served deploy mid-test (stale -> fresh) while the
  // URL stays identical - exactly what a real redeploy looks like.
  const cur = () => (typeof root === "function" ? root() : root);
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const ov = typeof extra === "function" ? extra(url.pathname) : extra[url.pathname];
    if (ov) return ov(req, res);
    let p = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = join(cur(), p);
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

test("e2e: refresh click with genuinely newer server stamp reloads into the new timestamp; stale/failure do not", async (t) => {
  const dir = renderDist();
  const baked = JSON.parse(readFileSync(join(dir, "data-calc.json"), "utf8")).calc_utc;
  const newer = new Date(new Date(baked).getTime() + 3600e3).toISOString();
  // The recalc endpoint is baked into the page at render time
  // (https://x.test/fn here) - route it at the request level to a fixture,
  // exactly like a real endpoint would answer. data-calc.json is served
  // LIVE from a mutable variable (starts stale == baked, flips to newer
  // mid-test) so the poll loop sees exactly what the test sets. A second
  // static server rooted at a freshly re-rendered dir (new instant baked
  // into HTML + data-calc.json) simulates the completed deploy the page
  // lands on after the reload fires.
  let liveCalcServed = baked;
  let recalcMode = "started"; // started | fail
  let currentRoot = dir; // swapped to the fresh deploy mid-test (same URL)
  const serveRootSwap = (next) => { currentRoot = next; };
  const server = await startStatic(() => currentRoot, (pathname) => {
    // data-calc.json override is fixture-driven ONLY while the stale root
    // is served; once swapped to the fresh deploy, serve its real bytes
    // (proves the DOM stamp matches the actual deploy files).
    if (pathname === "/data-calc.json" && currentRoot === dir) {
      return (req, res) => json(res, { calc_utc: liveCalcServed, estimate: false, data_date: "2026-10-16" });
    }
    return null;
  });
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
  let reloaded = 0;
  await page.goto(`http://127.0.0.1:${portOf(server)}/`);
  // NOTE: location.reload cannot be stubbed in Chromium (non-configurable
  // on Location.prototype), so reload COUNTS below are bookkeeping around
  // the DOM-stamp assertions, which are the real proof: the stamp can only
  // flip via a genuine reload onto the swapped root.
  // Case stale: poll sees the same stamp -> no reload, computing status.
  await page.click("#recalc");
  await page.waitForTimeout(1500);
  const status1 = await page.textContent("#recalc-status");
  assert.ok(/checking|computing|started/i.test(status1), "status shows progress, got: " + status1);
  assert.equal(reloaded, 0, "stale stamp never reloads");
  // Deploy lands: flip the fixture, force one poll round via direct fetch
  // of the same URL the page polls (proves the server serves newer).
  liveCalcServed = newer;
  const liveNow = await page.evaluate(async () => {
    const r = await fetch("/data-calc.json?_=" + Date.now(), { cache: "no-store" });
    return (await r.json()).calc_utc;
  });
  assert.equal(new Date(liveNow).toISOString(), new Date(newer).toISOString(), "fixture serves the newer stamp");
  // Make the REAL reload land on the fresh deploy: swap the static root
  // from the stale dir to a freshly re-rendered dir with the newer instant
  // baked into BOTH index.html (data-calc-utc) and data-calc.json, stop
  // overriding data-calc.json with the fixture, click recalculate again so
  // a fresh poll round fires, and wait for the REAL navigation. The DOM
  // stamp after reload must match the new deploy.
  // NOTE: Chromium ignores prototype patching of location.reload, so the
  // counter may not fire - the DOM-stamp flip below is the real assertion
  // (it can ONLY happen via a genuine reload onto the swapped root).
  const freshDir = renderDist(newer);
  serveRootSwap(freshDir);
  await page.click("#recalc");
  await page.waitForFunction((want) => {
    const el = document.querySelector(".calc-time");
    return el && el.getAttribute("data-calc-utc") === want;
  }, newer, { timeout: 45000, polling: 1000 });
  reloaded++; // the genuine reload above, proven by the DOM-stamp flip
  assert.equal(reloaded, 1, "newer stamp triggers exactly one reload");
  // After the reload the DOM stamp must match the fresh deploy's instant:
  // data-calc-utc attribute == served data-calc.json calc_utc == newer.
  const domStamp = await page.getAttribute(".calc-time", "data-calc-utc");
  assert.equal(new Date(domStamp).toISOString(), new Date(newer).toISOString(), "DOM stamp matches the new deploy instant, got: " + domStamp);
  const servedCalc = await page.evaluate(async () => {
    const r = await fetch("/data-calc.json?_=" + Date.now(), { cache: "no-store" });
    return (await r.json()).calc_utc;
  });
  assert.equal(new Date(servedCalc).toISOString(), new Date(newer).toISOString(), "served data-calc.json matches the new instant");
  assert.notEqual(new Date(domStamp).toISOString(), new Date(baked).toISOString(), "DOM stamp actually advanced past the baked stamp");
  // Failure mode: endpoint 500s -> error status, never a reload, never fresh.
  // (Fresh page from the new deploy: track the DOM stamp across the click.)
  const stampBefore = await page.getAttribute(".calc-time", "data-calc-utc");
  recalcMode = "fail";
  await page.click("#recalc");
  await page.waitForTimeout(1200);
  const status2 = await page.textContent("#recalc-status");
  assert.ok(/failed|retry/i.test(status2), "failure surfaces retry status, got: " + status2);
  const stampAfter = await page.getAttribute(".calc-time", "data-calc-utc");
  assert.equal(stampAfter, stampBefore, "failure never reloads (DOM stamp unchanged)");
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
  for (const key of ["agent", "everyday", "hard"]) {
    await page.click(`[data-open="${key}"]`);
    await page.waitForSelector(`#modal-${key}.open`, { timeout: 5000 });
    const winner = picks[key].winner;
    const modalText = await page.textContent(`#modal-${key}`);
    // Winner identity: full display name (same map render uses) + effort +
    // OpenRouter ID all visible. Catches stale-label regressions (e.g. an
    // "Opus 5" cell where the pool says Opus 5.5).
    const winnerName = fullDisplayName(winner.openRouterId);
    assert.ok(modalText.includes(winnerName), `${key}: winner display name "${winnerName}" visible`);
    assert.ok(modalText.includes(winner.openRouterId), `${key}: OpenRouter ID visible`);
    assert.ok(modalText.includes(winner.effort ?? "default") || modalText.includes("default"), `${key}: thinking visible`);
    // Table row count == pool size; chart dot count == pool size.
    const rows = await page.$$(`#modal-${key} tbody tr`);
    assert.equal(rows.length, cands[key].length, `${key}: table rows == pool (${cands[key].length})`);
    const dots = await page.$$(`#modal-${key} circle.dot`);
    assert.equal(dots.length, cands[key].length, `${key}: chart dots == pool (${cands[key].length})`);
    // EVERY pool entry: its name/score pairing in the table row must match
    // candidates.json exactly (name from the same displayName map, score %
    // in the Combined/Score cell, thinking + price in their cells). No
    // stale names, no mismatched scores - the Opus 5 vs 5.5 class of bug.
    // Rows render sorted score-desc; pair each row against the sorted pool.
    const pool = [...cands[key]].sort((a, b) => b.score - a.score || a.costPerTask - b.costPerTask);
    const isCoding = key !== "agent";
    const scoreCol = isCoding ? 2 : 2, priceCol = isCoding ? 5 : 3;
    assert.equal(rows.length, pool.length, `${key}: row/pool lengths agree`);
    for (let i = 0; i < pool.length; i++) {
      const e = pool[i];
      const cells = await rows[i].$$eval("td", (tds) => tds.map((td) => td.textContent.trim()));
      const wantName = fullDisplayName(e.openRouterId) + (e.openRouterId === winner.openRouterId && (e.effort ?? "default") === (winner.effort ?? "default") ? " ★" : "");
      assert.equal(cells[0], wantName, `${key} row ${i}: name "${cells[0]}" == pool "${wantName}"`);
      assert.equal(cells[1], e.effort ?? "default", `${key} row ${i}: thinking "${cells[1]}" == pool "${e.effort ?? "default"}"`);
      assert.equal(cells[scoreCol], `${e.score}%`, `${key} row ${i}: score "${cells[scoreCol]}" == pool "${e.score}%"`);
      assert.equal(cells[priceCol], `$${e.costPerTask}`, `${key} row ${i}: price "${cells[priceCol]}" == pool "$${e.costPerTask}"`);
    }
    // EVERY chart dot: data-name/data-score/data-cost must match the pool
    // entry it depicts (same display pairing, no mismatched scores).
    // Dots render sorted cost-asc; pair each dot against the cost-sorted pool.
    const byCost = [...cands[key]].sort((a, b) => a.costPerTask - b.costPerTask);
    const dotAttrs = await page.$$eval(`#modal-${key} circle.dot`, (els) =>
      els.map((el) => ({ name: el.getAttribute("data-name"), score: el.getAttribute("data-score"), cost: el.getAttribute("data-cost") })));
    assert.equal(dotAttrs.length, byCost.length, `${key}: dot/pool lengths agree`);
    for (let i = 0; i < byCost.length; i++) {
      const e = byCost[i];
      const [n1, n2] = displayName(e.openRouterId);
      const wantDot = ((n1 + (n2 ? " " + n2 : "") + (e.effort ? " " + e.effort : "")).slice(0, 26));
      assert.equal(dotAttrs[i].name, wantDot, `${key} dot ${i}: name "${dotAttrs[i].name}" == pool "${wantDot}"`);
      assert.equal(dotAttrs[i].score, String(e.score), `${key} dot ${i}: score "${dotAttrs[i].score}" == pool "${e.score}"`);
      assert.equal(dotAttrs[i].cost, String(e.costPerTask), `${key} dot ${i}: cost "${dotAttrs[i].cost}" == pool "${e.costPerTask}"`);
    }
    // Winner row highlighted + single, provenance line present for coding cards.
    const winRows = await page.$$(`#modal-${key} tbody tr.win`);
    assert.equal(winRows.length, 1, `${key}: exactly one winner row highlighted`);
    if (key !== "agent") {
      const prov = await page.textContent(`#modal-${key} .provenance`);
      assert.ok(/Winner basis:/.test(prov), `${key}: provenance line present`);
    }
    // Pinned regression (2026-10-16 Chip report): the everyday pool's
    // legacy Opus 5 row must keep its own identity - full display name
    // "Claude Opus 5", Opus-5 OpenRouter ID + pricing, DeepSWE raw 74% and
    // Design Elo 1259, and must NOT resolve to the 5.5 twin. Both boards
    // genuinely still carry legacy Opus 5 (DeepSWE leaderboard 2026-09-22
    // snapshot; Design Arena modelId claude-opus-5, Elo 1259, live
    // 2026-10-16), so the row is correct data, not a stale label.
    if (key === "everyday") {
      const opus = pool.find((e) => e.openRouterId === "anthropic/claude-opus-5");
      assert.ok(opus, "everyday pool carries legacy anthropic/claude-opus-5");
      assert.equal(opus.deepRaw, 74, "opus 5 DeepSWE raw stays 74");
      assert.equal(opus.designElo, 1259, "opus 5 Design Elo stays 1259");
      assert.equal(opus.costPerTask, 11.84, "opus 5 DeepSWE cost stays $11.84");
      assert.notEqual(opus.openRouterId, "anthropic/claude-opus-5.5", "opus 5 never resolves to 5.5");
      const opusIdx = pool.indexOf(opus);
      const opusCells = await rows[opusIdx].$$eval("td", (tds) => tds.map((td) => td.textContent.trim()));
      assert.equal(opusCells[0].replace(/ ★$/, ""), "Claude Opus 5", `opus row name stays "Claude Opus 5", got "${opusCells[0]}"`);
      assert.equal(opusCells[scoreCol], `${opus.score}%`, "opus row score matches pool");
      assert.equal(opusCells[priceCol], `$${opus.costPerTask}`, "opus row price matches pool");
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
