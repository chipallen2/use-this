// lib/calc.mjs - the ONE calculation module for Use This Model.
//
// Pure ES module, no dependencies, no I/O. It is imported unchanged by:
//   - the browser (copied to dist/calc.mjs by scripts/render.mjs)
//   - the bot endpoint (api/picks.mjs, Vercel serverless function)
//   - the data refresh (scripts/scrape.mjs uses BENCHMARKS)
//   - the tests (tests/calc.test.mjs)
// so the UI and bots always compute identical picks from identical settings.
//
// Settings format v1 (all settings live in the URL query string):
//   v=1                     optional; omitted means 1
//   chat=eci                benchmarks for a category: key[:weight],...
//   chat_max=2              max input price, USD per 1M input tokens
//   chat_min=60             min score, 0-100 (normalized scale)
//   chat_miss=exclude       missing-data mode: exclude | reweight | zero
//   chat_cov=50             reweight only: min % of chosen weight a model must cover
//   chat_lock=<model id>    optional: pin this category to one model
// Same params for `code` and `crazy`. Keys starting with utm_ are ignored.
// Full reference: /docs (rendered from the same constants below).
//
// v1 is a frozen contract: URLs saved today must keep meaning the same thing.
// Any breaking change ships as v=2 and v=1 parsing stays as-is.

export const SETTINGS_VERSION = 1;
export const SITE_URL = "https://usethismodel.vercel.app";
export const DOCS_PATH = "/docs";
export const DOCS_URL = SITE_URL + DOCS_PATH;
export const API_PATH = "/api/picks";

export const CATEGORIES = [
  { key: "chat", title: "Chatting", blurb: "Best for everyday chats" },
  { key: "code", title: "Everyday Coding", blurb: "Best for normal coding" },
  { key: "crazy", title: "Crazy Hard Coding", blurb: "Best pick for really hard coding tasks" },
];
export const CATEGORY_KEYS = CATEGORIES.map((c) => c.key);

// Benchmark registry. Keys are part of the URL contract - never rename one.
// New benchmarks may be added; a removed source keeps its key (models simply
// stop having scores for it, handled by the missing-data mode).
export const BENCHMARKS = [
  { key: "eci", name: "Epoch Capabilities Index (ECI)", source: "Epoch AI", url: "https://epoch.ai/benchmarks/eci", about: "Epoch AI's composite capability score, stitched across dozens of benchmarks with item-response theory. General capability." },
  { key: "aai", name: "Artificial Analysis Intelligence Index", source: "Artificial Analysis", url: "https://artificialanalysis.ai/leaderboards/models", about: "Artificial Analysis' composite of reasoning, knowledge, math and coding evals. General capability." },
  { key: "aac", name: "Artificial Analysis Coding Agent Index", source: "Artificial Analysis", url: "https://artificialanalysis.ai/agents/coding-agents", about: "Agentic coding (DeepSWE, Terminal-Bench, SWE-Atlas QnA) run inside coding-agent harnesses. Best configuration per model." },
  { key: "da", name: "Design Arena Frontend (Elo)", source: "Design Arena", url: "https://www.designarena.ai/leaderboard?section=agentic-web-dev", about: "Human-preference Elo for agent-built web apps (rows with 500+ battles)." },
  { key: "vibe", name: "Vals AI Vibe Code", source: "Vals AI", url: "https://vals.ai/benchmarks/vibe-code", about: "Build-an-app-from-a-prompt coding accuracy." },
  { key: "vcb", name: "Vals AI VCB 1-100", source: "Vals AI", url: "https://vals.ai/benchmarks/vcb-1-100", about: "Vals coding benchmark accuracy." },
  { key: "swe", name: "Vals AI SWE-bench Multimodal", source: "Vals AI", url: "https://vals.ai/benchmarks/swebench-multimodal", about: "SWE-bench Multimodal accuracy (visual software issues)." },
];
export const BENCHMARK_KEYS = BENCHMARKS.map((b) => b.key);
export const benchmarkByKey = (k) => BENCHMARKS.find((b) => b.key === k) || null;

