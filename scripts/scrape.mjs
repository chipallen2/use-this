// scripts/scrape.mjs — solidified model-selector. No LLM calls. No tokens.
// Scrapes DeepSWE + AA Intelligence Index + OpenRouter catalog,
// applies locked thresholds (agent 90%, everyday 90% DeepSWE, hard 97% DeepSWE),
// writes candidates.json + picks.json to stdout dir.
// Usage: node scripts/scrape.mjs [outdir]

import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "fs";

const OUT = process.argv[2] || "data";

const CONFIG = {
  agentMinQuality: 0.90,
  everydayCodingMinQuality: 0.90,
  hardCodingMinQuality: 0.97,
  urls: {
    deepSWE: "https://deepswe.datacurve.ai/",
    intelligenceIndex: "https://artificialanalysis.ai/leaderboards/models",
    openRouter: "https://openrouter.ai/api/v1/models",
    designArena: "https://www.designarena.ai/api/leaderboard",
  },
  designArenaBody: { arenaType: "agents", category: "agon_webapps", variationName: "public", inputModality: "text" },
};

const round = (n, digits = 2) => Number(Number(n).toFixed(digits));

const normalizeModelName = (name) =>
  name.toLowerCase().replaceAll("adaptive reasoning", "").replaceAll("effort", "")
    .replace(/[()[\]]/g, " ").replace(/\s+/g, " ").trim();

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

function findOpenRouterModel(modelName, openRouterModels) {
  const needle = normalizeModelName(modelName);
  const aliases = [
    ["gpt-6-astra", "openai/gpt-6-astra"],
    ["gpt-6-sol", "openai/gpt-6-sol"],
    ["gpt-5.6-sol-pro", "openai/gpt-5.6-sol-pro"],
    ["gpt-5.6-sol", "openai/gpt-5.6-sol"],
    ["gpt-5.6-luna-pro", "openai/gpt-5.6-luna-pro"],
    ["gpt-5.6-luna", "openai/gpt-5.6-luna"],
    ["gpt-5.6-terra", "openai/gpt-5.6-terra"],
    ["gpt-5.5-pro", "openai/gpt-5.5-pro"],
    ["claude-opus-5", "anthropic/claude-opus-5"],
    ["claude-fable-5", "anthropic/claude-fable-5"],
    ["claude-sonnet-5", "anthropic/claude-sonnet-5"],
    ["gemini-3.8-flash", "google/gemini-3.8-flash"],
    ["gemini-3.7-flash", "google/gemini-3.7-flash"],
    ["gemini-2.5-flash-lite", "google/gemini-2.5-flash-lite"],
    ["gemini-2.5-flash", "google/gemini-2.5-flash"],
    ["glm-5.3-flash", "z-ai/glm-5.3-flash"],
    ["glm-5.3", "z-ai/glm-5.3"],
    ["grok-4.6", "x-ai/grok-4.6"],
    ["kimi-k3", "moonshotai/kimi-k3"],
    ["qwen3.8-flash-next", "qwen/qwen3.8-flash-next"],
    ["qwen3.8-max", "qwen/qwen3.8-max-0902"],
    ["qwen3.8", "qwen/qwen3.8-max-0902"],
    ["minimax-m3", "minimax/minimax-m3"],
    ["gpt-5.6-sol-xhigh", "openai/gpt-5.6-sol"],
    ["gpt-5.6-sol-pro", "openai/gpt-5.6-sol-pro"],
    ["muse-spark-1.3", "meta/muse-spark-1.3"],
    ["kimi-k2.7-code", "moonshotai/kimi-k2.7-code"],
    ["qwen3.7-max", "qwen/qwen3.7-max"],
    ["camellia", null],
    ["solar-pro4-direct", null],
    ["yoda", null],
    ["evergreen", null],
    ["grogu", null],
    ["deepseek-v4-pro", "deepseek/deepseek-v4-pro"],
    ["muse-spark", "meta/muse-spark"],
  ];
  for (const [key, idPrefix] of aliases) {
    if (needle.includes(key)) {
      const hit = openRouterModels.find((m) => m.id === idPrefix || m.id.startsWith(`${idPrefix}`));
      if (hit) return hit;
    }
  }
  const words = needle.replace(/claude|gpt|gemini|grok|glm|kimi|qwen|deepseek/g, "").split(" ").filter((x) => x.length >= 2);
  return openRouterModels.map((model) => {
    const haystack = normalizeModelName(`${model.id} ${model.name}`);
    const matches = words.filter((word) => haystack.includes(word)).length;
    return { model, score: words.length ? matches / words.length : 0 };
  }).sort((a, b) => b.score - a.score)[0]?.model;
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
      costPerTask: null, // filled from OpenRouter blended pricing below
    }));
}

