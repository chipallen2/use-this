// tests/matcher.test.mjs - unit tests for the scrape.mjs alias machinery.
// Regression net for the 2026-10-13 mislabel bug (Opus 5.5 -> Opus 5 via
// substring/fuzzy matching) and the hardening that followed:
// token-boundary matching, version gating, eval-name drops, and the
// unmatched fallback (unknown models keep their own name, never collapse
// onto an old alias).
//
// Run: node --test tests/matcher.test.mjs (also wired into `npm test`).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  normalizeModelName,
  versionSig,
  aliasHits,
  findOpenRouterModel,
  toUnmatchedEntry,
  attachOpenRouter,
  blendCodingScores,
  medianUsageTokens,
  parseAACodingHTML,
  addContributorTwins,
  pickCheapestAbove,
  pickCheapestMatched,
  isUnmatched,
  parseVALSJson,
  VALS_BENCHES,
  VALS_WEIGHTS,
} from "../scripts/scrape.mjs";

// Minimal fake OpenRouter catalog: id (+ pricing fields the matcher reads).
const or = (id, prompt = 1, completion = 3) => ({
  id,
  name: id,
  promptPerMillion: prompt,
  completionPerMillion: completion,
  supportedParameters: ["reasoning"],
  reasoning: {},
});
const CATALOG = [
  or("anthropic/claude-opus-5.5"),
  or("anthropic/claude-opus-5"),
  or("anthropic/claude-opus-4.8"),
  or("anthropic/claude-sonnet-5.5"),
  or("anthropic/claude-sonnet-5"),
  or("anthropic/claude-fable-5.1"),
  or("meta/muse-wonder"),
  or("meta/muse-spark-1.3"),
  or("meta/muse-spark-1.3-contributor"),
  or("openai/gpt-6-astra"),
  or("openai/gpt-6-sol"),
  or("openai/gpt-6.1-sol"),
  or("openai/gpt-6.1-sol-pro"),
  or("openai/gpt-5.6-luna"),
  or("openai/gpt-5.4"),
  or("openai/gpt-5.2"),
  or("openai/gpt-5.2-codex"),
  or("openai/gpt-5.1-codex"),
  or("x-ai/grok-4.6"),
  or("x-ai/grok-4.7"),
  or("x-ai/grok-4.3"),
  or("google/gemini-4-argon"),
  or("google/gemini-3.8-flash"),
  or("google/gemini-3.7-flash"),
  or("google/gemini-3.6-flash"),
  or("google/gemini-3.5-flash"),
  or("google/gemini-3-flash-preview"),
  or("qwen/qwen3.8-max-0902"),
  or("qwen/qwen3.5-122b-a10b"),
  or("qwen/qwen3.6-35b-a3b"),
  or("deepseek/deepseek-v4-flash"),
  or("z-ai/glm-5.2"),
  or("z-ai/glm-5.1"),
  or("moonshotai/kimi-k2.5"),
  or("xiaomi/mimo-v2.6-pro"),
  or("xiaomi/mimo-v2.6-pro-ultraspeed"),
  or("inclusionai/ling-3.1-flash"),
  or("qwen/qwen3-coder-next"),
  or("thinkingmachines/inkling"),
];

const resolve = (rawName) => findOpenRouterModel(rawName, CATALOG);

test("2026-10-13 regression: Opus 5.5 resolves to 5.5, not 5", () => {
  assert.equal(resolve("Claude Opus 5.5 (max with fallback)").model.id, "anthropic/claude-opus-5.5");
  assert.equal(resolve("Claude Sonnet 5.5 (xhigh with fallback)").model.id, "anthropic/claude-sonnet-5.5");
  assert.equal(resolve("Claude Fable 5.1 (max with fallback)").model.id, "anthropic/claude-fable-5.1");
});

test("legacy versions still resolve (no over-gating)", () => {
  assert.equal(resolve("Claude Opus 5 (max)").model.id, "anthropic/claude-opus-5");
  assert.equal(resolve("Claude Sonnet 5 (high)").model.id, "anthropic/claude-sonnet-5");
});

