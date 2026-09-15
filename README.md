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
npm run render   # writes dist/index.html
```

Set `RECALC_URL` env when rendering for production (Supabase recalc endpoint).

## Infra

- GitHub: `goferchip/use-this` (transfer to chipallen2 pending - see build notes)
- Vercel: auto-deploys `dist/` on push to main
- Supabase: `supabase/` - `ut_state` table + `ut-recalc` edge fn + weekly pg_cron
- Repo-local git identity is chipallen2 so Vercel builds deploy.
