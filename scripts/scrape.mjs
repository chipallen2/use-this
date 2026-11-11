// scripts/scrape.mjs - daily data refresh. No LLM calls. No tokens.
// Fetches every benchmark (Epoch ECI, AA Intelligence Index, AA Coding Agent
// Index, Design Arena Frontend, Vals Vibe/VCB/SWE) + the OpenRouter price
// catalog, matches leaderboard names to OpenRouter ids, normalizes each
// benchmark to 0-100 (scripts/models-data.mjs) and writes <outdir>/models.json.
// There are NO precalculated picks: browsers and the bot endpoint compute
// picks from URL settings with lib/calc.mjs.
// Fails loudly (exit 1, nothing written) when a required source is down or
// any published model lacks an input price.
// Usage: node scripts/scrape.mjs [outdir]

import { chromium } from "playwright";
import { mkdirSync, writeFileSync, renameSync } from "fs";
import { buildModelsData, parseECICSV } from "./models-data.mjs";

const OUT = process.argv[2] || "data";

const CONFIG = {
  urls: {
    eci: "https://epoch.ai/data/eci_scores.csv",
    // DEEPSWE_DISABLED (2026-10-16): deepSWE: "https://deepswe.datacurve.ai/",
    codingAgents: "https://artificialanalysis.ai/agents/coding-agents",
    intelligenceIndex: "https://artificialanalysis.ai/leaderboards/models",
    openRouter: "https://openrouter.ai/api/v1/models",
    designArena: "https://www.designarena.ai/api/leaderboard",
    valsPage: (slug) => `https://vals.ai/benchmarks/${slug}`,
    valsJson: (path) => `https://vals.ai/_astro/${path}`,
  },
  designArenaBody: { arenaType: "agents", category: "agon_webapps", variationName: "public", inputModality: "text" },
};

const round = (n, digits = 2) => Number(Number(n).toFixed(digits));

const normalizeModelName = (name) =>
  name.toLowerCase().replaceAll("adaptive reasoning", "").replaceAll("effort", "")
    .replaceAll("with fallback", "")
    // Design Arena id prefix (its hyphen becomes a space below, so match
    // "design arena:" post-normalization form here via two passes: first
    // strip the raw prefix, then the normalized one).
    .replace(/design-arena\s*:\s*/g, "")
    // VALS vendor prefix: their ids are vendor-prefixed bare slugs
    // ("anthropic/claude-sonnet-5-5", "zai/glm-5.3", "grok/grok-4.6").
    // The vendor token carries no identity - the family alias already says
    // "opus"/"glm"/"grok" - and foreign vendor tokens actively corrupt
    // version gating ("zai" would inject digits? no - worse: "grok/grok"
    // doubles tokens, "ant/ling" looks versionless). Strip everything up
    // to and including the first slash. Applied before separator
    // normalization so "muse_spark_1_3_max"-style underscores still split.
    .replace(/^[^\s]*\//, "")
    .replace(/[()[\]]/g, " ").replace(/[-_:/]/g, " ").replace(/\s+/g, " ").trim()
    .replace(/^design arena\s+/, "");

// Version-signature: canonical digit string of the FIRST version-like run
// in a normalized name. Dots and separators are equivalent ("5.1" ≡
// "5 1" ≡ "5-1"), so AA "Fable 5.1" and Design
// Arena "claude-fable-5-1" all sign "51". Used by the version gate in
// findOpenRouterModel: a needle carrying a version only matches an alias
// carrying the SAME version ("opus 5" never takes "opus 5.5").
// Returns null when neither side names a version (unversioned family).
const versionSig = (normStr) => {
  const toks = normStr.split(" ");
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (/^[\d.]+$/.test(t) && /\d/.test(t)) { // pure version token: "5.5", "5", "1.3"
      let sig = t.replace(/\./g, "");
      // Absorb following pure-digit tokens: Design "5 1" -> "51".
      let j = i + 1;
      while (j < toks.length && /^\d+$/.test(toks[j])) { sig += toks[j]; j++; }
      return sig || null;
    }
    const m = t.match(/\d[\d.]*/); // mixed token: "qwen3.8" -> "38", "120b" -> "120"
    if (m) return m[0].replace(/\./g, "");
  }
  return null;
};

// Augmented token set: original tokens plus
// - the dot-stripped form of dotted tokens ("5.5" -> "55"), and
// - the concatenation of every run of consecutive pure-digit tokens
//   ("5 1" -> "51"),
// so dotted alias versions match separator-split leaderboard names
// (Design Arena "claude-fable-5-1" -> tokens "5","1" -> "51").
// NOTE: the dot-stripped augmentation is what let "gemini 3.5 flash"
// satisfy alias "qwen3.5" on version digits alone (both carry "35",
// "flash" is a shared generic). aliasHits() below requires the
// family stem to match for bare-digit-carrying aliases - the set alone
// is never sufficient.
function tokenSet(normStr) {
  const toks = normStr.split(" ").filter(Boolean);
  const set = new Set(toks);
  for (const t of toks) {
    if (/^[\d.]+$/.test(t) && /\d/.test(t)) set.add(t.replace(/\./g, ""));
  }
  let run = "";
  const flush = () => { if (run) { set.add(run); run = ""; } };
  for (const t of toks) {
    if (/^\d+$/.test(t)) run += t;
    else flush();
  }
  flush();
  return set;
}

