# USE THIS

"Today's best model for chatting, coding, and crazy-hard coding."

Static `dist/index.html` rendered weekly by GitHub Actions (scraper: DeepSWE + AA
Intelligence Index + OpenRouter catalog, no LLM calls). The "Recalculate for
today" button hits a Supabase edge function that triggers a recompute unless
the last calc is under 12h old.

## Local

```sh
npm install
npx playwright install chromium
npm run scrape   # writes data/picks.json + data/candidates.json
npm run render   # writes dist/index.html (render-only: never moves the calc stamp)
npm test         # 38 node:test cases: guard, lease, callbacks, workflow claim/stage, frontend (incl. real human submit + get_picks + schema validation), render, real-SQL PGlite
```

Set `RECALC_URL` env when rendering for production (Supabase recalc endpoint).

## Deployment protocol (order matters)

1. `supabase/migrations/20260924_ut_recalc_lease.sql` - apply ONCE via
   dashboard SQL or `supabase db push` (adds lease columns + 3 RPCs,
   preserves all rows). Verify: no live lease
   (`recalc_in_progress_since` null) before Monday runs.
2. Set GH secrets: `RECALC_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
   (as `UT_SUPABASE_SERVICE_KEY`), `UT_COMPLETE_TOKEN`, `GITHUB_TOKEN`,
   `VERCEL_TOKEN`. Edge fn needs `GITHUB_TOKEN` + `UT_COMPLETE_TOKEN` too.
3. Deploy edge fn: `supabase functions deploy ut-recalc` (ships
   `index.ts` + `handler.mjs`). It is the ONLY writer of `last_calc`.
4. Merge this branch. The weekly workflow then self-orders: claim lease ->
   scrape+render -> commit+push -> deploy from repo root -> verify the
   canonical `data-calc.json` timestamp live -> completion callback stamps
   `last_calc`. Any failure releases the lease (2h TTL backstop).
5. Dedup later: pg_cron `ut-weekly-recalc` (12:05 UTC) and GH cron (12:00
   UTC) share the same edge-fn guard - first claim wins, the other no-ops.
   Keep both until verified, then drop one.

## Infra

- GitHub: `goferchip/use-this` (transfer to chipallen2 pending - see build notes)
- Vercel: auto-deploys `dist/` on push to main
- Supabase: `supabase/` - `ut_state` table + `ut-recalc` edge fn + weekly pg_cron
- Repo-local git identity is chipallen2 so Vercel builds deploy.
