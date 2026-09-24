// supabase/functions/ut-recalc/index.ts
// Deno Edge Function: thin HTTP+CORS adapter over handler.mjs (pure logic).
// Same handler for: human button, imperative WebMCP recalculate_picks,
// declarative form tool, pg_cron weekly tick, scheduled-workflow claim.
// Requires env: GITHUB_TOKEN (repo scope on chipallen2/use-this),
// SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, UT_COMPLETE_TOKEN.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.106.0";
import { createHandler } from "./handler.mjs";

const GITHUB_OWNER = "chipallen2";
const GITHUB_REPO = "use-this";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (req.method !== "POST") {
    return json({ status: "error", code: "method", error: "POST only" }, 405);
  }

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );
  // Minimal RPC-shaped db over supabase-js: same contract as the SQL
  // migration (ut_claim_recalc / ut_complete_recalc / ut_fail_recalc).
  // DB failures throw -> handler.mjs maps them to truthful 5xx errors,
  // never fabricated fresh/in-progress/success.
  const db = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      const { data, error } = await supabase.rpc(name, args);
      if (error) throw new Error(error.message);
      return data as Record<string, unknown>;
    },
  };
  // GitHub dispatch carries the lease claim as a workflow input, so the
  // scheduled workflow can echo it back in complete/fail callbacks -
  // ownership proof that a stale worker can never forge.
  const dispatch = async ({ claim }: { claim: string }) => {
    const r = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/weekly.yml/dispatches`,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${Deno.env.get("GITHUB_TOKEN") ?? ""}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({ ref: "main", inputs: { ut_claim: claim } }),
      },
    );
    const text = await r.text().catch(() => "");
    return { ok: r.ok, status: r.status, body: text };
  };

  const h = createHandler({
    db,
    dispatch,
    completeToken: Deno.env.get("UT_COMPLETE_TOKEN") ?? "",
  });
  const out = await h.route(body);
  return json(out.json, out.http);
});
