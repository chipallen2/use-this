# USE THIS

"Today's best model for chatting, coding, and crazy-hard coding."

Static `dist/index.html` rendered weekly by GitHub Actions (scraper: AA Coding Agent Index + Design Arena Frontend + AA
Intelligence Index + OpenRouter catalog, no LLM calls). The "Recalculate for
today" button hits a Supabase edge function that triggers a recompute unless
the last calc is under 12h old.

## Local

```sh
npm install
npx playwright install chromium
npm run scrape   # writes data/picks.json + data/candidates.json
npm run render   # writes dist/index.html (render-only: never moves the calc stamp)
npm test         # node:test suite: guard, lease, callbacks, workflow claim/stage/verify, frontend (incl. real human submit + polling + get_picks + schema validation), render, real-SQL PGlite
npm run test:e2e # 2 Playwright browser cases plus 2 build/source checks
```

Set `RECALC_URL` env when rendering for production (Supabase recalc endpoint).
Without it, render bakes the canonical production endpoint
(`https://cmohqhotfywhmgikeatc.supabase.co/functions/v1/ut-recalc`) - a
missing env can never produce a placeholder. Any placeholder-looking value
refuses to render (exit 1) so a broken endpoint can never deploy.

## Coding source policy (2026-10-16)

Coding = 50% AA Coding Agent Index + 50% Design Arena Frontend, each min-max
normalized to 0-100. A model with only one signal uses that signal at 100%.
AA URL: https://artificialanalysis.ai/agents/coding-agents. The agent index
measures a named harness/configuration, not just bare model weights. AA
already includes DeepSWE v1.1 as one of three components; the standalone
DeepSWE fetch and blend implementation are retained in DEEPSWE_DISABLED
comments but are never called. Frontend is the agon_webapps board, not Fullstack.

Unknown model names remain NEW entries, never fuzzy-matched to an older
version. Multi-model agent runs are excluded with a log because they cannot
be attributed to one model. Missing AA task costs stay null, appear as N/A
in the table, do not appear in price charts, and cannot win. Scores are
never borrowed from neighboring rows when costs are unavailable.

Source snapshots and pinned assertions must be refreshed together when
leaderboard values change; see tests/fixtures/README.md.

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

- GitHub: `chipallen2/use-this`
- Vercel: auto-deploys `dist/` on push to main
- Supabase: `supabase/` - `ut_state` table + `ut-recalc` edge fn + weekly pg_cron
- Repo-local git identity is chipallen2 so Vercel builds deploy.