test("boundary: 'opus 5' alias never matches 'opus 5.5' text", () => {
  const needle = normalizeModelName("Claude Opus 5.5 (max)");
  assert.equal(aliasHits("claude opus 5", needle), false);
  assert.equal(aliasHits("claude opus 5.5", needle), true);
});

test("future models do NOT collapse onto old aliases", () => {
  // The exact failure mode the hardening kills: a new version with zero
  // alias rows must come back unmatched, not fuzzy-matched to its sibling.
  assert.equal(resolve("Claude Opus 6 (max)").kind, "unmatched");
  assert.equal(resolve("GPT-7 Astra (max)").kind, "unmatched");
  assert.equal(resolve("Muse Wonder 2 (high)").kind, "unmatched");
  assert.equal(resolve("Grok 4.8 (xhigh)").kind, "unmatched");
  assert.equal(resolve("GPT-6.2 Sol (max)").kind, "unmatched");
});

test("version gate: sibling versions never cross-match", () => {
  assert.equal(resolve("Grok 4.7 (xhigh)").model.id, "x-ai/grok-4.7");
  assert.equal(resolve("Grok 4.6 (high)").model.id, "x-ai/grok-4.6");
  assert.equal(resolve("GPT-6.1 Sol (max)").model.id, "openai/gpt-6.1-sol");
  assert.equal(resolve("GPT-6 Sol (max)").model.id, "openai/gpt-6-sol");
});

test("longest-key-first: contributor twin beats base", () => {
  assert.equal(resolve("Muse Spark 1.3 (max)").model.id, "meta/muse-spark-1.3");
});

test("eval names drop (kind=eval), never match real models", () => {
  for (const name of ["Camellia", "Yoda", "Grogu", "Evergreen", "Solar Pro4 Direct"]) {
    assert.equal(resolve(name).kind, "eval", name);
  }
});

test("Design Arena separator-split ids match dotted aliases", () => {
  const r = findOpenRouterModel("design-arena:claude-fable-5-1", CATALOG);
  assert.equal(r.kind, "alias");
  assert.equal(r.model.id, "anthropic/claude-fable-5.1");
});

test("unmatched fallback keeps raw name + score + price", () => {
  const cand = { rawName: "Claude Opus 6 (max)", model: "Claude Opus 6", effort: "max", score: 61, costPerTask: 6.5 };
  const out = toUnmatchedEntry(cand);
  assert.equal(out.model, "Claude Opus 6");
  assert.equal(out.score, 61);
  assert.equal(out.costPerTask, 6.5);
  assert.equal(out.unmatched, true);
  assert.ok(out.openRouterId.startsWith("unmatched:"));
});

test("attachOpenRouter: unmatched rows become own entries, eval rows drop", () => {
  const rows = [
    { rawName: "Claude Opus 5.5 (max)", model: "Claude Opus 5.5", effort: "max", score: 58, costPerTask: 5.98 },
    { rawName: "Claude Opus 6 (max)", model: "Claude Opus 6", effort: "max", score: 61, costPerTask: 6.5 },
    { rawName: "Camellia", model: "Camellia", effort: null, score: 40, costPerTask: 1 },
  ];
  const pool = attachOpenRouter(rows, CATALOG);
  const byId = new Map(pool.map((x) => [x.openRouterId, x]));
  assert.equal(byId.get("anthropic/claude-opus-5.5").score, 58);
  const un = pool.find((x) => x.openRouterId.startsWith("unmatched:"));
  assert.ok(un, "unmatched row kept");
  assert.equal(un.model, "Claude Opus 6");
  assert.equal(un.score, 61);
  assert.ok(!pool.some((x) => x.model === "Camellia"), "eval row dropped");
});

test("versionSig canonicalizes dots and separators", () => {
  assert.equal(versionSig(normalizeModelName("Claude Opus 5.5 (max)")), "55");
  assert.equal(versionSig(normalizeModelName("design-arena:claude-fable-5-1")), "51");
  assert.equal(versionSig(normalizeModelName("GPT-6.1 Sol (max)")), "61");
  assert.equal(versionSig(normalizeModelName("Muse Wonder (max)")), null);
});

