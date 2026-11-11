// api/picks.mjs - bot endpoint, deployed by Vercel as a serverless function at
// /api/picks. Same params + same calculation module (lib/calc.mjs) as the page.
//   200 -> picks JSON (see /docs#api)
//   400 -> { error, errors:[{param, problem}], docs, example } for no/invalid params
// Data is data/models.json bundled with the function (vercel.json includeFiles),
// so the function always serves the data of its own deployment.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSettings, picksResponse, errorResponse } from "../lib/calc.mjs";

let cached = null;
function loadData() {
  if (!cached) cached = JSON.parse(readFileSync(join(process.cwd(), "data", "models.json"), "utf8"));
  return cached;
}

// Pure core (unit-tested): url string + data -> { status, body }.
export function handle(urlString, data) {
  const url = new URL(urlString, "https://usethismodel.vercel.app");
  const parsed = parseSettings(url.searchParams);
  if (!parsed.ok) return { status: 400, body: errorResponse(parsed.errors) };
  return { status: 200, body: picksResponse(data, parsed.settings, `${url.origin}/`) };
}

const HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  // Data changes once a day; let the CDN absorb bot traffic.
  "Cache-Control": "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400",
};

export function GET(request) {
  let out;
  try { out = handle(request.url, loadData()); }
  catch (e) { out = { status: 500, body: { error: "server_error", message: String(e?.message || e) } }; }
  const headers = out.status === 200 ? HEADERS : { ...HEADERS, "Cache-Control": "no-store" };
  return new Response(JSON.stringify(out.body, null, 2) + "\n", { status: out.status, headers });
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS" } });
}