const splitConfig = (raw) => {
  const match = raw.match(/^(.*?)\s*\[([^\]]+)]\s*$/);
  if (match) return { model: match[1].trim(), effort: match[2].trim().toLowerCase() };
  const parenMatch = raw.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  if (parenMatch) {
    const effort = parenMatch[2].match(/\b(xhigh|max|high|medium|low|minimal)\b/i)?.[1]?.toLowerCase() ?? null;
    return { model: parenMatch[1].trim(), effort };
  }
  const effort = raw.match(/\b(xhigh|max|high|medium|low|minimal)\b/i)?.[1]?.toLowerCase() ?? null;
  return { model: raw.replace(/\(.*?(xhigh|max|high|medium|low|minimal).*?\)/gi, "").trim(), effort };
};

async function getOpenRouterModels() {
  const response = await fetch(CONFIG.urls.openRouter);
  if (!response.ok) throw new Error(`OpenRouter HTTP ${response.status}`);
  const json = await response.json();
  return json.data.map((m) => ({
    id: m.id,
    name: m.name,
    contextLength: m.context_length,
    promptPerMillion: Number(m.pricing?.prompt ?? 0) * 1_000_000,
    completionPerMillion: Number(m.pricing?.completion ?? 0) * 1_000_000,
    supportedParameters: m.supported_parameters ?? [],
    reasoning: m.reasoning ?? {},
  }));
}

