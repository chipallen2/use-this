# Contributing

Bug reports, documentation fixes, benchmark-source updates, and code changes
are welcome. Open an issue to discuss larger changes before investing much work.

## Make a change

1. Fork this repository and clone your fork.
2. Create a branch from `main`.
3. Use Node.js 20 or later, then run `npm ci` and
   `npx playwright install chromium`.
4. Make a focused change (read [AGENTS.md](AGENTS.md): v1 URL settings are a
   frozen contract). Use `npm run render` to rebuild from checked-in data and
   `npm run serve` to try it; `npm run scrape` fetches live sources and changes
   `data/models.json`.
5. Run `npm test`. For changes to benchmark parsing, refresh matching fixtures
   and assertions together; see `tests/fixtures/README.md`.
6. Push your branch to your fork and open a PR against `chipallen2/use-this:main`.
   Explain the problem, what changed, and how you checked it. Include screenshots
   for visible changes.

PRs do not automatically run CI or deploy. Maintainers review and test changes
before merging. Resolve review conversations and keep generated files related
to your change. Never include tokens, `.env` files, or production credentials.

You do not need production credentials to contribute. The daily data refresh
and production deploys are maintainer-only.
Treat other contributors respectfully and keep discussion focused on the work.

## License status

A project license has not yet been selected. Contributions are welcome, but
public visibility alone is not a license to reuse the project. Maintainers must
resolve licensing before presenting the project as licensed open source.
