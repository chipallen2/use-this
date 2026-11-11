// scripts/models-data.mjs - the data layer: turns matched benchmark rows +
// the OpenRouter price catalog into the published models.json.
//
// Pure (no I/O) so it is unit-tested directly (tests/models-data.test.mjs).
//
// NORMALIZATION (the one standard method, documented on /docs):
//   For each benchmark, take each model's raw score (best configuration /
//   reasoning effort when a board lists several), then min-max rescale over
//   the models we publish for that benchmark:
//       score = 100 * (raw - min) / (max - min), rounded to 0.1
//   The best published model on a benchmark is 100, the weakest is 0.
//   (max == min -> every model scores 100.) Users never choose a method.
//
// PRICE: input and output USD per 1M tokens from the OpenRouter catalog for
// the model's OpenRouter id. A published model with no valid input price is
// a data error: buildModelsData throws and nothing is published.

import { BENCHMARKS, BENCHMARK_KEYS } from "../lib/calc.mjs";

export const DATA_SCHEMA = 1;
export const NORMALIZATION =
  "Per benchmark: min-max over published models. score = 100 * (raw - min) / (max - min), rounded to 0.1. Best published model = 100, weakest = 0.";

const sig6 = (n) => Number(Number(n).toPrecision(6));
const round1 = (n) => Math.round(n * 10) / 10;

export function normalizeBoard(rawById) {
  const vals = [...rawById.values()];
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const out = new Map();
  for (const [id, raw] of rawById) out.set(id, hi > lo ? round1(((raw - lo) / (hi - lo)) * 100) : 100);
  return { norm: out, min: lo, max: hi };
}

const validPrice = (p) => typeof p === "number" && Number.isFinite(p) && p >= 0;

function splitName(orName, id) {
  const m = String(orName || "").match(/^([^:]+):\s*(.+)$/);
  if (m) return { org: m[1].trim(), name: m[2].trim() };
  return { org: id.split("/")[0], name: orName || id };
}

// boards: { [benchKey]: [{ openRouterId, score (raw), effort? }] } - rows
//   already matched to OpenRouter ids (unmatched rows must be dropped first).
// catalog: [{ id, name, promptPerMillion, completionPerMillion }]
export function buildModelsData({ boards, catalog, generatedUtc }) {
  const byId = new Map(catalog.map((m) => [m.id, m]));
  // best raw per (bench, id)
  const best = {};
  for (const key of BENCHMARK_KEYS) {
    const m = new Map();
    for (const r of boards[key] || []) {
      if (!r.openRouterId || r.openRouterId.startsWith("unmatched:")) throw new Error(`${key}: unmatched row reached buildModelsData (${r.openRouterId})`);
      if (!Number.isFinite(r.score)) continue;
      const cur = m.get(r.openRouterId);
      if (!cur || r.score > cur.score) m.set(r.openRouterId, { score: r.score, effort: r.effort ?? null });
    }
    // Contributor twins: OpenRouter sells some identical weights under a
    // "-contributor" id at a different price; they inherit the base scores.
    for (const [id, v] of [...m]) {
      const twin = `${id}-contributor`;
      if (byId.has(twin) && !m.has(twin)) m.set(twin, { ...v });
    }
    best[key] = m;
  }
  const ids = [...new Set(BENCHMARK_KEYS.flatMap((k) => [...best[k].keys()]))].sort();
  const priceErrors = [];
  for (const id of ids) {
    const or = byId.get(id);
    if (!or) priceErrors.push(`${id}: not in OpenRouter catalog`);
    else if (!validPrice(or.promptPerMillion)) priceErrors.push(`${id}: invalid input price ${or.promptPerMillion}`);
  }
  if (priceErrors.length) {
    throw new Error(`MISSING INPUT PRICE for ${priceErrors.length} model(s) - refusing to publish:\n  ${priceErrors.join("\n  ")}`);
  }
  const benchmarks = {};
  const normById = {};
  for (const b of BENCHMARKS) {
    const raw = new Map([...best[b.key]].map(([id, v]) => [id, v.score]));
    if (!raw.size) { benchmarks[b.key] = { name: b.name, source: b.source, url: b.url, models: 0, raw_min: null, raw_max: null }; normById[b.key] = new Map(); continue; }
    const { norm, min, max } = normalizeBoard(raw);
    normById[b.key] = norm;
    benchmarks[b.key] = { name: b.name, source: b.source, url: b.url, models: raw.size, raw_min: min, raw_max: max };
  }
  const models = ids.map((id) => {
    const or = byId.get(id);
    const { org, name } = splitName(or.name, id);
    const scores = {}, raw = {}, effort = {};
    for (const k of BENCHMARK_KEYS) {
      const v = best[k].get(id);
      if (!v) continue;
      scores[k] = normById[k].get(id);
      raw[k] = v.score;
      if (v.effort) effort[k] = v.effort;
    }
    const out = { id, name, org, input: sig6(or.promptPerMillion), output: validPrice(or.completionPerMillion) ? sig6(or.completionPerMillion) : null, scores, raw };
    if (Object.keys(effort).length) out.effort = effort;
    return out;
  });
  const data = { schema: DATA_SCHEMA, generated_utc: generatedUtc, normalization: NORMALIZATION, price: "input/output = USD per 1M tokens, OpenRouter list price", benchmarks, models };
  validateModelsData(data);
  return data;
}

