// supabase/functions/ut-recalc/index.ts
// Deno Edge Function. POST -> check public.ut_state.last_calc server-side.
// No-op ({ recalculated: false }) if last calc < 12h old, else dispatch the
// GitHub Actions recompute workflow and stamp last_calc.
// Requires env: GITHUB_TOKEN (repo scope on goferchip/use-this), SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.106.0";

const GITHUB_OWNER = "goferchip";
const GITHUB_REPO = "use-this";
const GUARD_MS = 12 * 60 * 60 * 1000;

serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST only" }), { status: 405 });
  }
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );
  const { data, error } = await supabase.from("ut_state").select("last_calc").eq("id", 1).single();
  if (error) {
    return new Response(JSON.stringify({ error: "ut_state read failed: " + error.message }), { status: 500 });
  }
  const lastCalc = new Date(data.last_calc).getTime();
  if (Date.now() - lastCalc < GUARD_MS) {
    return new Response(JSON.stringify({ recalculated: false, last_calc: data.last_calc }), {
      headers: { "Content-Type": "application/json" },
    });
  }
  const gh = await fetch(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/weekly.yml/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `token ${Deno.env.get("GITHUB_TOKEN")}`,
        Accept: "application/vnd.github.v3+json",
        "Content-Type": "application/json",
        "User-Agent": "UseThis/1.0",
      },
      body: JSON.stringify({ ref: "main" }),
    },
  );
  if (!gh.ok) {
    return new Response(JSON.stringify({ error: `workflow dispatch failed: ${gh.status}` }), { status: 502 });
  }
  await supabase.from("ut_state").update({ last_calc: new Date().toISOString() }).eq("id", 1);
  return new Response(JSON.stringify({ recalculated: true }), {
    headers: { "Content-Type": "application/json" },
  });
});
