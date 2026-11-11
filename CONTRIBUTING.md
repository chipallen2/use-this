# Contributing

Bug reports, documentation fixes, benchmark-source updates, and code changes
are welcome. Open an issue to discuss larger changes before investing much work.

## Make a change

1. Fork this repository and clone your fork.
2. Create a branch from `main`.
3. Use Node.js 20 or later, then run `npm ci` and
   `npx playwright install chromium`.
4. Make a focused change. Use `npm run render` to rebuild from checked-in data;
   `npm run scrape` fetches live benchmark sources and changes the data.
5. Run `npm test`. For changes to benchmark parsing, refresh matching fixtures
   and assertions together; see `tests/fixtures/README.md`.
6. Push your branch to your fork and open a PR against `chipallen2/use-this:main`.
   Explain the problem, what changed, and how you checked it. Include screenshots
   for visible changes.

PRs do not automatically run CI or deploy. Maintainers review and test changes
before merging. Resolve review conversations and keep generated files related
to your change. Never include tokens, `.env` files, or production credentials.

You do not need production credentials to contribute. Do not use the public
recalculate endpoint to test changes; production recomputation is maintainer-only.
Treat other contributors respectfully and keep discussion focused on the work.

## License status

A project license has not yet been selected. Contributions are welcome, but
public visibility alone is not a license to reuse the project. Maintainers must
resolve licensing before presenting the project as licensed open source.
