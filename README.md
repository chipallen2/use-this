# USE THIS MODEL

Tells your team which AI model to use for **chatting**, **everyday coding** and
**crazy-hard coding**: the cheapest model that clears your score floor under
your price cap, using the benchmarks you trust.

Live: https://usethismodel.vercel.app - settings docs: https://usethismodel.vercel.app/docs

## How it works

- **Stateless.** Every setting lives in the URL query string (format `v=1`,
  documented at `/docs`). No database, no accounts. A link is the whole
  configuration: save it, share it, or put it behind your own short link.
- **No params = landing page** with a short explanation and a settings form
  prefilled with the recommended defaults (`lib/calc.mjs` `RECOMMENDED`).
- **Daily data refresh** (`scripts/scrape.mjs`, GitHub Action
  `.github/workflows/daily.yml`) fetches benchmark scores + OpenRouter prices,
  normalizes every benchmark to 0-100 (`scripts/models-data.mjs`) and publishes
  `data/models.json`. It fails loudly and publishes nothing if a required
  source is down or any model lacks an input price.
- **The browser computes picks** from the URL with `lib/calc.mjs`.
- **Bot endpoint** `GET /api/picks?<same params>` (Vercel function
  `api/picks.mjs`) runs the *same* module, so bots and the page always agree.
  No/invalid params return HTTP 400 JSON naming each bad setting.

Benchmarks: Epoch Capabilities Index (`eci`, Epoch AI, CC-BY 4.0), Artificial
Analysis Intelligence Index (`aai`), AA Coding Agent Index (`aac`), Design
Arena Frontend Elo (`da`), Vals AI Vibe Code / VCB / SWE-bench Multimodal
(`vibe`, `vcb`, `swe`). Price = OpenRouter input list price, USD per 1M tokens.

## Layout

| Path | What |
|---|---|
| `lib/calc.mjs` | Settings parser/serializer, scoring, picks, bot JSON. Pure, shared by browser + API + tests. |
| `scripts/scrape.mjs` | Daily refresh: fetch sources, match names to OpenRouter ids. |
| `scripts/models-data.mjs` | Normalization + price guard + `models.json` validation. |
| `scripts/render.mjs` | Builds `dist/` (app shell, `/docs`, `llms.txt`, copies `calc.mjs`, `app.mjs`, `models.json`). |
| `web/app.mjs` | Browser UI (landing form, cards, detail chart, Customize, Share, Share Locked Models). |
| `api/picks.mjs` | Bot endpoint (Vercel serverless function). |
| `tests/` | `node:test` unit tests + Playwright e2e against a local server (`tests/serve.mjs`). |

## Local

```sh
npm ci
npx playwright install chromium
npm run scrape   # live fetch -> data/models.json (needs network)
npm run render   # data/models.json -> dist/
npm run serve    # http://127.0.0.1:4173 (static dist + /api/picks)
npm test         # unit + migration + browser tests
```

## Agents

See [AGENTS.md](AGENTS.md) for how to call the bot endpoint and how to contribute.

## Infra

- GitHub: `chipallen2/use-this`; public forks, issues, and PRs.
- Vercel: serves `dist/` plus the `api/` function. Git auto-deploys are disabled
  in `vercel.json`; the daily workflow deploys explicitly with the Vercel CLI.
- Supabase: not used. `supabase/migrations/20261111_utm_drop_ut_recalc.sql`
  removes the old `ut_` recalc objects (maintainer runs it manually).
- No project license has been selected yet. Public visibility by itself does
  not grant reuse rights.