export const MISS_MODES = ["exclude", "reweight", "zero"];
export const DEFAULT_MISS = "exclude";

// Recommended defaults, used ONLY to prefill the landing-page form. They are
// never applied implicitly: a settings URL always spells out its values, so
// changing these later never changes what an existing link means.
export const RECOMMENDED = {
  chat: { bench: [{ key: "eci", w: 1 }], max: 1, min: 65, miss: "exclude", cov: null, lock: null },
  code: { bench: [{ key: "eci", w: 1 }], max: 3, min: 80, miss: "exclude", cov: null, lock: null },
  crazy: { bench: [{ key: "eci", w: 1 }], max: 15, min: 95, miss: "exclude", cov: null, lock: null },
};

const NUM_RE = /^(\d+(\.\d+)?|\.\d+)$/;
const LOCK_RE = /^[A-Za-z0-9._~:\/-]{1,120}$/;
const round1 = (n) => Math.round(n * 10) / 10;

function paramEntries(input) {
  if (input == null) return [];
  if (typeof input === "string") {
    const q = input.includes("?") ? input.slice(input.indexOf("?") + 1) : input;
    return [...new URLSearchParams(q.split("#")[0]).entries()];
  }
  if (typeof input.entries === "function" && !(input.constructor === Object)) return [...input.entries()];
  return Object.entries(input).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, String(x)]) : [[k, String(v)]]));
}

function allowedParam(k) {
  if (k === "v") return true;
  return CATEGORY_KEYS.some((c) => [c, `${c}_max`, `${c}_min`, `${c}_miss`, `${c}_cov`, `${c}_lock`].includes(k));
}

// Parse `eci:2,aac:1` -> [{key, w}]. Errors are pushed into `errs`.
export function parseBenchList(raw, param, errs) {
  const out = [];
  const parts = String(raw).split(",").map((s) => s.trim()).filter(Boolean);
  if (!parts.length) { errs.push({ param, problem: "must list at least one benchmark, e.g. eci or eci:2,aac:1" }); return null; }
  for (const p of parts) {
    const [key, wRaw, extra] = p.split(":");
    if (extra !== undefined) { errs.push({ param, problem: `"${p}" is not key or key:weight` }); return null; }
    const k = key.toLowerCase();
    if (!BENCHMARK_KEYS.includes(k)) { errs.push({ param, problem: `unknown benchmark "${key}" (valid: ${BENCHMARK_KEYS.join(", ")})` }); return null; }
    if (out.some((b) => b.key === k)) { errs.push({ param, problem: `benchmark "${k}" listed twice` }); return null; }
    let w = 1;
    if (wRaw !== undefined) {
      if (!NUM_RE.test(wRaw) || !(Number(wRaw) > 0) || Number(wRaw) > 100) { errs.push({ param, problem: `weight for "${k}" must be a number > 0 and <= 100` }); return null; }
      w = Number(wRaw);
    }
    out.push({ key: k, w });
  }
  return out;
}

function parseNum(raw, param, lo, hi, errs, what) {
  if (raw == null || raw === "") { errs.push({ param, problem: `missing (${what})` }); return null; }
  if (!NUM_RE.test(raw)) { errs.push({ param, problem: `"${raw}" is not a number (${what})` }); return null; }
  const n = Number(raw);
  if (n < lo || n > hi) { errs.push({ param, problem: `must be between ${lo} and ${hi} (${what})` }); return null; }
  return n;
}