async function scrapeDeepSWE(browser) {
  const page = await browser.newPage();
  await page.goto(CONFIG.urls.deepSWE, { waitUntil: "networkidle", timeout: 120_000 });
  const allEffortButton = page.getByText("All effort levels", { exact: true });
  if (await allEffortButton.count()) {
    await allEffortButton.click();
    await page.waitForTimeout(1000);
  }
  const text = await page.locator("body").innerText();
  await page.close();
  const lines = text.split("\n").map((x) => x.trim()).filter(Boolean);
  const results = [];
  for (let i = 0; i < lines.length; i++) {
    let model = null, effort = null;
    const singleMatch = lines[i].match(/^(.+?)\[(max|xhigh|high|medium|low|minimal)]$/i);
    if (singleMatch) { model = singleMatch[1]; effort = singleMatch[2].toLowerCase(); }
    else if (i + 1 < lines.length && lines[i + 1].match(/^\[(max|xhigh|high|medium|low|minimal)]$/i)) {
      model = lines[i];
      effort = lines[i + 1].match(/^\[(max|xhigh|high|medium|low|minimal)]$/i)[1].toLowerCase();
    }
    if (!model || !effort) continue;
    let score = null, confidence = null, cost = null, outputTokens = null, steps = null;
    for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
      const scoreMatch = lines[j].match(/^([\d.]+)%\s*±\s*([\d.]+)%$/);
      if (scoreMatch && score === null) { score = Number(scoreMatch[1]); confidence = Number(scoreMatch[2]); }
      const costMatch = lines[j].match(/^\$([\d.]+)$/i) || lines[j].match(/Avg cost \$([\d.]+)/i);
      if (costMatch && cost === null) cost = Number(costMatch[1]);
      const tokenMatch = lines[j].match(/^([\d.]+)k$/i) || lines[j].match(/Out tok\s+([\d.]+)(k|m)?/i);
      if (tokenMatch && outputTokens === null) outputTokens = Number(tokenMatch[1]) * 1000;
      const stepsMatch = lines[j].match(/^(\d+)$/) || lines[j].match(/Steps\s+([\d.]+)/i);
      if (stepsMatch && steps === null && !lines[j].includes("%") && !lines[j].includes("$")) steps = Number(stepsMatch[1]);
    }
    if (score !== null && cost !== null) {
      results.push({ rawName: `${model} [${effort}]`, model, effort, score, confidence, costPerTask: cost, outputTokens, steps });
    }
  }
  if (!results.length) throw new Error("Could not parse DeepSWE leaderboard");
  return results;
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
  return results.map((candidate) => {
    const openRouter = findOpenRouterModel(candidate.model, openRouterModels);
    const out = { ...candidate, openRouterId: openRouter?.id ?? null, effortSupported: effortIsSupported(candidate, openRouter) };
    if (openRouter) {
      out.orPromptPerMillion = openRouter.promptPerMillion;
      out.orCompletionPerMillion = openRouter.completionPerMillion;
    }
    return out;
  }).filter((c) => c.openRouterId && c.effortSupported);
}

// Blend rule (locked): per canonical model (openRouterId + effort), if both
// DeepSWE and Design Arena scores present -> 50/50; only one -> use it at 100%.
// Design Arena entries carry effort=null and costPerTask=null; they inherit
// effort + cost from their DeepSWE counterpart when one exists, else effort
// stays null and cost is estimated from OpenRouter blended pricing.
function blendCodingScores(deepSWEPool, designArenaPool) {
  const byKey = new Map(); // openRouterId -> { efforts: Map(effort -> entry), design: entry|null }
  for (const d of deepSWEPool) {
    let g = byKey.get(d.openRouterId);
    if (!g) { g = { efforts: new Map(), design: null }; byKey.set(d.openRouterId, g); }
    g.efforts.set(d.effort ?? "default", d);
  }
  for (const z of designArenaPool) {
    let g = byKey.get(z.openRouterId);
    if (!g) { g = { efforts: new Map(), design: null }; byKey.set(z.openRouterId, g); }
    g.design = z;
  }
  const blended = [];
  for (const [, g] of byKey) {
    if (g.efforts.size) {
      for (const [, d] of g.efforts) {
        if (g.design) {
          blended.push({
            ...d,
            score: round((d.score + g.design.score) / 2, 1),
            sources: "50% DeepSWE + 50% Design Arena Full-Stack",
            deepScore: d.score, designScore: g.design.score, designElo: g.design.elo,
          });
        } else {
          blended.push({ ...d, sources: "DeepSWE only - no Design Arena data yet", deepScore: d.score, designScore: null, designElo: null });
        }
      }
    } else if (g.design) {
      // Design-only model: no DeepSWE effort/cost; estimate cost/task from
      // OpenRouter blended price at a nominal 20k completion + 5k prompt tokens.
      const z = g.design;
      const prompt = z.orPromptPerMillion ?? 0, completion = z.orCompletionPerMillion ?? 0;
      const estCost = round((prompt * 5000 + completion * 20000) / 1_000_000, 2);
      blended.push({
        ...z, effort: null, costPerTask: estCost,
        sources: "Design Arena only - no DeepSWE data yet", deepScore: null, designScore: z.score, designElo: z.elo,
      });
    }
  }
  return blended;
}