// Alias table: [aliasKey, openRouterIdPrefix, {eval}].
// aliasKey matches against the NORMALIZED AA display name with TOKEN
// BOUNDARIES - "gpt 6 sol" must NOT match "gpt 6.1 sol" even though one is
// a substring of the other. Longest-key-first ordering is a second layer,
// not the only defense: boundary + version-token checks (below) enforce it.
// Version aliases MUST exist per released version ("opus 5.5" separate from
// "opus 5"): a needle carrying a version token only matches an alias whose
// key carries the SAME token.
// Eval-style aliases (camellia, yoda, grogu, evergreen, solar-pro4-direct)
// map to null: leaderboard-only rows, dropped with a loud log line (see
// attachOpenRouter), never fuzzy-matched onto a real model.
const MODEL_ALIASES = [
  ["gpt-6-astra", "openai/gpt-6-astra"],
  // 2026-11-11: rows seen on the ECI / AA boards that have OpenRouter listings.
  ["gpt-6.1-terra-pro", "openai/gpt-6.1-terra-pro"],
  ["gpt-6.1-terra", "openai/gpt-6.1-terra"],
  ["gpt-5.4-pro", "openai/gpt-5.4-pro"],
  ["gpt-5.2-pro", "openai/gpt-5.2-pro"],
  ["claude-fable-5.2", "anthropic/claude-fable-5.2"],
  ["fable-5.2", "anthropic/claude-fable-5.2"],
  ["gemini-4-carbon", "google/gemini-4-carbon"],
  ["kimi-k3.1-pro", "moonshotai/kimi-k3.1-pro"],
  ["grok-4.5", "x-ai/grok-4.5"],
  ["deepseek-v4.1-flash-1017", "deepseek/deepseek-v4.1-flash-1017"],
  ["muse-ember", "meta/muse-ember"],
  ["muse-spark-open", "meta/muse-spark-open"],
  ["gpt-6-sol", "openai/gpt-6-sol"],
  ["gpt-6.1-sol-pro", "openai/gpt-6.1-sol-pro"],
  ["gpt-6.1-sol", "openai/gpt-6.1-sol"],
  ["gpt-6-luna-pro", "openai/gpt-6-luna-pro"],
  ["gpt-6-luna", "openai/gpt-6-luna"],
  ["gpt-5.6-sol-pro", "openai/gpt-5.6-sol-pro"],
  ["gpt-5.6-sol", "openai/gpt-5.6-sol"],
  ["gpt-5.6-luna-pro", "openai/gpt-5.6-luna-pro"],
  ["gpt-5.6-luna", "openai/gpt-5.6-luna"],
  ["gpt-5.6-terra", "openai/gpt-5.6-terra"],
  ["gpt-5.5-pro", "openai/gpt-5.5-pro"],
  ["gpt-5.5", "openai/gpt-5.5"],
  ["gpt-5.3-codex", "openai/gpt-5.3-codex"],
  ["gpt-oss-120b", "openai/gpt-oss-120b"],
  ["gpt-oss-20b", "openai/gpt-oss-20b"],
  ["claude-opus-5.5", "anthropic/claude-opus-5.5"],
  ["claude-opus-5", "anthropic/claude-opus-5"],
  ["claude-sonnet-5.5", "anthropic/claude-sonnet-5.5"],
  ["claude-sonnet-5", "anthropic/claude-sonnet-5"],
  ["claude-haiku-5.5", "anthropic/claude-haiku-5.5"],
  ["claude-fable-5.1", "anthropic/claude-fable-5.1"],
  ["claude-fable-5", "anthropic/claude-fable-5"],
  // Vendor-less AA Coding Agent Index forms (2026-10-16): the coding board
  // lists "Claude Code - Opus 5.5 (max)" (harness name replaces the vendor),
  // so the needle carries no "claude" token. Explicit rows, same version
  // gate + stem binding as every alias - "opus 5" never takes "opus 5.5".
  ["opus-5.5", "anthropic/claude-opus-5.5"],
  ["opus-5", "anthropic/claude-opus-5"],
  ["sonnet-5.5", "anthropic/claude-sonnet-5.5"],
  ["sonnet-5", "anthropic/claude-sonnet-5"],
  ["fable-5.1", "anthropic/claude-fable-5.1"],
  ["fable-5", "anthropic/claude-fable-5"],
  ["haiku-5.5", "anthropic/claude-haiku-5.5"],
  // Mirror "Beam 1.0" is Reflection's model on OpenRouter (2026-10-16).
  ["beam-1.0", "reflection/beam-1.0-501b-a23b"],
  ["muse-wonder-full", "meta/muse-wonder"],
  ["muse-wonder", "meta/muse-wonder"],
  ["muse-glimmer", "meta/muse-glimmer-30b"],
  ["gemini-4-argon", "google/gemini-4-argon"],
  ["gemini-3.8-flash", "google/gemini-3.8-flash"],
  ["gemini-3.7-flash", "google/gemini-3.7-flash"],
  ["gemini-3.5-flash-lite", "google/gemini-3.5-flash-lite"],
  ["gemini-3.1-pro", "google/gemini-3.1-pro-preview"],
  ["gemini-2.5-flash-lite", "google/gemini-2.5-flash-lite"],
  ["gemini-2.5-flash", "google/gemini-2.5-flash"],
  ["glm-5.3-flash", "z-ai/glm-5.3-flash"],
  ["glm-5.3", "z-ai/glm-5.3"],
  ["grok-4.7", "x-ai/grok-4.7"],
  ["grok-4.6", "x-ai/grok-4.6"],
  ["kimi-k3", "moonshotai/kimi-k3"],
  ["qwen3.8-flash-next", "qwen/qwen3.8-flash-next"],
  ["qwen3.8-max", "qwen/qwen3.8-max-0902"],
  ["qwen3.8-27b", "qwen/qwen3.8-27b"],
  ["qwen3.8", "qwen/qwen3.8-max-0902"],
  ["qwen3.7-plus", "qwen/qwen3.7-plus"],
  ["qwen3.7-max", "qwen/qwen3.7-max"],
  ["qwen3.6", "qwen/qwen3.6-35b-a3b"],
  ["qwen3.5", "qwen/qwen3.5-122b-a10b"],
  ["minimax-m3", "minimax/minimax-m3"],
  ["step-5", "stepfun/step-5-preview"],
  ["solar-mini-4", "upstage/solar-mini4"],
  ["solar-pro-4", "upstage/solar-pro4"],
  ["deepseek-v4.1-flash", "deepseek/deepseek-v4.1-flash"],
  ["deepseek-v4-pro", "deepseek/deepseek-v4-pro-0813"],
  ["deepseek-v4", "deepseek/deepseek-v4-pro-0813"],
  ["ling-3.1-flash", "inclusionai/ling-3.1-flash"],
  ["qwen3-coder-next", "qwen/qwen3-coder-next"],
  ["gpt-5.6-sol-xhigh", "openai/gpt-5.6-sol"],
  ["muse-spark-1.3-max", "meta/muse-spark-1.3"],
  ["muse-spark-1.3-contributor", "meta/muse-spark-1.3-contributor"],
  ["muse-spark-1.3", "meta/muse-spark-1.3"],
  ["muse-spark-1.2-contributor", "meta/muse-spark-1.2-contributor"],
  ["muse-spark-1.2", "meta/muse-spark-1.2"],
  ["muse-spark-1.1", "meta/muse-spark-1.1"],
  ["mimo-v2.6-flash", "xiaomi/mimo-v2.6-flash"],
  ["mimo-v2.6", "xiaomi/mimo-v2.6-pro"],
  ["mimo-v2.6-pro-ultraspeed", "xiaomi/mimo-v2.6-pro-ultraspeed"],
  // Separator-split Design Arena form ("mimo-v2-6-pro-ultraspeed"): same
  // reason as kimi-k2-5 above - explicit row so the version gate sees
  // sig "26" on both sides instead of needle "2" vs alias "26".
  ["mimo-v2-6-pro-ultraspeed", "xiaomi/mimo-v2.6-pro-ultraspeed"],
  ["mimo-v2.5", "xiaomi/mimo-v2.5"],
  ["kimi-k2.7-code", "moonshotai/kimi-k2.7-code"],
  ["kimi-k2.6", "moonshotai/kimi-k2.6"],
  ["kimi-k2.5", "moonshotai/kimi-k2.5"],
  // Separator-split Design Arena form ("kimi-k2-5"): the generic in-order
  // digit walk cannot prove "k2 5" is version "2.5" rather than "25",
  // so the split form gets its own explicit row (same version gate as
  // every alias - "kimi-k2-6" will NOT take this row).
  ["kimi-k2-5", "moonshotai/kimi-k2.5"],
  ["glm-5.2", "z-ai/glm-5.2"],
  ["glm-5.1", "z-ai/glm-5.1"],
  ["glm-5-turbo", "z-ai/glm-5-turbo"],
  ["glm-5v-turbo", "z-ai/glm-5v-turbo"],
  ["grok-4.20", "x-ai/grok-4.20"],
  ["grok-4.3", "x-ai/grok-4.3"],
  ["claude-opus-4.8", "anthropic/claude-opus-4.8"],
  ["claude-opus-4.7", "anthropic/claude-opus-4.7"],
  ["claude-opus-4.6", "anthropic/claude-opus-4.6"],
  ["claude-opus-4.5", "anthropic/claude-opus-4.5"],
  ["claude-opus-4.1", "anthropic/claude-opus-4.1"],
  ["claude-sonnet-4.6", "anthropic/claude-sonnet-4.6"],
  ["claude-sonnet-4.5", "anthropic/claude-sonnet-4.5"],
  ["claude-sonnet-4", "anthropic/claude-sonnet-4"],
  ["gemini-3.6-flash", "google/gemini-3.6-flash"],
  ["gemini-3.5-flash", "google/gemini-3.5-flash"],
  ["gemini-3-flash-preview", "google/gemini-3-flash-preview"],
  ["deepseek-v4-flash", "deepseek/deepseek-v4-flash"],
  ["gpt-5.4", "openai/gpt-5.4"],
  ["gpt-5.2-codex", "openai/gpt-5.2-codex"],
  ["gpt-5.2", "openai/gpt-5.2"],
  ["gpt-5.1-codex", "openai/gpt-5.1-codex"],
  ["hampshire", null], // NO OpenRouter listing - unmatched w/ Design registry price
  ["inkling", "thinkingmachines/inkling"],
  ["muse-spark", "meta/muse-spark"],
  // Design Arena effort-suffixed board ids: the board's reasoning rollup
  // rows ("<model>-max", "-xhigh", ...) alias to the base model's
  // OpenRouter id. Listed here (not via suffix-stripping) so each maps
  // loudly and version-gated, and new suffixes fail unmatched instead
  // of silently landing on the wrong model.
  ["gpt-6-astra-max", "openai/gpt-6-astra"],
  // Leaderboard-only / eval names: NEVER match a real model. Dropped loudly.
  // hampshire (Thinking Machines) has NO OpenRouter listing AND a real
  // Design Arena registry price ($0.435/$0.87 per 1M) - so it is eval-class
  // here (dropped from the blended pool) rather than unmatched: an
  // unmatched entry would carry only a synthetic id with no purchasable
  // model behind it. If hampshire lands on OpenRouter, promote to an alias.
  ["camellia", null],
  ["hampshire", null], // NO OpenRouter listing - eval-drop (see note above)
  ["solar-pro4-direct", null],
  ["yoda", null],
  ["evergreen", null],
  ["grogu", null],
];