// Parse + validate URL settings. Accepts a query string, URLSearchParams, or
// a plain object. Returns { empty, ok, settings, errors }.
//   empty  - no settings params at all (landing page / bot 400)
//   ok     - settings fully valid
//   errors - [{param, problem}] naming every missing/invalid setting
export function parseSettings(input) {
  const entries = paramEntries(input).filter(([k]) => !k.startsWith("utm_"));
  if (!entries.length) return { empty: true, ok: false, settings: null, errors: [{ param: "(none)", problem: "no settings given; every category needs benchmarks, a max price and a min score" }] };
  const errors = [];
  const map = new Map();
  for (const [k, v] of entries) {
    if (!allowedParam(k)) { errors.push({ param: k, problem: "unknown parameter" }); continue; }
    if (map.has(k)) { errors.push({ param: k, problem: "given more than once" }); continue; }
    map.set(k, v);
  }
  if (map.has("v") && map.get("v") !== "1") errors.push({ param: "v", problem: `unsupported settings version "${map.get("v")}" (supported: 1)` });
  const settings = { v: SETTINGS_VERSION };
  for (const c of CATEGORY_KEYS) {
    const cat = { bench: null, max: null, min: null, miss: DEFAULT_MISS, cov: null, lock: null };
    if (!map.has(c)) errors.push({ param: c, problem: "missing (benchmarks, e.g. eci or eci:2,aai:1)" });
    else cat.bench = parseBenchList(map.get(c), c, errors);
    cat.max = parseNum(map.get(`${c}_max`), `${c}_max`, 0, 1000, errors, "max input price, USD per 1M tokens");
    cat.min = parseNum(map.get(`${c}_min`), `${c}_min`, 0, 100, errors, "min score, 0-100");
    if (map.has(`${c}_miss`)) {
      const m = map.get(`${c}_miss`).toLowerCase();
      if (!MISS_MODES.includes(m)) errors.push({ param: `${c}_miss`, problem: `must be one of ${MISS_MODES.join(", ")}` });
      else cat.miss = m;
    }
    if (map.has(`${c}_cov`)) {
      if (cat.miss !== "reweight") errors.push({ param: `${c}_cov`, problem: `only valid with ${c}_miss=reweight` });
      else cat.cov = parseNum(map.get(`${c}_cov`), `${c}_cov`, 0, 100, errors, "min weight coverage %");
    }
    if (map.has(`${c}_lock`)) {
      const l = map.get(`${c}_lock`);
      if (!LOCK_RE.test(l)) errors.push({ param: `${c}_lock`, problem: "must be a model id like anthropic/claude-opus-5.5" });
      else cat.lock = l;
    }
    settings[c] = cat;
  }
  return { empty: false, ok: errors.length === 0, settings: errors.length ? null : settings, errors };
}

// Canonical, readable query string (commas/colons/slashes left unescaped).
export function serializeSettings(settings, { includeLocks = true } = {}) {
  const enc = (s) => encodeURIComponent(String(s)).replace(/%2C/gi, ",").replace(/%3A/gi, ":").replace(/%2F/gi, "/");
  const parts = [];
  for (const c of CATEGORY_KEYS) {
    const cat = settings[c];
    parts.push(`${c}=${enc(cat.bench.map((b) => (b.w === 1 ? b.key : `${b.key}:${b.w}`)).join(","))}`);
    parts.push(`${c}_max=${enc(cat.max)}`);
    parts.push(`${c}_min=${enc(cat.min)}`);
    if (cat.miss && cat.miss !== DEFAULT_MISS) parts.push(`${c}_miss=${cat.miss}`);
    if (cat.miss === "reweight" && cat.cov != null) parts.push(`${c}_cov=${enc(cat.cov)}`);
    if (includeLocks && cat.lock) parts.push(`${c}_lock=${enc(cat.lock)}`);
  }
  return parts.join("&");
}

export function settingsUrl(settings, base = SITE_URL + "/", opts) {
  return base + "?" + serializeSettings(settings, opts);
}

