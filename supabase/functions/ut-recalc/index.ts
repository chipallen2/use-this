// supabase/functions/ut-recalc/index.ts
// Deno Edge Function: thin HTTP+CORS adapter over handler.mjs (pure logic).
// Public requests cannot dispatch workflows. Only authenticated completion/failure
// callbacks can mutate state. Requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// and UT_COMPLETE_TOKEN. Remove the old GITHUB_TOKEN secret after deployment.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.106.0";
import { createHandler } from "./handler.mjs";

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
  const h = createHandler({
    manualOnly: true,
    db,
    completeToken: Deno.env.get("UT_COMPLETE_TOKEN") ?? "",
  });
  const out = await h.route(body);
  return json(out.json, out.http);
});