const normKey = (k) => k.toLowerCase().replace(/[-_]/g, " ");

// Token-boundary match: every token of the alias key must appear in the
// needle as a WHOLE token ("gpt 6 sol" does not match "gpt 6.1 sol",
// "opus 5" does not match "opus 5.5"), where a digit-run in the needle
// ("5 1") also satisfies the concatenation (alias "5.1"), covering
// Design Arena's separator-split ids ("claude-fable-5-1").
// STEM BINDING (2026-10-14 coding fix): aliases whose key carries digits
// fused to letters ("qwen3.5", "mimo", "glm-5", ...) must ALSO match
// the letter stem, not just the digit signature. Without this, the
// dot-stripped augmentation in tokenSet() lets "gemini 3.5 flash"
// satisfy alias "qwen3.5" on version digits alone (both carry "35",
// "flash" is a shared generic) - the exact silent mislabel that put
// Gemini 3.5 Flash rows on the Qwen 3.5 card for weeks. Pure-digit
// aliases ("step-5", "gpt-5.5" -> tokens "gpt","5.5"...) and
// pure-letter aliases ("hampshire", "inkling") skip the stem check:
// the former are version-gated by versionSig, the latter have no stem
// to bind. Mixed tokens require: EITHER the literal token present
// ("qwen3.5" in needle) OR (stem present AND digit-sig present).
function aliasHits(keyNorm, needleNorm) {
  const have = tokenSet(needleNorm);
  return keyNorm.split(" ").every((tok) => {
    if (/^[\d.]+$/.test(tok) && /\d/.test(tok)) return have.has(tok.replace(/\./g, ""));
    const m = tok.match(/\d[\d.]*/);
    if (m) {
      if (have.has(tok)) return true; // literal fused token present
      // Stem binding: the letter-stem of a fused token must be present
      // as a substring of SOME needle token, AND the digit signature
      // must be present. Digits alone are never enough (gemini-3.5 vs
      // qwen3.5 trap). The sig here is the token's own digits
      // dot-stripped, so "5-1"-style splits match ("51") while a bare
      // "5" in the needle does NOT satisfy alias "5.1".
      const stem = tok.slice(0, m.index).toLowerCase();
      const sig = m[0].replace(/\./g, "");
      if (!stem) return have.has(sig);
      const stemHit = needleNorm.split(" ").some((nt) => nt.includes(stem));
      // Suffix-form versions ("k2.5", alias sig "25") also match the
      // needle's per-token digits individually: "k2 5" carries "2"
      // inside token "k2" and bare token "5" (Design Arena
      // "kimi-k2-5"). Without this, only dot-joined needles match.
      if (stemHit && have.has(sig)) return true;
      if (!stemHit) return false;
      const digits = sig.split("");
      // All alias digits must appear IN ORDER across needle tokens -
      // "k2 5" satisfies "25" (k2 then 5) but not "52". Digits ride
      // EITHER fused inside a stem-sharing token ("k2" carries stem
      // "k") OR as bare tokens ("5"); digits fused inside a FOREIGN
      // token never count ("35" inside "qwen3.5" must not satisfy a
      // "5" need - that hole is what let gemini-3.5 take qwen3.5-
      // adjacent aliases pre-stem-binding).
      let di = 0;
      const ntoks = needleNorm.split(" ");
      const digAt = (nt) => {
        // Only digits fused to OUR stem, or bare digit tokens, count.
        if (/^[\d.]+$/.test(nt)) return nt.replace(/\./g, "").split(""); // bare: "5" -> ["5"]
        if (!nt.toLowerCase().includes(stem)) return []; // foreign token: digits invisible
        const dm = nt.match(/\d[\d.]*/g) || [];
        return dm.flatMap((d) => d.replace(/\./g, "").split(""));
      };
      // Greedy in-order consumption across needle tokens.
      const flat = ntoks.flatMap((nt) => digAt(nt));
      for (const d of flat) {
        if (di < digits.length && d === digits[di]) di++;
      }
      return di === digits.length;
    }
    return have.has(tok);
  });
}