// ---- 2026-10-14 coding-board regression: stem binding ----
// Gemini 3.5/3.6 Flash rows silently resolved to QWEN 3.5/3.6 for weeks:
// the dot-stripped digit augmentation ("35", "36") plus the shared
// generic "flash" satisfied the qwen aliases on digits alone. Fused
// letter-digit aliases must bind the letter stem, not just the digits.
test("coding regression: gemini flash never resolves to qwen", () => {
  assert.equal(resolve("design-arena:gemini-3.5-flash").model.id, "google/gemini-3.5-flash");
  assert.equal(resolve("design-arena:gemini-3.6-flash").model.id, "google/gemini-3.6-flash");
  assert.equal(resolve("gemini-3.5-flash [high]").model.id, "google/gemini-3.5-flash");
  assert.equal(resolve("gemini-3.7-flash [medium]").model.id, "google/gemini-3.7-flash");
});

test("coding: true qwen rows still resolve to qwen", () => {
  assert.equal(resolve("design-arena:qwen3.8-max").model.id, "qwen/qwen3.8-max-0902");
  assert.equal(findOpenRouterModel("qwen3.5 [max]", CATALOG).model.id, "qwen/qwen3.5-122b-a10b");
});

test("coding: DeepSWE + Design Arena names resolve to current models", () => {
  // DeepSWE [effort] rows
  assert.equal(resolve("claude-opus-4.8 [max]").model.id, "anthropic/claude-opus-4.8");
  assert.equal(resolve("glm-5.2 [max]").model.id, "z-ai/glm-5.2");
  assert.equal(resolve("deepseek-v4-flash [max]").model.id, "deepseek/deepseek-v4-flash");
  assert.equal(resolve("gpt-5.2-codex [max]").model.id, "openai/gpt-5.2-codex");
  assert.equal(resolve("gpt-5.1-codex [max]").model.id, "openai/gpt-5.1-codex");
  assert.equal(resolve("gpt-5.4 [max]").model.id, "openai/gpt-5.4");
  // Design Arena ids
  assert.equal(resolve("design-arena:claude-opus-4-8").model.id, "anthropic/claude-opus-4.8");
  assert.equal(resolve("design-arena:glm-5-2").model.id, "z-ai/glm-5.2");
  assert.equal(resolve("design-arena:gpt-5-2-codex").model.id, "openai/gpt-5.2-codex");
  assert.equal(resolve("design-arena:gemini-3-flash-preview").model.id, "google/gemini-3-flash-preview");
  assert.equal(resolve("design-arena:kimi-k2-5").model.id, "moonshotai/kimi-k2.5");
  assert.equal(resolve("design-arena:inkling").model.id, "thinkingmachines/inkling");
  assert.equal(resolve("design-arena:mimo-v2-6-pro-ultraspeed").model.id, "xiaomi/mimo-v2.6-pro-ultraspeed");
  assert.equal(resolve("MiMo-V2.6-Pro").model.id, "xiaomi/mimo-v2.6-pro");
  assert.equal(resolve("Ling 3.1 Flash").model.id, "inclusionai/ling-3.1-flash");
  assert.equal(resolve("Qwen3 Coder Next").model.id, "qwen/qwen3-coder-next");
  assert.equal(resolve("design-arena:grok-4-3").model.id, "x-ai/grok-4.3");
  assert.equal(resolve("design-arena:gpt-6-astra-max").model.id, "openai/gpt-6-astra");
});

test("coding: no-listing / snapshot names stay unmatched or eval", () => {  // hampshire has no OpenRouter listing at all -> eval-drop (priced via
  // Design registry, but nothing purchasable to point the card at).
  assert.equal(resolve("design-arena:hampshire").kind, "eval");
  // dated snapshots / unreleased previews -> unmatched, never collapsed
  assert.equal(resolve("design-arena:claude-opus-4-5-20251101").kind, "unmatched");
  assert.equal(resolve("design-arena:grok-4-20-0309-reasoning").kind, "unmatched");
  assert.equal(resolve("design-arena:gemini-3-pro-preview").kind, "unmatched");
});

