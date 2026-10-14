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
import {
  normalizeModelName,
  versionSig,
  aliasHits,
  findOpenRouterModel,
  toUnmatchedEntry,
  attachOpenRouter,
  blendCodingScores,
  medianUsageTokens,
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
  // one DeepSWE row + one Design row for the same model -> 50/50 blend;
  // a Design-only model gets a cost estimate scaled to DeepSWE usage.
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
  // blended model averages both signals
  assert.ok(byId.get("openai/gpt-6-astra").sources.includes("50%"));
  assert.ok(byId.get("openai/gpt-6-astra").designElo === 1324);
  // design-only model: estimated cost uses registry price at median usage
  const only = byId.get("z-ai/glm-5.2");
  assert.equal(only.sources, "Design Arena only - no DeepSWE data yet");
  const usage = medianUsageTokens(deep);
  assert.ok(usage > 0, "median usage positive");
  assert.ok(Math.abs(only.costPerTask - (2.225 * usage) / 1_000_000) < 0.015, `cost scaled to usage: ${only.costPerTask}`);
});