// Match result: { kind: "alias"|"eval"|"unmatched", model }.
// - "alias": found via the alias table (boundary + version-gated).
// - "eval": leaderboard-only name (camellia, yoda, ...) - caller drops it.
// - "unmatched": zero alias hits. NO fuzzy fallback: the old word-score
//   fallback is what silently labeled Opus 5.5 as Opus 5 (and would label
//   GPT-6.1 Sol as GPT-6 Sol, Grok 4.7 as Grok 4.6, ...). Callers keep the
//   raw AA display name as its own pool entry (score + AA price intact)
//   via toUnmatchedEntry(), so unknown models show truthfully instead of
//   masquerading as an older sibling.
function findOpenRouterModel(modelName, openRouterModels) {
  const needle = normalizeModelName(modelName);
  const needleVer = versionSig(needle);
  // Longest alias key first so "muse spark 1.3 contributor" beats "muse spark 1.3".
  const ordered = [...MODEL_ALIASES].sort((a, b) => b[0].length - a[0].length);
  for (const [key, idPrefix] of ordered) {
    const keyNorm = normKey(key);
    if (!aliasHits(keyNorm, needle)) continue;
    // Version gate: if BOTH sides carry a version signature, they must
    // agree - "opus 5" never takes "opus 5.5" (6ef57f5 regression),
    // "grok 4.6" never takes "grok 4.7". No signature on either side =
    // unversioned family name, matches freely.
    // One-sided version: a needle WITH a version only matches an alias
    // WITHOUT one when the alias is the family's canonical first release
    // ("Muse Wonder" v1 is just "Muse Wonder"); a needle WITHOUT a
    // version must NOT match a versioned alias ("GPT-6 Sol" must not hit
    // "gpt-6.1-sol" - substring trap). In both one-sided cases, skip.
    const keyVer = versionSig(keyNorm);
    if ((needleVer || keyVer) && needleVer !== keyVer) continue;
    if (idPrefix == null) return { kind: "eval", model: null };
    // Exact-ID match wins over prefix match: "meta/muse-spark-1.3" must
    // not resolve to its "-contributor" twin (or vice versa).
    const exact = openRouterModels.find((m) => m.id === idPrefix);
    if (exact) return { kind: "alias", model: exact };
    // A catalog prefix also needs a boundary: a missing opus-5 listing
    // must never fall through to opus-5.5, even if the alias matched.
    const hit = openRouterModels.find((m) => m.id.startsWith(`${idPrefix}-`) || m.id.startsWith(`${idPrefix}:`));
    if (hit) return { kind: "alias", model: hit };
  }
  return { kind: "unmatched", model: null };
}

// Pool entry for an unknown model: keeps the raw AA display name as the
// model label, the AA score, and the AA $/task price (no per-1M rates -
// price displays from costPerTask). openRouterId is a synthetic
// "unmatched:<slug>" marker so dedupe/candidates/picks treat it as its
// own model, and the guard can find every such entry by prefix.
// effortSupported is true (nothing to contradict the AA effort label).
function toUnmatchedEntry(candidate) {
  const slug = normalizeModelName(candidate.model).replace(/\s+/g, "-").slice(0, 60) || "unknown";
  return {
    ...candidate,
    openRouterId: `unmatched:${slug}`,
    effortSupported: true,
    unmatched: true,
  };
}

function effortIsSupported(candidate, openRouterModel) {
  if (!candidate.effort) return true;
  if (!openRouterModel) return false;
  const efforts = openRouterModel.reasoning?.supported_efforts;
  if (!efforts?.length) {
    return openRouterModel.supportedParameters.includes("reasoning") ||
      openRouterModel.supportedParameters.includes("reasoning_effort");
  }
  return efforts.includes(candidate.effort);
}

