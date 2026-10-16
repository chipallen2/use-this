// scripts/ci/ut-verify.mjs
// Bounded deployment-propagation verification for weekly.yml.
// Fetches the canonical data-calc.json from production with cache-busting
// + retries, normalizes both timestamps to ISO instants, and compares.
// A placeholder baked endpoint fails LOUDLY (never passes). Exits 0 on
// match, 1 on mismatch/exhausted retries. Pure + unit-tested.
//
// Usage: node scripts/ci/ut-verify.mjs [live-url] [expected-calc-utc]
//   env MAX_ATTEMPTS (default 12), RETRY_MS (default 30000)

import { pathToFileURL } from "node:url";

export const LIVE_DEFAULT = "https://usethismodel.vercel.app/data-calc.json";
export const PLACEHOLDER_RE = /PLACEHOLDER/i;

export function normalizeUtc(raw) {
  const ms = typeof raw === "string" ? Date.parse(raw) : NaN;
  if (Number.isNaN(ms)) throw new Error("unparseable timestamp: " + String(raw).slice(0, 120));
  return new Date(ms).toISOString();
}

export function looksLikePlaceholder(s) {
  return typeof s === "string" && PLACEHOLDER_RE.test(s);
}

// Single verification round against an injected fetcher (test seam).
// fetcher(url) -> { calc_utc }. Throws on transport/parse failure.
export async function verifyOnce({ fetcher, liveUrl, expectedUtc, nonce }) {
  if (looksLikePlaceholder(liveUrl)) throw new Error("refusing to verify a placeholder URL");
  const url = liveUrl + (liveUrl.includes("?") ? "&" : "?") + "_=" + nonce;
  const body = await fetcher(url);
  const raw = body && body.calc_utc;
  if (typeof raw !== "string") throw new Error("live data-calc.json has no calc_utc string");
  const live = normalizeUtc(raw);
  const want = normalizeUtc(expectedUtc);
  return { match: live === want, live, want };
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function verifyWithRetries({
  fetcher,
  liveUrl = LIVE_DEFAULT,
  expectedUtc,
  maxAttempts = Number(process.env.MAX_ATTEMPTS ?? 12),
  retryMs = Number(process.env.RETRY_MS ?? 30000),
  onAttempt = () => {},
}) {
  if (!expectedUtc) throw new Error("expected calc_utc is required");
  const want = normalizeUtc(expectedUtc); // fail fast on a bad local stamp
  let last = null;
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      const r = await verifyOnce({ fetcher, liveUrl, expectedUtc: want, nonce: `${Date.now()}-${i}` });
      onAttempt(i, r);
      if (r.match) return { ok: true, attempts: i, live: r.live, want: r.want };
      last = r;
    } catch (e) {
      last = { error: e.message };
      onAttempt(i, last);
    }
    if (i < maxAttempts) await sleep(retryMs);
  }
  return { ok: false, attempts: maxAttempts, last, want };
}

const invokedDirectly =
  process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const liveUrl = process.argv[2] ?? LIVE_DEFAULT;
  const expectedUtc = process.argv[3] ?? process.env.CALC_UTC;
  const fetcher = async (url) => {
    const r = await fetch(url, { cache: "no-store", headers: { "Cache-Control": "no-cache" } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  };
  verifyWithRetries({ fetcher, liveUrl, expectedUtc, onAttempt: (i, r) => console.log(`attempt ${i}:`, JSON.stringify(r)) })
    .then((res) => {
      if (res.ok) {
        console.log(`canonical calc timestamp verified live: ${res.live} (${res.attempts} attempt(s))`);
      } else {
        console.error(`canonical timestamp NOT live after ${res.attempts} attempts:`, JSON.stringify(res.last));
        process.exit(1);
      }
    })
    .catch((e) => { console.error("VERIFY STEP FAILED:", e.message); process.exit(1); });
}
