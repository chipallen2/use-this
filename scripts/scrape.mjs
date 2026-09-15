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
  },
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
    ["qwen3.8-max", "qwen/qwen3.8-max"],
    ["qwen3.8", "qwen/qwen3.8"],
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
    return { ...candidate, openRouterId: openRouter?.id ?? null, effortSupported: effortIsSupported(candidate, openRouter) };
  }).filter((c) => c.openRouterId && c.effortSupported);
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

  const coding = attachOpenRouter(deepSWERaw, openRouterModels);
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