// VALS coding benches (2026-10-18): three independent benchmarks from
// vals.ai, each with its own accuracy scale. Live fetch: the benchmark
// page HTML embeds the hashed _astro JSON path
// (benchmark_view_<slug>.<hash>.json); scrape discovers it via regex
// (same pattern as the AA Flight parse - hashes rotate on site rebuilds,
// so NEVER hardcode them), then fetches the JSON and reads
// tasks.overall[<modelId>].accuracy keyed by vendor-prefixed bare slug
// ("anthropic/claude-sonnet-5-5"). The vendor token is stripped by
// normalizeModelName (slash-prefix rule), so ids resolve through the
// existing MODEL_ALIASES table + version gate + stem binding - no new
// matcher code, same anti-mislabel guards.
const VALS_BENCHES = [
  { key: "vibe", name: "VALS Vibe Code", slug: "vibe-code" },
  { key: "vcb", name: "VALS VCB 1-100", slug: "vcb-1-100" },
  { key: "swe", name: "VALS SWE Multimodal", slug: "swebench-multimodal" },
];

// Parse one VALS _astro JSON doc into [{ model, score }] raw accuracies.
// Malformed per-model rows are skipped, never borrowed from neighbors.
// Throws when the doc carries zero usable rows (fail-loud in main).
function parseVALSJson(json, benchName) {
  const overall = json?.tasks?.overall;
  if (!overall || typeof overall !== "object" || Array.isArray(overall)) {
    throw new Error(`${benchName}: no tasks.overall map in JSON`);
  }
  const rows = [];
  for (const [modelId, v] of Object.entries(overall)) {
    const acc = v?.accuracy;
    if (typeof acc === "number" && Number.isFinite(acc) && typeof modelId === "string" && modelId) {
      rows.push({ rawName: modelId, model: modelId, effort: null, score: round(acc, 3) });
    }
  }
  if (!rows.length) throw new Error(`${benchName}: 0 usable accuracy rows`);
  return rows;
}

async function fetchVALSBench(bench) {
  const pageRes = await fetch(CONFIG.urls.valsPage(bench.slug), {
    headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
  });
  if (!pageRes.ok) throw new Error(`${bench.name} page HTTP ${pageRes.status}`);
  const html = await pageRes.text();
  const m = html.match(/_astro\/(benchmark_view_[^"]*?\.json)/);
  if (!m) throw new Error(`${bench.name}: no _astro benchmark_view JSON path in page HTML`);
  const jsonRes = await fetch(CONFIG.urls.valsJson(m[1]), {
    headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
  });
  if (!jsonRes.ok) throw new Error(`${bench.name} JSON HTTP ${jsonRes.status}`);
  return parseVALSJson(await jsonRes.json(), bench.name);
}

async function scrapeDesignArena() {
  // Design Arena agentic Web App board (Frontend tab = agon_webapps).
  // Plain fetch works: POST JSON to their public leaderboard API.
  const response = await fetch(CONFIG.urls.designArena, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(CONFIG.designArenaBody),
  });
  if (!response.ok) throw new Error(`Design Arena HTTP ${response.status}`);
  const json = await response.json();
  if (!json.success || !Array.isArray(json.data) || !json.data.length) {
    throw new Error("Design Arena returned no board data");
  }
  const elos = json.data.map((r) => Number(r.elo));
  const lo = Math.min(...elos), hi = Math.max(...elos);
  return json.data
    .filter((r) => Number.isFinite(Number(r.elo)) && Number(r.battles) >= 500)
    .map((r) => ({
      rawName: `design-arena:${r.modelId}`,
      model: r.modelId,
      effort: null,
      // min-max normalize Elo across this board to 0-100
      score: hi > lo ? round(((Number(r.elo) - lo) / (hi - lo)) * 100, 1) : 50,
      elo: round(Number(r.elo), 1),
      battles: Number(r.battles),
      winRate: Number(r.winRate),
      costPerTask: null, // filled from blended pricing below
      daPricePerMillion: null, // filled from Design Arena registry below
    }));
}


// AA Coding Agent Index (2026-10-16): the coding signal source.
// The board page embeds one JSON entry per agent row (React Flight data):
// displayLabel "<harness> - <model> [(effort)][ (with fallback)]" (or
// "<model> (<effort>) ({'reasoning_effort': '<effort>'})" for Codex rows),
// indexScore (0-1 composite of DeepSWE v1.1 + Terminal-Bench 4.0 +
// SWE-Atlas-QnA) and mean.costUsd (avg $/task). Score = indexScore*100.
// No browser needed: parse the embedded JSON from the fetched HTML.
// Combo rows ("A + B", e.g. Devin Fusion dual-model) are dropped loudly -
// they name two purchasable models under one score, so neither the matcher
// (which would attribute the score to the first-named model) nor the winner
// logic may claim them.
// Fixture: tests/fixtures/aa-coding-2026-10-16.html (scrape.do L1).
// Decode Flight string chunks before inspecting objects. Balanced JSON extraction
// keeps a row's null/missing fields from borrowing the NEXT row's metrics.
function parseAACodingHTML(html) {
  const chunks = [...String(html).matchAll(/self\.__next_f\.push\((\[[\s\S]*?\])\)<\/script>/g)]
    .map((m) => { try { const v = JSON.parse(m[1]); return typeof v[1] === "string" ? v[1] : ""; } catch { return ""; } });
  const text = chunks.length ? chunks.join("") : String(html);
  const starts = /\{"id":"[^"\n]+","isDefault":/g;
  const results = [], seen = new Set(), comboDropped = [];
  let match;
  while ((match = starts.exec(text))) {
    let depth = 0, quoted = false, escaped = false, end = -1;
    for (let i = match.index; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') quoted = false;
      } else if (c === '"') quoted = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) { end = i + 1; break; }
    }
    if (end < 0) continue;
    starts.lastIndex = end;
    let row;
    try { row = JSON.parse(text.slice(match.index, end)); } catch { continue; }
    if (!row.displayLabel || !row.display?.model || seen.has(row.id)) continue;
    seen.add(row.id);
    if (row.displayLabel.includes(" + ")) { comboDropped.push(row.displayLabel); continue; }
    if (typeof row.indexScore !== "number" || !Number.isFinite(row.indexScore)) continue;
    // Effort belongs to the labelled configuration, not to a model suffix
    // (Qwen3.8 Max is a model name). Some display.model values omit effort.
    let config = row.displayLabel.replace(/^.*? - /, "").replace(/\s*\(with fallback\)\s*$/i, "");
    const effort = config.match(/reasoning_effort['"]?:\s*['"](max|xhigh|high|medium|low|minimal)['"]/i)?.[1]?.toLowerCase()
      ?? config.match(/\((max|xhigh|high|medium|low|minimal)\)/i)?.[1]?.toLowerCase() ?? null;
    config = config.replace(/\s*\(\{[^}]*\}\)/g, "").replace(/\s*\((max|xhigh|high|medium|low|minimal)\)/gi, "").trim();
    const mean = row.mean ?? {};
    results.push({
      rawName: row.displayLabel, model: config, effort,
      score: round(row.indexScore * 100, 1),
      costPerTask: typeof mean.costUsd === "number" && Number.isFinite(mean.costUsd) ? round(mean.costUsd, 2) : null,
      steps: typeof mean.steps === "number" ? round(mean.steps, 1) : null,
      inputTokens: typeof mean.inputTokens === "number" ? Math.round(mean.inputTokens) : null,
      outputTokens: typeof mean.outputTokens === "number" ? Math.round(mean.outputTokens) : null,
      isDefault: row.isDefault,
    });
  }
  if (comboDropped.length) console.log(`AA coding combo rows dropped (dual-model, unattributable): ${comboDropped.join(" | ")}`);
  if (!results.length) throw new Error("Could not parse AA Coding Agent Index board");
  return results;
}

