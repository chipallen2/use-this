# Contributing to USE THIS

Thanks for helping. USE THIS picks today's best AI model for chatting, coding, and crazy-hard coding. It is a static site rendered weekly by GitHub Actions (scraper + render, no LLM calls).

## Local setup

Requires Node 20 or later.

```sh
npm install
npx playwright install chromium
npm run scrape   # writes data/picks.json + data/candidates.json
npm run render   # writes dist/index.html
npm test         # node:test suite (includes the Playwright e2e cases)
```

`npm run test:unit` runs the unit tests only. Set `RECALC_URL` when rendering for production; render refuses placeholder values.

## Pull requests

- Keep changes focused: one idea per PR.
- Run `npm test` before opening a PR. The test workflow runs the same suite on every PR.
- If leaderboard values changed, refresh source snapshots and pinned assertions together; see `tests/fixtures/README.md`.
- Do not change the coding source policy (50% AA Coding Agent Index + 50% Design Arena Frontend) without discussion in an issue first.
- Never commit secrets, API keys, or `.env` files. Only environment variable names and secret references belong in the repo.

## Reporting a problem

Open an issue with what you expected, what happened, and how to reproduce it. For a wrong model pick, include the date shown on the site and the source leaderboard value you compared against.

## License

By contributing, you agree your contributions are licensed under the MIT License in `LICENSE`.
