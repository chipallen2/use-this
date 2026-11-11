# USE THIS

"Today's best model for chatting, coding, and crazy-hard coding."

Static `dist/index.html` built from public benchmarks: AA Coding Agent Index,
Design Arena Frontend, AA Intelligence Index, and the OpenRouter catalog.
The scraper makes no LLM calls.

Contributions are welcome: fork the repository, work on a branch, and open a
pull request against `main`. Anyone can open issues and PRs; only maintainers
can merge changes. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and review
expectations, and [SECURITY.md](SECURITY.md) for private vulnerability reports.

## Automation and costs

GitHub Actions is currently **disabled in the repository settings** while this
manual-only configuration is being rolled out. Opening a PR needs no workflow.
The workflow in this checkout has no push, PR, or scheduled triggers. It accepts
only an owner-triggered dispatch on `main` with the confirmation value `RUN`.
Legacy dispatches from the public recalculate endpoint do not satisfy that
confirmation and are rejected before a runner is allocated. The updated edge
function rejects public/cron recalculation requests entirely.

Vercel Git auto-deployments are disabled by `git.deploymentEnabled: false` in
`vercel.json`; explicit CLI deployments remain available. These local changes
have no effect on deployed services until pushed/deployed. Existing Supabase
cron jobs and hosting/storage usage are separate from GitHub Actions.

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

## Maintainer rollout (before re-enabling Actions)

1. Review and push these changes to `main` yourself. Repository administrators
   retain the default branch-protection bypass; external contributors use PRs.
2. Deploy the updated `ut-recalc` function with `supabase functions deploy
   ut-recalc`. Its public recalculate endpoint will return a maintainer-only
   error; completion/failure callbacks still require `UT_COMPLETE_TOKEN`.
   Remove the edge function's old `GITHUB_TOKEN` secret after deployment.
3. In Supabase, disable the existing `ut-weekly-recalc` pg_cron job. The changed
   function refuses it, but disabling the job also avoids unnecessary requests.
4. In Vercel, verify Git auto-deployments are disabled for this project before
   accepting contributor changes. The checked-in Vercel configuration disables
   automatic branch deployments; dashboard/deploy-hook settings are separate.
5. The original lease migration must already be applied:
   `supabase/migrations/20260924_ut_recalc_lease.sql`. Required GitHub secrets:
   `SUPABASE_URL`, `UT_SUPABASE_SERVICE_KEY`, `UT_COMPLETE_TOKEN`, `RECALC_URL`,
   `VERCEL_TOKEN`, `VERCEL_PROJECT_ID`, and `VERCEL_ORG_ID`. The service key
   stays in Actions secrets, never browser code or contributor forks.
6. To preserve generated data in protected `main`, set `UT_REPO_WRITE_TOKEN`
   to an owner-issued fine-grained token scoped only to this repository with
   Contents read/write access. The owner must retain branch-protection bypass.
   The default `GITHUB_TOKEN` cannot bypass the PR requirement. Do not broaden
   the repository's default workflow permissions or enable bot PR approvals.
7. Only after the above is complete, re-enable Actions. Go to Actions →
   `weekly-recompute` → Run workflow, choose `main`, and type `RUN`.
   Each confirmed run may consume Actions resources and deploy to production.
   The existing one-hour freshness guard can still skip a run, and a live lease
   prevents concurrent recomputes.

The manual job claims a lease directly using Supabase's service-only RPC,
scrapes and renders, commits generated data, deploys through the Vercel CLI,
verifies the live calculation timestamp, then reports completion. Failed runs
release their owned lease; the two-hour TTL remains a backstop.

## Infra

- GitHub: `chipallen2/use-this`; public forks, issues, and PRs.
- Vercel: serves `dist/`; production deployment is explicitly requested.
- Supabase: state/lease RPCs and authenticated completion/failure callbacks.
- No project license has been selected yet. Public visibility by itself does
  not grant open-source reuse rights; add a license before advertising this
  as a licensed open-source project.
