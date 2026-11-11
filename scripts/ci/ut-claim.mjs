// Owner-triggered workflow: acquire the existing atomic lease directly.
// No call to the public edge function and no second workflow dispatch.
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { GUARD_MS, LEASE_TTL_MS } from "../../supabase/functions/ut-recalc/handler.mjs";

export const SKIP_EXACT = "1";
export function parseClaimResponse(text) {
  let response;
  try { response = JSON.parse(text); }
  catch { throw new Error("claim response is not JSON"); }
  if (!response || typeof response.status !== "string") throw new Error("claim response has no status string");
  return response;
}
export function decideClaim({ response }) {
  if (response.status === "fresh" || response.status === "in-progress") {
    return { skip: true, claim: null, status: response.status };
  }
  if (response.status === "started" && typeof response.claim === "string" && /^[A-Za-z0-9_-]+$/.test(response.claim)) {
    return { skip: false, claim: response.claim, status: response.status };
  }
  throw new Error("lease claim failed with status: " + response.status);
}
export async function main({ env = process.env, fetchFn = fetch, write = appendFileSync } = {}) {
  if (!env.GITHUB_ENV) throw new Error("GITHUB_ENV is empty");
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("Supabase workflow secrets are missing");
  const url = new URL("/rest/v1/rpc/ut_claim_recalc", env.SUPABASE_URL);
  if (url.protocol !== "https:") throw new Error("Supabase URL must use HTTPS");
  const result = await fetchFn(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({ p_now: Date.now(), p_claim: `c_${randomUUID()}`, p_guard_ms: GUARD_MS, p_ttl_ms: LEASE_TTL_MS }),
  });
  // Do not print response bodies or credentials into Actions logs.
  if (!result.ok) throw new Error(`claim RPC HTTP ${result.status}`);
  const decision = decideClaim({ response: parseClaimResponse(await result.text()) });
  write(env.GITHUB_ENV, decision.skip ? `UT_SKIP=${SKIP_EXACT}\n` : `UT_CLAIM=${decision.claim}\n`);
  console.log("lease status: " + decision.status);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch((error) => { console.error("CLAIM STEP FAILED:", error.message); process.exit(1); });
}
