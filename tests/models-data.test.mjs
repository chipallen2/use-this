// tests/models-data.test.mjs - data layer: normalization, price guard, ECI parse,
// and a validity check of the committed data/models.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildModelsData, normalizeBoard, validateModelsData, parseECICSV, parseCSV } from "../scripts/models-data.mjs";
import * as C from "../lib/calc.mjs";

const cat = (id, p = 1, o = 4, name = id) => ({ id, name, promptPerMillion: p, completionPerMillion: o });

test("normalize: min-max to 0-100, rounded to 0.1; flat board -> 100", () => {
  const { norm, min, max } = normalizeBoard(new Map([["a", 150], ["b", 160], ["c", 170]]));
  assert.deepEqual([...norm.values()], [0, 50, 100]); assert.equal(min, 150); assert.equal(max, 170);
  assert.equal(normalizeBoard(new Map([["a", 1], ["b", 2], ["c", 1.3333]])).norm.get("c"), 33.3);
  assert.deepEqual([...normalizeBoard(new Map([["a", 5], ["b", 5]])).norm.values()], [100, 100]);
});

test("build: best config per model, per-bench normalization, prices, output metadata", () => {
  const data = buildModelsData({
    generatedUtc: "2026-11-11T00:00:00.000Z",
    catalog: [cat("x/a", 1, 5, "X: Model A"), cat("x/b", 0.2, 0.8, "X: Model B"), cat("x/b-contributor", 0.01, 0.02), cat("y/c", 3, 15)],
    boards: {
      eci: [{ openRouterId: "x/a", score: 170 }, { openRouterId: "x/b", score: 150 }],
      aac: [{ openRouterId: "x/a", score: 40, effort: "low" }, { openRouterId: "x/a", score: 60, effort: "max" }, { openRouterId: "y/c", score: 50 }],
    },
  });
  const a = data.models.find((m) => m.id === "x/a");
  assert.deepEqual(a.scores, { eci: 100, aac: 100 });
  assert.deepEqual(a.raw, { eci: 170, aac: 60 });
  assert.equal(a.effort.aac, "max");
  assert.equal(a.name, "Model A"); assert.equal(a.org, "X");
  assert.equal(a.input, 1); assert.equal(a.output, 5);
  assert.equal(data.models.find((m) => m.id === "y/c").scores.aac, 0);
  const twin = data.models.find((m) => m.id === "x/b-contributor");
  assert.deepEqual(twin.scores, { eci: 0 }, "contributor twin inherits scores, has its own price");
  assert.equal(twin.input, 0.01);
  assert.equal(data.benchmarks.eci.models, 3);
  assert.equal(data.benchmarks.vibe.models, 0);
});

test("build: missing input price fails loudly and publishes nothing", () => {
  const boards = { eci: [{ openRouterId: "x/a", score: 1 }, { openRouterId: "x/gone", score: 2 }] };
  assert.throws(() => buildModelsData({ generatedUtc: "2026-11-11T00:00:00Z", catalog: [cat("x/a")], boards }), /MISSING INPUT PRICE.*\n.*x\/gone/);
  assert.throws(() => buildModelsData({ generatedUtc: "2026-11-11T00:00:00Z", catalog: [cat("x/a"), cat("x/gone", NaN)], boards }), /MISSING INPUT PRICE/);
  assert.throws(() => buildModelsData({ generatedUtc: "2026-11-11T00:00:00Z", catalog: [cat("x/a"), cat("x/gone", -1)], boards }), /MISSING INPUT PRICE/);
});

test("build: unmatched rows can never be published", () => {
  assert.throws(() => buildModelsData({ generatedUtc: "2026-11-11T00:00:00Z", catalog: [], boards: { eci: [{ openRouterId: "unmatched:foo", score: 1 }] } }), /unmatched/);
});

test("validate: rejects missing price and out-of-range score", () => {
  const ok = { schema: 1, generated_utc: "2026-11-11T00:00:00Z", models: [{ id: "a/b", input: 1, output: 2, scores: { eci: 50 } }] };
  assert.ok(validateModelsData(ok));
  assert.throws(() => validateModelsData({ ...ok, models: [{ ...ok.models[0], input: null }] }), /missing input price/);
  assert.throws(() => validateModelsData({ ...ok, models: [{ ...ok.models[0], scores: { eci: 101 } }] }), /outside 0-100/);
  assert.throws(() => validateModelsData({ ...ok, models: [{ ...ok.models[0], scores: { zzz: 1 } }] }), /unknown benchmark/);
});

test("ECI: parses Epoch eci_scores.csv snapshot (quoted fields, blanks)", () => {
  const rows = parseECICSV(readFileSync(new URL("./fixtures/eci-scores-2026-11-11.csv", import.meta.url), "utf8"));
  assert.ok(rows.length >= 250);
  const opus = rows.find((r) => r.model === "Claude Opus 5.5");
  assert.equal(opus.score, 168.54);
  assert.deepEqual(parseCSV('a,b\n"x, y","q""z"\n'), [{ a: "x, y", b: 'q"z' }]);
  assert.throws(() => parseECICSV("foo,bar\n1,2\n"), /missing Model\/eci/);
});

test("committed data/models.json is valid and every model has an input price", () => {
  const data = JSON.parse(readFileSync(new URL("../data/models.json", import.meta.url), "utf8"));
  assert.ok(validateModelsData(data));
  for (const m of data.models) assert.ok(Number.isFinite(m.input) && m.input >= 0, m.id);
  assert.ok(data.benchmarks.eci.models > 30, "ECI present");
  // Recommended defaults must produce a pick in every category on current data.
  const r = C.picksResponse(data, C.RECOMMENDED);
  for (const k of C.CATEGORY_KEYS) assert.equal(r.categories[k].status, "ok", k);
});