// Combined 0-100 score of one model for one category's settings.
// Returns { score, coverage, missing, reason }; score null = not ranked.
//   exclude : any chosen benchmark missing -> not ranked
//   reweight: weighted mean over present benchmarks only; optional cov% floor
//   zero    : missing benchmarks count as 0
// In every mode a model with no score on ANY chosen benchmark is not ranked.
export function scoreModel(model, cat) {
  const scores = model.scores || {};
  const totalW = cat.bench.reduce((a, b) => a + b.w, 0);
  const present = cat.bench.filter((b) => Number.isFinite(scores[b.key]));
  const missing = cat.bench.filter((b) => !Number.isFinite(scores[b.key])).map((b) => b.key);
  const presW = present.reduce((a, b) => a + b.w, 0);
  const coverage = totalW > 0 ? round1((presW / totalW) * 100) : 0;
  if (!present.length) return { score: null, coverage, missing, reason: "no data on chosen benchmarks" };
  const sum = present.reduce((a, b) => a + b.w * scores[b.key], 0);
  if (cat.miss === "exclude") {
    if (missing.length) return { score: null, coverage, missing, reason: `missing ${missing.join(", ")}` };
    return { score: round1(sum / totalW), coverage, missing, reason: null };
  }
  if (cat.miss === "zero") return { score: round1(sum / totalW), coverage, missing, reason: null };
  if (cat.cov != null && coverage < cat.cov) return { score: null, coverage, missing, reason: `covers ${coverage}% of weight (< ${cat.cov}%)` };
  return { score: round1(sum / presW), coverage, missing, reason: null };
}

const byPrice = (a, b) => a.model.input - b.model.input || b.score - a.score || (a.model.id < b.model.id ? -1 : a.model.id > b.model.id ? 1 : 0);

// Pick for one category: cheapest input price among models whose score is
// >= min AND whose input price <= max (ties: higher score, then id).
// A lock overrides the pick with exactly the named model.
export function pickCategory(models, cat) {
  const rows = models.map((m) => ({ model: m, ...scoreModel(m, cat) }));
  const scored = rows.filter((r) => r.score != null);
  const qualifying = scored.filter((r) => r.score >= cat.min && r.model.input <= cat.max).sort(byPrice);
  let winner = qualifying[0] || null;
  let locked = false, lockedMissing = false;
  if (cat.lock) {
    locked = true;
    const row = rows.find((r) => r.model.id === cat.lock);
    if (row) winner = row;
    else {
      lockedMissing = true;
      winner = { model: { id: cat.lock, name: cat.lock, org: null, input: null, output: null, scores: {} }, score: null, coverage: 0, missing: [], reason: "not in current data" };
    }
  }
  return { winner, locked, lockedMissing, qualifying, scored, unscored: rows.filter((r) => r.score == null) };
}

export function computePicks(data, settings) {
  const out = {};
  for (const c of CATEGORY_KEYS) out[c] = pickCategory(data.models, settings[c]);
  return out;
}

const pubModel = (r) => r && {
  id: r.model.id, name: r.model.name, org: r.model.org,
  input_usd_per_1m: r.model.input, output_usd_per_1m: r.model.output,
  score: r.score,
};

// JSON shape returned by the bot endpoint (and get_picks in the page).
export function picksResponse(data, settings, base = SITE_URL + "/") {
  const picks = computePicks(data, settings);
  const categories = {};
  for (const c of CATEGORIES) {
    const p = picks[c.key], s = settings[c.key];
    const status = p.locked ? (p.lockedMissing ? "locked-model-not-in-data" : "locked") : p.winner ? "ok" : "no-model-qualifies";
    categories[c.key] = {
      title: c.title,
      status,
      model: pubModel(p.winner),
      qualifying_count: p.qualifying.length,
      runners_up: p.qualifying.filter((r) => !p.winner || r.model.id !== p.winner.model.id).slice(0, 3).map(pubModel),
      settings: { benchmarks: s.bench.map((b) => ({ key: b.key, weight: b.w })), max_input_usd_per_1m: s.max, min_score: s.min, missing_data: s.miss, min_coverage_pct: s.cov, lock: s.lock },
    };
  }
  return {
    v: SETTINGS_VERSION,
    data_updated_utc: data.generated_utc,
    url: settingsUrl(settings, base),
    docs: DOCS_URL,
    price_note: "Prices are USD per 1M INPUT tokens. Real cost also depends on output tokens and how verbose the model is.",
    categories,
  };
}

export function errorResponse(errors) {
  return {
    error: "invalid_settings",
    message: "Missing or invalid settings. Every category (chat, code, crazy) needs benchmarks, a max price and a min score.",
    errors,
    docs: DOCS_URL,
    example: `${SITE_URL}${API_PATH}?${serializeSettings(RECOMMENDED)}`,
  };
}
