# tests/fixtures/ - source-grounded test snapshots (2026-10-16)

Independently fetched source copies. Tests in e2e.test.mjs assert pool
rows match these SOURCE values - not just local candidates.json.

| File | Source | Fetch | Key values |
|---|---|---|---|
| deepswe-2026-10-16.html | https://deepswe.datacurve.ai/ | scrape.do L1 | claude-opus-5 [max] pass_rate 0.7364864864864865, displayed 74% ± 4% |
| design-arena-2026-10-16.json | POST https://www.designarena.ai/api/leaderboard (agon_webapps) | direct curl | claude-opus-5 Elo 1259, battles 1730; NO claude-opus-5.5 row |
| aa-models-2026-10-16.html | https://artificialanalysis.ai/leaderboards/models (Intelligence Index, chat board) | scrape.do L1 | Opus 5.5 (max) 58 @ $5.98; legacy Opus 5 deprecated:true, NOT on current board |

## Refresh

```sh
TOKEN=$(security find-generic-password -s scrape-do-token -w)
# DeepSWE (scrape.do L1 only - never L4 without Chip's permission)
curl -s --max-time 90 --location \
  "https://api.scrape.do/?token=${TOKEN}&url=https%3A%2F%2Fdeepswe.datacurve.ai%2F&geoCode=us" \
  -o tests/fixtures/deepswe-YYYY-MM-DD.html
# Design Arena (public JSON API, direct)
curl -s --max-time 60 -X POST -H 'Content-Type: application/json' \
  -d '{"arenaType":"agents","category":"agon_webapps","variationName":"public","inputModality":"text"}' \
  "https://www.designarena.ai/api/leaderboard" \
  -o tests/fixtures/design-arena-YYYY-MM-DD.json
# AA models board (scrape.do L1 only)
curl -s --max-time 90 --location \
  "https://api.scrape.do/?token=${TOKEN}&url=https%3A%2F%2Fartificialanalysis.ai%2Fleaderboards%2Fmodels&geoCode=us" \
  -o tests/fixtures/aa-models-YYYY-MM-DD.html
```

Then rename the fixture filenames in e2e.test.mjs (parse*Fixture fns)
and carry the new pinned values into the FIX_* constants. Fixtures are
snapshots - tests pin the fetch-date values, they never hit the network.