test("coding: bare family names + ultraspeed rollup resolve", () => {
  // AA lists the bare family ("MiMo-V2.6-Pro") -> base model.
  assert.equal(resolve("MiMo-V2.6-Pro").model.id, "xiaomi/mimo-v2.6-pro");
  // The "-ultraspeed" rollup IS a real OR listing -> its own row.
  assert.equal(resolve("design-arena:mimo-v2-6-pro-ultraspeed").model.id, "xiaomi/mimo-v2.6-pro-ultraspeed");
});

test("coding: blended pool carries both signals, design-only priced at scale", () => {
  // one AA Coding row + one Design row for the same model -> 50/50 blend;
  // a Design-only model gets a cost estimate scaled to AA coding usage.
  const deep = [
    { rawName: "gpt-6-astra [xhigh]", model: "gpt-6-astra", effort: "xhigh", score: 74, costPerTask: 4.43, outputTokens: 30000, orPromptPerMillion: 10, orCompletionPerMillion: 50, openRouterId: "openai/gpt-6-astra", effortSupported: true },
    { rawName: "gemini-3.5-flash [high]", model: "gemini-3.5-flash", effort: "high", score: 36, costPerTask: 3.45, outputTokens: 76000, orPromptPerMillion: 1.5, orCompletionPerMillion: 9, openRouterId: "google/gemini-3.5-flash", effortSupported: true },
  ];
  const design = [
    { rawName: "design-arena:gpt-6-astra", model: "gpt-6-astra", effort: null, score: 80, elo: 1324, costPerTask: null, daPricePerMillion: 20, orPromptPerMillion: 10, orCompletionPerMillion: 50, openRouterId: "openai/gpt-6-astra", effortSupported: true },
    { rawName: "design-arena:glm-5-2", model: "glm-5-2", effort: null, score: 60, elo: 1215, costPerTask: null, daPricePerMillion: 2.225, orPromptPerMillion: 1.4, orCompletionPerMillion: 4.4, openRouterId: "z-ai/glm-5.2", effortSupported: true },
  ];
  const blended = blendCodingScores(deep, design);
  const byId = new Map(blended.map((x) => [x.openRouterId, x]));
  // Renormalized blend: AA 35% + Design 25% (VALS absent). AA norms: 74->100, 36->0.
  // gpt-6-astra: (0.35*100 + 0.25*80)/0.6 = 91.7. Design-only glm-5.2: 100% of Design norm.
  assert.equal(byId.get("openai/gpt-6-astra").score, 91.7, "(35 AA + 25 Design)/60 renormalized");
  assert.equal(byId.get("openai/gpt-6-astra").aaRaw, 74);
  assert.equal(byId.get("google/gemini-3.5-flash").score, 0, "AA-only keeps normalized signal at 100% weight");
  // blended model averages both signals
  assert.ok(byId.get("openai/gpt-6-astra").sources.includes("renormalized"), `sources note the missing VALS: ${byId.get("openai/gpt-6-astra").sources}`);
  assert.ok(byId.get("openai/gpt-6-astra").designElo === 1324);
  // design-only model: estimated cost uses registry price at median usage
  const only = byId.get("z-ai/glm-5.2");
  assert.equal(only.sources, "Design (renormalized - 4 signals absent)");
  const usage = medianUsageTokens(deep);
  assert.ok(usage > 0, "median usage positive");
  assert.ok(Math.abs(only.costPerTask - (2.225 * usage) / 1_000_000) < 0.015, `cost scaled to usage: ${only.costPerTask}`);
});

