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
  or("x-ai/grok-4.6"),
  or("x-ai/grok-4.7"),
  or("google/gemini-4-argon"),
  or("google/gemini-3.8-flash"),
  or("qwen/qwen3.8-max-0902"),
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