// Structural check run before publishing AND by tests on the committed file.
export function validateModelsData(data) {
  const errs = [];
  if (!data || data.schema !== DATA_SCHEMA) errs.push("bad schema");
  if (!Array.isArray(data?.models) || !data.models.length) errs.push("no models");
  if (typeof data?.generated_utc !== "string" || Number.isNaN(Date.parse(data.generated_utc))) errs.push("bad generated_utc");
  const seen = new Set();
  for (const m of data?.models || []) {
    if (!m.id || seen.has(m.id)) errs.push(`duplicate/missing id ${m.id}`);
    seen.add(m.id);
    if (!validPrice(m.input)) errs.push(`${m.id}: missing input price`);
    if (m.output != null && !validPrice(m.output)) errs.push(`${m.id}: bad output price`);
    const ks = Object.keys(m.scores || {});
    if (!ks.length) errs.push(`${m.id}: no scores`);
    for (const k of ks) {
      if (!BENCHMARK_KEYS.includes(k)) errs.push(`${m.id}: unknown benchmark ${k}`);
      const s = m.scores[k];
      if (!(Number.isFinite(s) && s >= 0 && s <= 100)) errs.push(`${m.id}: ${k} score ${s} outside 0-100`);
    }
  }
  if (errs.length) throw new Error("models.json invalid - refusing to publish:\n  " + errs.slice(0, 40).join("\n  "));
  return true;
}

// Minimal RFC-4180 CSV parser (quoted fields, embedded commas/quotes/newlines).
export function parseCSV(text) {
  const rows = [];
  let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows.filter((r) => r.length > 1 || r[0] !== "");
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}

// Epoch AI ECI CSV (https://epoch.ai/data/eci_scores.csv, CC-BY 4.0).
// Columns: Model, Display name, eci, eci_ci_low, eci_ci_high, date, ...
export function parseECICSV(text) {
  const rows = parseCSV(text);
  if (!rows.length || !("Model" in rows[0]) || !("eci" in rows[0])) throw new Error("ECI CSV: missing Model/eci columns");
  const out = [];
  for (const r of rows) {
    const eci = Number(r.eci);
    const name = (r.Model || r["Display name"] || "").trim();
    if (!name || r.eci === "" || !Number.isFinite(eci)) continue;
    out.push({ rawName: name, model: name, effort: null, score: eci });
  }
  if (out.length < 20) throw new Error(`ECI CSV: only ${out.length} usable rows`);
  return out;
}