async function scrapeAACoding() {
  const response = await fetch(CONFIG.urls.codingAgents, {
    headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
  });
  if (!response.ok) throw new Error(`AA Coding Agents HTTP ${response.status}`);
  return parseAACodingHTML(await response.text());
}

async function scrapeIntelligenceIndex(browser) {
  const page = await browser.newPage();
  await page.goto(CONFIG.urls.intelligenceIndex, { waitUntil: "networkidle", timeout: 120_000 });
  const rows = await page.evaluate(() => {
    const table = document.querySelector("table");
    if (!table) return [];
    return Array.from(table.querySelectorAll("tbody tr")).map((tr) =>
      Array.from(tr.querySelectorAll("td")).map((td) => td.innerText.trim()));
  });
  await page.close();
  const results = [];
  for (const r of rows) {
    if (r.length < 5) continue;
    const rawName = r[0];
    const score = Number(r[3]);
    const cost = Number(r[4].replace("$", ""));
    const speed = Number(r[5]) || null;
    const latency = Number(r[6]) || null;
    if (isNaN(score) || isNaN(cost)) continue;
    const { model, effort } = splitConfig(rawName);
    results.push({ rawName, model, effort, score, costPerTask: cost, speed, latency });
  }
  if (!results.length) throw new Error("Could not extract Intelligence Index data");
  return results;
}

function attachOpenRouter(results, openRouterModels) {
  // Dedupe on canonical key (openRouterId + effort), keeping the best score -
  // the AA board can list the same model twice (e.g. duplicate rows).
  // Resolution outcomes per row:
  // - alias hit: normal entry with OpenRouter pricing.
  // - eval name (camellia, yoda, ...): DROPPED with a loud log line.
  // - unmatched (new model, no alias yet): KEPT as its own entry under a
  //   synthetic "unmatched:<slug>" id (AA score + AA $/task intact, raw AA
  //   name displayed). Never forced onto the closest old alias - that
  //   mislabeling is the bug this hardening kills. The fail-loud guards in
  //   main() catch unmatched TOP models; the console log below gives the
  //   one-line alias to add for everything else.
  const evalDropped = [];
  const best = new Map();
  for (const candidate of results) {
    const res = findOpenRouterModel(candidate.model, openRouterModels);
    let out;
    if (res.kind === "alias") {
      const openRouter = res.model;
      out = { ...candidate, openRouterId: openRouter?.id ?? null, effortSupported: effortIsSupported(candidate, openRouter) };
      if (openRouter) {
        out.orPromptPerMillion = openRouter.promptPerMillion;
        out.orCompletionPerMillion = openRouter.completionPerMillion;
      }
    } else if (res.kind === "eval") {
      evalDropped.push(candidate.rawName);
      continue;
    } else {
      out = toUnmatchedEntry(candidate);
    }
    if (!out.openRouterId || !out.effortSupported) continue;
    const k = out.openRouterId + "|" + (out.effort ?? "default");
    if (!best.has(k) || out.score > best.get(k).score) best.set(k, out);
  }
  if (evalDropped.length) console.log(`eval names dropped (leaderboard-only, no model): ${[...new Set(evalDropped)].join(" | ")}`);
  const unmatchedKept = [...best.values()].filter((x) => x.openRouterId.startsWith("unmatched:"));
  if (unmatchedKept.length) {
    console.log(`UNMATCHED MODELS KEPT AS OWN ENTRIES (${unmatchedKept.length}) - add aliases:`);
    for (const u of unmatchedKept) {
      const suggested = normalizeModelName(u.model).replace(/\s+/g, "-");
      console.log(`  UNMATCHED: "${u.rawName}" -> ${u.openRouterId} | suggested alias key: "${suggested}" (pair with its OpenRouter id)`);
    }
  }
  return [...best.values()];
}


