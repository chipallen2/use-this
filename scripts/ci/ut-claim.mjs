// scripts/ci/ut-claim.mjs
// Claim-step logic for .github/workflows/weekly.yml (pure, tested).
//
// Two run shapes:
// - Edge-dispatched input-bearing run (inputs.ut_claim set): the edge fn
//   already owns the lease and passed the claim as a workflow input. Adopt
//   it directly; this run alone computes.
// - Schedule/manual no-claim run: our POST to the edge fn triggers the edge
//   dispatch of the input-bearing job. We then ALWAYS skip our own remaining
//   compute (no double compute), whatever non-error status came back.
//
// UT_SKIP must be exactly "1": the workflow compares env.UT_SKIP != '1',
// so any decorated value ("1 (reason)") silently fails the comparison and
// the no-op run would scrape+compute anyway.

import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Exact skip sentinel - must match the `env.UT_SKIP != '1'` comparisons.
export const SKIP_EXACT = "1";

// Parse the edge claim POST body. Throws on anything unrecognized: the
// caller fails loudly instead of computing blind on a malformed response.
export function parseClaimResponse(text) {
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error("claim response is not JSON: " + String(text).slice(0, 120));
  }
  if (!j || typeof j !== "object" || typeof j.status !== "string") {
    throw new Error("claim response has no status string");
  }
  return j;
}

// Decide what the wrapper run does next. Never returns "compute without a
// claim": schedule/manual runs always skip (the edge-dispatched,
// input-bearing job alone computes); dispatched runs adopt their input.
export function decideClaim({ hasClaimInput, claimInput, response }) {
  if (hasClaimInput) {
    if (typeof claimInput !== "string" || !claimInput) {
      throw new Error("ut_claim input present but empty");
    }
    return { skip: false, claim: claimInput, via: "dispatch-input" };
  }
  const st = response.status;
  if (st === "fresh" || st === "in-progress" || st === "started") {
    return {
      skip: true,
      claim: null,
      status: st,
      via: st === "started" ? "edge-dispatched" : st,
    };
  }
  throw new Error("lease claim failed with status: " + st);
}

function env(name) {
  return process.env[name] ?? "";
}

export async function main() {
  const claimInput = env("UT_CLAIM_INPUT");
  const envFile = env("GITHUB_ENV");
  if (!envFile) throw new Error("GITHUB_ENV is empty (not running under GitHub Actions?)");
  if (claimInput) {
    const d = decideClaim({ hasClaimInput: true, claimInput });
    appendFileSync(envFile, `UT_CLAIM=${d.claim}\n`);
    console.log("lease adopted from edge-fn dispatch input");
    return;
  }
  const url = env("RECALC_URL");
  if (!url) throw new Error("RECALC_URL is empty");
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
  } catch (e) {
    throw new Error("claim POST network failure: " + (e?.message ?? String(e)));
  }
  const text = await res.text();
  // Non-2xx: the edge never no-ops on error - fail loudly, never compute blind.
  if (!res.ok) throw new Error(`claim POST HTTP ${res.status}: ${text.slice(0, 200)}`);
  const body = parseClaimResponse(text);
  console.log("claim response status: " + body.status);
  const d = decideClaim({ hasClaimInput: false, response: body });
  appendFileSync(envFile, `UT_SKIP=${SKIP_EXACT}\n`);
  console.log(`no-claim wrapper run: edge already handled dispatch (saw ${d.status}); skipping own compute`);
}

const invokedDirectly =
  process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  await main().catch((e) => {
    console.error("CLAIM STEP FAILED:", e.message);
    process.exit(1);
  });
}