// ---- 2026-10-14 graceful degradation: new models never break the build ----
// Fake future models (Opus 6, GPT-7) flow through attachOpenRouter as their
// own NEW entries (score + price intact, no mislabel), and winner selection
// prefers matched models while still deploying when everything is unknown.
test("graceful: fake future Opus 6 + GPT-7 deploy as NEW, never mislabeled", () => {
  const rows = [
    { rawName: "Claude Opus 5.5 (max)", model: "Claude Opus 5.5", effort: "max", score: 58, costPerTask: 5.98 },
    { rawName: "Claude Opus 6 (max)", model: "Claude Opus 6", effort: "max", score: 64, costPerTask: 7.5 },
    { rawName: "GPT-7 Astra (max)", model: "GPT-7 Astra", effort: "max", score: 62, costPerTask: 6.0 },
  ];
  const pool = attachOpenRouter(rows, CATALOG);
  const news = pool.filter(isUnmatched);
  assert.equal(news.length, 2, "both future models kept as own entries");
  const opus6 = news.find((x) => x.model === "Claude Opus 6");
  assert.ok(opus6, "Opus 6 present under its own name");
  assert.equal(opus6.score, 64);
  assert.equal(opus6.costPerTask, 7.5);
  assert.ok(!pool.some((x) => x.model === "Claude Opus 6" && x.openRouterId === "anthropic/claude-opus-5.5"), "Opus 6 NOT collapsed onto Opus 5.5");
  const gpt7 = news.find((x) => x.model === "GPT-7 Astra");
  assert.ok(gpt7, "GPT-7 present under its own name");
  assert.ok(gpt7.openRouterId.startsWith("unmatched:"), "synthetic id");
});

test("graceful: winner skips unmatched for cheapest matched", () => {
  // Opus 6 is cheapest above cutoff but unknown -> winner is matched Opus 5.5.
  const pool = attachOpenRouter([
    { rawName: "Claude Opus 6 (max)", model: "Claude Opus 6", effort: "max", score: 64, costPerTask: 1.0 },
    { rawName: "Claude Opus 5.5 (max)", model: "Claude Opus 5.5", effort: "max", score: 58, costPerTask: 5.98 },
  ], CATALOG);
  const elig = pickCheapestMatched(pool, 50);
  assert.equal(elig[0].openRouterId, "anthropic/claude-opus-5.5", "matched winner, unmatched skipped");
  assert.ok(!isUnmatched(elig[0]));
});

test("graceful: all-unmatched pool still picks a winner (NEW tag path)", () => {
  const pool = attachOpenRouter([
    { rawName: "Claude Opus 6 (max)", model: "Claude Opus 6", effort: "max", score: 64, costPerTask: 7.5 },
    { rawName: "GPT-7 Astra (max)", model: "GPT-7 Astra", effort: "max", score: 62, costPerTask: 6.0 },
  ], CATALOG);
  assert.ok(pool.every(isUnmatched), "everything unknown");
  const elig = pickCheapestMatched(pool, 50);
  assert.equal(elig[0].model, "GPT-7 Astra", "cheapest unknown wins instead of throwing");
  assert.ok(elig[0].openRouterId.startsWith("unmatched:"), "card renders via NEW-tag path");
});

test("graceful: empty cutoff still throws (real data problem, not new models)", () => {
  const pool = attachOpenRouter([
    { rawName: "Claude Opus 5.5 (max)", model: "Claude Opus 5.5", effort: "max", score: 10, costPerTask: 5.98 },
  ], CATALOG);
  assert.throws(() => pickCheapestMatched(pool, 50), /No eligible model/, "no eligible model still fails loud");
});


// Frozen live AA coding source, independently fetched 2026-10-16.
const codingHTML = readFileSync(new URL("./fixtures/aa-coding-2026-10-16.html", import.meta.url), "utf8");
test("AA coding: real Flight rows have source-grounded names, scores, costs and efforts", () => {
  const rows = parseAACodingHTML(codingHTML);
  assert.equal(rows.length, 39);
  const get = (model, effort) => rows.find((x) => x.model === model && x.effort === effort);
  for (const [model, effort, score, cost] of [
    ["Opus 5.5", "max", 66, 13.04], ["Sonnet 5.5", "max", 68.4, 14.19],
    ["Opus 5", "max", 59.7, 10.79], ["GPT-6.1 Sol", "xhigh", 62.9, 1.04],
    ["Gemini 4 Argon", "high", 63.8, 5.84], ["GLM-5.3", "max", 53.6, 4.24],
    ["Qwen3.8 Max", null, 43.3, 3.48],
  ]) {
    const row = get(model, effort);
    assert.ok(row, `${model} [${effort}] present`);
    assert.equal(row.score, score); assert.equal(row.costPerTask, cost);
  }
  assert.ok(!rows.some((x) => x.rawName.includes(" + ")), "dual-model agent runs cannot become single-model scores");
  assert.equal(get("Beam 1.0", null).score, 27.7, "null-cost row never borrows adjacent Opus score");
  assert.equal(get("Beam 1.0", null).costPerTask, null);
  assert.equal(get("Muse Wonder Full", "max").score, 68, "null-cost row never borrows adjacent Haiku score");
  assert.equal(get("Muse Wonder Full", "max").costPerTask, null);
});

