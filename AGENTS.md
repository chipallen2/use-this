# AGENTS.md - Use This Model

Rules for AI agents (and humans) that **use** or **contribute to** Use This Model.
Generic on purpose: copy it into your own repo's agent rules and change the
settings URL to your team's.

## What it is

A stateless site that answers "which AI model should I use?" for three jobs:

| Category key | Card | Meant for |
|---|---|---|
| `chat` | Chatting | everyday questions, writing, analysis |
| `code` | Everyday Coding | normal coding work |
| `crazy` | Crazy Hard Coding | the hardest coding tasks |

For each category the pick is the **cheapest model (by input $/1M tokens) whose
combined 0-100 score is at least `<cat>_min` and whose input price is at most
`<cat>_max`**. All settings are URL query params; there is no database. Data
(benchmark scores + OpenRouter prices) refreshes daily.

## Calling it (bots / agents)

Use the JSON endpoint, never scrape the HTML:

```sh
curl 'https://usethismodel.vercel.app/api/picks?chat=eci&chat_max=1&chat_min=65&code=eci&code_max=3&code_min=80&crazy=eci&crazy_max=15&crazy_min=95'
```

- Same params as the page, same calculation code (`lib/calc.mjs`), same picks.
- Read `categories.<chat|code|crazy>.model.id` - an OpenRouter model id you can
  pass straight to OpenRouter (or map to your provider).
- `status` is `ok`, `no-model-qualifies` (model is `null`; loosen settings),
  `locked`, or `locked-model-not-in-data`.
- HTTP 400 = missing/invalid settings; the body lists each bad `param` and links
  the docs. Fix the params, do not retry blindly.
- Responses are CDN-cached for up to an hour; data changes once a day. Do not poll.
- Prices are **input** USD per 1M tokens. Real cost also depends on output
  tokens; `output_usd_per_1m` is included for reference.
- Raw data for custom math: `/models.json`. Full param reference: `/docs`.

If your organization has a standard settings link, always use that link's
params rather than inventing your own. Locked links (`<cat>_lock=<model id>`)
mean "use exactly this model"; respect them.

## Settings (v1, frozen)

`<cat>=key[:weight],...` · `<cat>_max` · `<cat>_min` · `<cat>_miss=exclude|reweight|zero`
· `<cat>_cov` (reweight only) · `<cat>_lock` · optional `v=1`. Benchmark keys:
`eci, aai, aac, da, vibe, vcb, swe`. Details: https://usethismodel.vercel.app/docs

## Contributing

1. Fork, branch from `main`, Node 20+, `npm ci && npx playwright install chromium`.
2. **Never break v1 URLs.** Param names, benchmark keys, defaults for omitted
   optional params (`miss=exclude`, `v=1`) and the normalization method are a
   contract with links saved in other companies' shorteners. A breaking change
   ships as `v=2` with v1 parsing kept intact.
3. All pick math lives in `lib/calc.mjs`. The browser and `api/picks.mjs` must
   both import it unchanged; never duplicate scoring logic elsewhere.
4. New benchmark: add a fetcher in `scripts/scrape.mjs`, a registry entry in
   `BENCHMARKS` (new, never-reused key), a fixture under `tests/fixtures/`, and
   parser tests. Names map to OpenRouter ids only through `MODEL_ALIASES`
   (version-gated, no fuzzy matching); unmatched names are dropped and logged.
5. A published model must have an input price. Never default a missing price
   to 0 or estimate it; the refresh must fail instead.
6. Run `npm test` (unit + migration + Playwright). Include screenshots for UI
   changes. Do not commit credentials, `.env` files, or production tokens.
7. No database. If something truly needs storage, propose it in an issue first;
   any shared-infra objects must use the `utm_` prefix.
8. Open the PR against `chipallen2/use-this:main`. PRs do not auto-deploy.