function pickCheapestAbove(candidates, cutoff) {
  const eligible = candidates.filter((x) => x.score >= cutoff)
    .sort((a, b) => a.costPerTask - b.costPerTask || b.score - a.score);
  if (!eligible.length) throw new Error("No eligible model at cutoff " + cutoff);
  return eligible;
}

async function main() {
  console.log("Fetching OpenRouter...");
  const openRouterModels = await getOpenRouterModels();
  console.log("Fetching Design Arena...");
  let designArenaRaw = [];
  try {
    designArenaRaw = await scrapeDesignArena();
    console.log(`Design Arena: ${designArenaRaw.length} models`);
  } catch (error) {
    console.warn("Design Arena fetch failed, continuing DeepSWE-only:", error.message);
  }
  console.log("Launching browser...");
  const browser = await chromium.launch({ headless: true });
  let deepSWERaw, intelligenceRaw;
  try {
    console.log("Fetching DeepSWE...");
    deepSWERaw = await scrapeDeepSWE(browser);
    console.log("Fetching Intelligence Index...");
    intelligenceRaw = await scrapeIntelligenceIndex(browser);
  } finally {
    await browser.close();
  }

  const deepSWEPool = attachOpenRouter(deepSWERaw, openRouterModels);
  const designPool = attachOpenRouter(designArenaRaw, openRouterModels);
  const coding = blendCodingScores(deepSWEPool, designPool);
  const agentPool = attachOpenRouter(intelligenceRaw, openRouterModels);

  // Agent frontier: best score among reasonably priced (<= $3/task), per selector discipline
  const reasonablyPriced = agentPool.filter((x) => x.costPerTask <= 3);
  const agentFrontierPool = reasonablyPriced.length ? reasonablyPriced : agentPool;
  const agentBest = Math.max(...agentFrontierPool.map((x) => x.score));
  const agentCutoff = agentBest * CONFIG.agentMinQuality;

  const codingBest = Math.max(...coding.map((x) => x.score));
  const everydayCutoff = codingBest * CONFIG.everydayCodingMinQuality;
  const hardCutoff = codingBest * CONFIG.hardCodingMinQuality;

  const slim = (x, best) => ({
    model: x.model, effort: x.effort, score: x.score,
    relative: round((x.score / best) * 100, 1),
    confidence: x.confidence ?? null, costPerTask: x.costPerTask,
    outputTokens: x.outputTokens ?? null, steps: x.steps ?? null,
    speed: x.speed ?? null, openRouterId: x.openRouterId,
    sources: x.sources ?? null, deepScore: x.deepScore ?? null,
    designScore: x.designScore ?? null, designElo: x.designElo ?? null,
  });

  const agentElig = pickCheapestAbove(agentPool, agentCutoff);
  const everydayElig = pickCheapestAbove(coding, everydayCutoff);
  const hardElig = pickCheapestAbove(coding, hardCutoff);

  const picks = {
    date: new Date().toISOString().slice(0, 10),
    agent: { winner: slim(agentElig[0], agentBest), bestScore: agentBest, cutoff: round(agentCutoff, 2) },
    everyday: { winner: slim(everydayElig[0], codingBest), bestScore: codingBest, cutoff: round(everydayCutoff, 2) },
    hard: { winner: slim(hardElig[0], codingBest), bestScore: codingBest, cutoff: round(hardCutoff, 2) },
  };
  const candidates = {
    date: picks.date,
    agent: agentElig.map((x) => slim(x, agentBest)),
    everyday: everydayElig.map((x) => slim(x, codingBest)),
    hard: hardElig.map((x) => slim(x, codingBest)),
  };

  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}/picks.json`, JSON.stringify(picks, null, 2));
  writeFileSync(`${OUT}/candidates.json`, JSON.stringify(candidates, null, 2));
  console.log(`AGENT: ${picks.agent.winner.openRouterId} - ${picks.agent.winner.effort}`);
  console.log(`EVERYDAY: ${picks.everyday.winner.openRouterId} - ${picks.everyday.winner.effort}`);
  console.log(`HARD: ${picks.hard.winner.openRouterId} - ${picks.hard.winner.effort}`);
}

main().catch((error) => { console.error(error); process.exit(1); });