test("AA coding: vendor-less aliases retain version gates and family binding", () => {
  assert.equal(resolve("Opus 5.5").model.id, "anthropic/claude-opus-5.5");
  assert.equal(resolve("Opus 5").model.id, "anthropic/claude-opus-5");
  assert.equal(resolve("Sonnet 5.5").model.id, "anthropic/claude-sonnet-5.5");
  assert.equal(resolve("Opus 5.6").kind, "unmatched");
  assert.equal(resolve("Notopus 5.5").kind, "unmatched");
});

test("AA coding: malformed/missing metrics cannot consume the next row", () => {
  const row = (id, extra) => ({id, isDefault: true, displayLabel: `Test - Future ${id} (max)`, display: {model: `Future ${id}`}, ...extra});
  const html = JSON.stringify([row("1", {}), row("2", {indexScore: 0.7, mean: {costUsd: null}}), row("3", {indexScore: 0.6, mean: {costUsd: 2}})]);
  const rows = parseAACodingHTML(html);
  assert.equal(rows.length, 2); assert.equal(rows[0].model, "Future 2");
  assert.equal(rows[0].score, 70); assert.equal(rows[0].costPerTask, null);
  assert.equal(rows[1].score, 60); assert.equal(rows[1].costPerTask, 2);
  assert.throws(() => parseAACodingHTML("<html>No board</html>"), /Could not parse/);
});

test("AA coding: unknown price is never treated as zero or selected as cheapest", () => {
  const rows = [{openRouterId: "test/unpriced", score: 100, costPerTask: null}, {openRouterId: "test/priced", score: 98, costPerTask: 4}];
  assert.equal(pickCheapestMatched(rows, 97)[0].openRouterId, "test/priced");
});

test("catalog prefix boundary: absent legacy listing never borrows newer version", () => {
  assert.equal(findOpenRouterModel("Opus 5", [or("anthropic/claude-opus-5.5")]).kind, "unmatched");
  assert.equal(findOpenRouterModel("GPT-6 Sol", [or("openai/gpt-6-solstice")]).kind, "unmatched");
});

test("contributor twin inherits the final AA/Design blend and preserves missing price", () => {
  const catalog = [or("meta/muse-spark-1.3", 1, 3), or("meta/muse-spark-1.3-contributor", 0.1, 0.3)];
  const aa = [{openRouterId: catalog[0].id, score: 70, costPerTask: 2, effort: "max"}, {openRouterId: "other/model", score: 30, costPerTask: 1}];
  const design = [{openRouterId: catalog[0].id, score: 40, elo: 1200}];
  const rows = addContributorTwins(blendCodingScores(aa, design), catalog);
  const regular = rows.find((x) => x.openRouterId === catalog[0].id);
  const twin = rows.find((x) => x.openRouterId === catalog[1].id);
  // Renormalized: regular has AA (norm 100) + Design (passthrough 40) ->
  // (0.35*100 + 0.25*40)/0.6 = 75; twin inherits the same blend.
  assert.equal(twin.score, 75); assert.equal(twin.score, regular.score);
  assert.equal(twin.sources, regular.sources); assert.equal(twin.designElo, 1200);
  assert.equal(addContributorTwins([{...aa[0], costPerTask: null}], catalog)[1].costPerTask, null);
});