async function fetchECI() {
  const res = await fetch(CONFIG.urls.eci, { headers: { "User-Agent": "use-this-model refresh (+https://usethismodel.vercel.app)" } });
  if (!res.ok) throw new Error(`Epoch ECI HTTP ${res.status}`);
  return parseECICSV(await res.text());
}

// Keep only rows resolved to a real OpenRouter id (alias hits). Unmatched
// names are logged by attachOpenRouter (add an alias row to include them);
// they can never be published because they have no catalog price.
const matchedOnly = (pool) => pool.filter((x) => x.openRouterId && !x.openRouterId.startsWith("unmatched:"));

async function main() {
  const failLoud = (msg) => { console.error("REFRESH FAILED (nothing published): " + msg); process.exit(1); };
  console.log("Fetching OpenRouter catalog...");
  const catalog = (await getOpenRouterModels()).filter((m) => !m.id.includes(":"));
  console.log(`OpenRouter: ${catalog.length} models`);

  const settled = {};
  const tasks = {
    eci: fetchECI(),
    aac: scrapeAACoding(),
    da: scrapeDesignArena().then((rows) => rows.map((r) => ({ ...r, score: r.elo }))), // raw Elo; normalized in models-data
    vibe: fetchVALSBench(VALS_BENCHES[0]),
    vcb: fetchVALSBench(VALS_BENCHES[1]),
    swe: fetchVALSBench(VALS_BENCHES[2]),
  };
  for (const [k, p] of Object.entries(tasks)) {
    try { settled[k] = await p; console.log(`${k}: ${settled[k].length} rows`); }
    catch (e) { settled[k] = null; console.warn(`${k} fetch failed: ${e.message}`); }
  }
  console.log("Launching browser for AA Intelligence Index...");
  const browser = await chromium.launch({ headless: true });
  try { settled.aai = await scrapeIntelligenceIndex(browser); console.log(`aai: ${settled.aai.length} rows`); }
  catch (e) { settled.aai = null; console.warn(`aai fetch failed: ${e.message}`); }
  finally { await browser.close(); }

  // Required sources: ECI (the recommended default) and AA Intelligence.
  // Every other source may degrade (its scores are simply absent for a day,
  // which the per-category missing-data mode already handles), but at least
  // one coding source must be present.
  if (!settled.eci?.length) failLoud("Epoch ECI fetch returned no rows");
  if (!settled.aai?.length) failLoud("AA Intelligence Index returned no rows");
  if (!["aac", "da", "vibe", "vcb", "swe"].some((k) => settled[k]?.length)) failLoud("every coding source failed");
  const down = Object.entries(settled).filter(([, v]) => !v?.length).map(([k]) => k);
  if (down.length) console.warn(`REFRESH WARNING: sources down today (scores omitted): ${down.join(", ")}`);

  const boards = {};
  for (const [k, rows] of Object.entries(settled)) {
    boards[k] = rows ? matchedOnly(attachOpenRouter(rows, catalog)).map((r) => ({ openRouterId: r.openRouterId, score: r.score, effort: r.effort ?? null })) : [];
  }
  let data;
  try {
    data = buildModelsData({ boards, catalog, generatedUtc: new Date().toISOString() });
  } catch (e) { failLoud(e.message); }
  // Partial-outage sources keep their registry entry but report models: 0.
  mkdirSync(OUT, { recursive: true });
  const tmp = `${OUT}/models.json.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 1) + "\n");
  renameSync(tmp, `${OUT}/models.json`);
  const per = Object.entries(data.benchmarks).map(([k, b]) => `${k}=${b.models}`).join(" ");
  console.log(`wrote ${OUT}/models.json: ${data.models.length} models (${per})`);
}

const SHOULD_RUN = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (SHOULD_RUN) main().catch((error) => { console.error(error); process.exit(1); });

// Test seam: unit tests import the pure matcher + parsers without network.
export { normalizeModelName, versionSig, tokenSet, aliasHits, MODEL_ALIASES, findOpenRouterModel, toUnmatchedEntry, attachOpenRouter, parseAACodingHTML, parseVALSJson, VALS_BENCHES, matchedOnly };