// ---- 2026-10-18 VALS renormalization: five signals, renormalized blend ----
// Weight design: AA 35% + Design 25% + each VALS 13.33%. Missing signals
// are excluded from numerator AND denominator - never zero, never penalty.
// Ground truth: the three frozen VALS fixtures + a small AA/Design pool.
test("vals: Sonnet 5.5 (vibe+swe present, vcb+design absent) scores fairly", () => {
  const aa = [
    { rawName: "Opus 5.5 [max]", model: "Opus 5.5", effort: "max", score: 66, costPerTask: 13.04, outputTokens: 50000, openRouterId: "anthropic/claude-opus-5.5", effortSupported: true },
    { rawName: "Sonnet 5.5 [max]", model: "Sonnet 5.5", effort: "max", score: 68.4, costPerTask: 14.19, outputTokens: 50000, openRouterId: "anthropic/claude-sonnet-5.5", effortSupported: true },
  ];
  const design = [
    { rawName: "design-arena:opus-5-5", model: "Opus 5.5", effort: null, score: 70, elo: 1258, costPerTask: null, daPricePerMillion: 8, orPromptPerMillion: 5, orCompletionPerMillion: 22, openRouterId: "anthropic/claude-opus-5.5", effortSupported: true },
  ];
  const vibeDoc = JSON.parse(readFileSync(new URL("./fixtures/vals-vibe-code-2026-10-18.json", import.meta.url), "utf8"));
  const vibe = parseVALSJson(vibeDoc, "VALS Vibe Code");
  const vcb = parseVALSJson(JSON.parse(readFileSync(new URL("./fixtures/vals-vcb-1-100-2026-10-18.json", import.meta.url), "utf8")), "VALS VCB 1-100");
  const swe = parseVALSJson(JSON.parse(readFileSync(new URL("./fixtures/vals-swe-multimodal-2026-10-18.json", import.meta.url), "utf8")), "VALS SWE Multimodal");
  // Attach to the fake catalog rows used below (raw VALS ids are bare vendor slugs).
  const valsPools = {
    vibe: attachOpenRouter(vibe.filter((r) => /opus-5-5|sonnet-5-5|gpt-6-astra|gemini-4-argon/.test(r.rawName)), CATALOG),
    vcb: attachOpenRouter(vcb, CATALOG),
    swe: attachOpenRouter(swe, CATALOG),
  };
  const blended = blendCodingScores(aa, design, valsPools);
  const byId = new Map(blended.map((x) => [x.openRouterId, x]));
  const sonnet = byId.get("anthropic/claude-sonnet-5.5");
  const opus = byId.get("anthropic/claude-opus-5.5");
  assert.ok(sonnet, "sonnet present");
  assert.ok(opus, "opus present");
  // Sonnet 5.5 must NOT be penalized for absent Design + VCB: it carries
  // AA + Vibe + SWE only, and its sources line says renormalized.
  assert.ok(sonnet.sources.includes("renormalized"), `sonnet sources: ${sonnet.sources}`);
  assert.equal(sonnet.designScore, null, "no design signal");
  assert.equal(sonnet.valsVcbScore, null, "no vcb signal");
  assert.ok(sonnet.valsVibeScore != null && sonnet.valsSweScore != null, "vibe + swe present");
  assert.ok(sonnet.valsVibeRaw != null && sonnet.valsSweRaw != null, "raw accuracies carried");
  // Opus 5.5 has AA + Design + Vibe + VCB + SWE = full 5-signal sources line.
  assert.equal(opus.sources, "35% AA Coding + 25% Design Frontend + 13.3% each VALS Vibe/VCB/SWE", `opus sources: ${opus.sources}`);
  // Weight sanity: exported weights sum to 1.
  const wSum = VALS_WEIGHTS.aa + VALS_WEIGHTS.design + VALS_WEIGHTS.valsVibe + VALS_WEIGHTS.valsVcb + VALS_WEIGHTS.valsSwe;
  assert.ok(Math.abs(wSum - 1) < 1e-9, `weights sum to 1, got ${wSum}`);
  assert.equal(VALS_BENCHES.length, 3, "three VALS benches");
  // Order check: sonnet (top AA raw + top vibe acc) outscores opus here.
  assert.ok(sonnet.score > opus.score, `sonnet ${sonnet.score} > opus ${opus.score}`);
});

test("vals: all-5-signals uses full weights, single-signal uses 100% of its norm", () => {
  // Synthetic pool where every model has every signal via identical pools:
  // with one AA row + one design row + one vals row each, norms are 50s
  // and the blend must equal the weighted mean of the per-signal norms.
  const aa = [
    { rawName: "A [max]", model: "A", effort: "max", score: 80, costPerTask: 5, outputTokens: 1000, openRouterId: "anthropic/claude-opus-5.5", effortSupported: true },
    { rawName: "B [max]", model: "B", effort: "max", score: 60, costPerTask: 4, outputTokens: 1000, openRouterId: "anthropic/claude-sonnet-5.5", effortSupported: true },
  ];
  const design = [
    { rawName: "da:a", model: "A", effort: null, score: 90, elo: 1300, costPerTask: null, daPricePerMillion: 5, orPromptPerMillion: 5, orCompletionPerMillion: 20, openRouterId: "anthropic/claude-opus-5.5", effortSupported: true },
    { rawName: "da:b", model: "B", effort: null, score: 70, elo: 1200, costPerTask: null, daPricePerMillion: 4, orPromptPerMillion: 4, orCompletionPerMillion: 16, openRouterId: "anthropic/claude-sonnet-5.5", effortSupported: true },
  ];
  const mk = (id, s) => ({ rawName: id, model: id, effort: null, score: s, openRouterId: id === "A" ? "anthropic/claude-opus-5.5" : "anthropic/claude-sonnet-5.5" });
  const valsPools = {
    vibe: [mk("A", 95), mk("B", 85)],
    vcb: [mk("A", 40), mk("B", 20)],
    swe: [mk("A", 70), mk("B", 50)],
  };
  const blended = blendCodingScores(aa, design, valsPools);
  const byId = new Map(blended.map((x) => [x.openRouterId, x]));
  const A = byId.get("anthropic/claude-opus-5.5");
  const B = byId.get("anthropic/claude-sonnet-5.5");
  // AA + 3xVALS min-max norm to 100/0; Design scores are already 0-100
  // upstream (no min-max on that leg). Full-weight blend:
  // A = .35*100 + .25*90 + 3*(.1333*100) = 97.5; B = .35*0 + .25*70 + 0 = 17.5.
  assert.equal(A.score, 97.5, `A full-weight blend: ${A.score}`);
  assert.equal(B.score, 17.5, `B full-weight blend: ${B.score}`);
  assert.equal(A.sources, "35% AA Coding + 25% Design Frontend + 13.3% each VALS Vibe/VCB/SWE");
  // Single-signal model: only Design present -> 100% of its norm.
  // Design scores pass through unnormalized (already 0-100 upstream),
  // so the lone model keeps its 90.
  const lone = blendCodingScores([], [{ ...design[0] }], {});
  assert.equal(lone.length, 1);
  assert.equal(lone[0].score, 90, `lone design-only model: ${lone[0].score}`);
  assert.ok(lone[0].sources.includes("renormalized"));
});

test("vals: parseVALSJson reads raw accuracies, fails loud on bad docs", () => {
  const vibeDoc = JSON.parse(readFileSync(new URL("./fixtures/vals-vibe-code-2026-10-18.json", import.meta.url), "utf8"));
  const rows = parseVALSJson(vibeDoc, "VALS Vibe Code");
  assert.equal(rows.length, 113);
  const sonnet = rows.find((r) => r.rawName === "anthropic/claude-sonnet-5-5");
  assert.ok(sonnet, "sonnet row present");
  assert.equal(sonnet.score, 92.392, "raw accuracy preserved");
  assert.throws(() => parseVALSJson({}, "X"), /no tasks\.overall/);
  assert.throws(() => parseVALSJson({ tasks: { overall: {} } }, "X"), /0 usable/);
});
