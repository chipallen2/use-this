// scripts/render.mjs - builds the static site into dist/:
//   index.html  - app shell (landing form OR picks, decided in the browser)
//   docs/index.html - settings reference (served at /docs)
//   app.mjs, calc.mjs - browser code; calc.mjs is lib/calc.mjs byte-for-byte
//   models.json - the daily data (copied from data/models.json)
//   llms.txt    - machine-readable pointer to the bot endpoint
// No picks are baked in: every pick is computed from URL settings.
// Usage: node scripts/render.mjs [datadir] [outpath]

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync } from "fs";
import { dirname, join } from "path";
import * as C from "../lib/calc.mjs";
import { validateModelsData, NORMALIZATION } from "./models-data.mjs";

const DATA = process.argv[2] || "data";
const OUT = process.argv[3] || "dist/index.html";
const DIST = dirname(OUT);

const data = JSON.parse(readFileSync(`${DATA}/models.json`, "utf8"));
validateModelsData(data); // never deploy a file the client can't trust
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const recQuery = C.serializeSettings(C.RECOMMENDED);
const recUrl = `${C.SITE_URL}/?${recQuery}`;
const apiExample = `${C.SITE_URL}${C.API_PATH}?${recQuery}`;

const HEAD = (title, desc) => `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#2345ff">
<meta name="description" content="${esc(desc)}">
<link rel="describedby" href="/llms.txt">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${C.SITE_URL}/og-image.png">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary_large_image">
<title>${esc(title)}</title>`;

const CSS = `*{box-sizing:border-box}
body{margin:0;min-height:100svh;padding:clamp(20px,3vw,52px);display:flex;flex-direction:column;background:#2345ff;color:#fff;font-family:Arial,Helvetica,sans-serif;-webkit-font-smoothing:antialiased}
a{color:inherit}
header{display:flex;flex-wrap:wrap;align-items:flex-start;gap:16px;margin-bottom:clamp(24px,4vh,44px)}
header .brand{flex:1;min-width:260px}
h1{margin:0;font-size:clamp(26px,7vw,104px);white-space:nowrap;font-weight:900;line-height:.96;letter-spacing:-.065em}
h1 a{text-decoration:none}
.sub{margin:14px 0 0;font-size:clamp(15px,1.4vw,20px);opacity:.85}
.actions{display:flex;flex-wrap:wrap;gap:10px}
.actions button,.pill{padding:10px 18px;border:2px solid currentColor;border-radius:999px;background:transparent;color:inherit;font:inherit;font-size:15px;font-weight:700;cursor:pointer}
body[data-state=landing] .needs-picks,body[data-state=invalid] .needs-picks{display:none}
main{flex:1}
.cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:clamp(14px,1.5vw,24px)}
.card{min-height:440px;padding:clamp(24px,2.6vw,44px);border-radius:24px;display:flex;flex-direction:column;color:#141414;cursor:pointer}
.chat{background:#c5ff32;color:#141414}.everyday{background:#ff795e;color:#141414}.hard{background:#7926ec;color:#fff}
.card h2{margin:0;font-size:clamp(29px,3vw,48px);font-weight:800;line-height:1.03;letter-spacing:-.045em}
.explanation{margin:14px 0 0;font-size:clamp(15px,1.2vw,20px);line-height:1.4}
.card h3{margin:auto 0 0;padding-top:60px;font-size:clamp(36px,4.4vw,76px);font-weight:900;line-height:.97;letter-spacing:-.055em;position:relative}
.card h3 span{display:block}.card h3 .org{font-size:.42em;letter-spacing:-.01em;margin-bottom:.2em}
.card h3 .thinking{position:absolute;top:10px;left:0;padding:7px 12px;border:2px solid currentColor;border-radius:999px;font-size:14px;letter-spacing:.05em;text-transform:uppercase}
.details{display:flex;flex-wrap:wrap;gap:8px 22px;margin:24px 0 0;font-size:15px;line-height:1.5}
.tap{margin:14px 0 0;font-size:13px;font-weight:900;letter-spacing:.07em;text-transform:uppercase;opacity:.85}
.landing{max-width:1200px}
.lede{font-size:clamp(18px,1.8vw,26px);line-height:1.4;max-width:44em;margin:0 0 12px}.lede.small{font-size:16px;opacity:.9}
.cats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;margin-top:22px}
fieldset.cat{border:0;border-radius:20px;padding:18px 20px;margin:0}
fieldset.cat legend{font-weight:900;font-size:22px;padding:0;float:left;width:100%;margin-bottom:8px}
.hint{margin:0 0 4px;font-size:12px;font-weight:900;text-transform:uppercase;letter-spacing:.06em}
label.bench{display:flex;align-items:center;gap:8px;font-size:13px;margin:4px 0}
label.bench span{flex:1}label.bench .w{width:58px}
.nums{display:grid;gap:8px;margin-top:12px}.nums label{display:flex;flex-direction:column;font-size:13px;font-weight:700;gap:3px}
.nums small,label.bench small{font-weight:400;opacity:.75}
input,select{font:inherit;font-size:14px;padding:6px 8px;border:2px solid #141414;border-radius:8px;background:#fff;color:#141414;max-width:100%}
.primary{margin-top:20px;padding:14px 28px;border:0;border-radius:999px;background:#141414;color:#fff;font:inherit;font-size:18px;font-weight:900;cursor:pointer}
.errors{background:#fff3f3;color:#a51111;border-radius:14px;padding:12px 16px;margin:12px 0;font-size:14px}
footer{padding-top:24px;text-align:center;font-size:12px;line-height:1.5;opacity:.9}
.modal{display:none;position:fixed;inset:0;background:rgba(10,10,40,.72);z-index:50;overflow-y:auto;padding:clamp(12px,3vw,40px)}
.modal.open{display:block}
.modal-card{max-width:1100px;margin:0 auto;border-radius:24px;padding:clamp(22px,3vw,40px);position:relative;background:#fff;color:#141414}
.modal-card.chat{background:#c5ff32}.modal-card.everyday{background:#ff795e}.modal-card.hard{background:#7926ec;color:#fff}
.close{position:absolute;top:14px;right:16px;border:2px solid currentColor;background:transparent;color:inherit;font-size:26px;font-weight:900;width:44px;height:44px;border-radius:50%;cursor:pointer;line-height:1}
.kicker{margin:0;font-size:14px;font-weight:900;letter-spacing:.09em;text-transform:uppercase}
.winner{margin:16px 0 0;display:flex;flex-wrap:wrap;gap:10px;align-items:center}
.winner .use{background:#141414;color:#fff;font-weight:900;font-size:13px;letter-spacing:.08em;padding:8px 14px;border-radius:999px;text-transform:uppercase}
.winner .name{font-weight:900;font-size:clamp(20px,2.6vw,32px)}
.prices{margin:10px 0 0;font-size:16px}.why{margin:10px 0 0;font-size:clamp(16px,1.7vw,20px);font-weight:700;line-height:1.35}
.chart-box{margin-top:20px;background:#fff;border-radius:16px;padding:clamp(14px,2vw,24px);color:#141414}
.chart-box h2{margin:0 0 4px;font-size:15px;font-weight:900;letter-spacing:.05em;text-transform:uppercase}
.chart-box .sub{margin:0 0 10px;font-size:13px;opacity:1}
svg{width:100%;height:auto;display:block}
.table-scroll{overflow-x:auto;margin-top:16px}
table{width:100%;border-collapse:collapse;font-size:13px;min-width:520px}
caption{text-align:left;font-weight:900;font-size:12px;letter-spacing:.06em;text-transform:uppercase;padding:6px 0}
th,td{text-align:left;padding:8px 10px;border-top:1px solid #dee2e6}
tr.win td{background:#141414;color:#fff;font-weight:900}tr.below td{opacity:.5}
.norm-note,.unscored{margin:10px 0 0;font-size:12px;color:#495057}
.id-row{margin-top:16px;background:#141414;color:#fff;border-radius:14px;padding:14px 16px;display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center}
.id-row code{font-family:ui-monospace,Menlo,monospace;background:#2a2a2a;padding:8px 12px;border-radius:8px;word-break:break-all}
.id-row .tag{font-size:12px;font-weight:900;letter-spacing:.07em;text-transform:uppercase;color:#c5ff32}
.modal-card h2.title{margin:0 0 6px;font-size:28px}
#lock-cats{display:grid;gap:10px;margin:14px 0}#lock-cats label{display:flex;flex-direction:column;gap:4px;padding:12px;border-radius:14px;font-weight:900}
#lock-url{width:100%;font-family:ui-monospace,monospace;font-size:12px}
.row{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-top:14px}
#toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#141414;color:#fff;padding:12px 20px;border-radius:999px;font-weight:700;z-index:60}
@media(max-width:900px){.cards,.cats{grid-template-columns:1fr}.card{min-height:340px}}`;

const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
${HEAD("Use This Model - which AI model to use", "Pick the benchmarks, price cap and score floor; get the cheapest AI model that clears the bar for chatting, coding and crazy-hard coding. Settings live in the link.")}
<style>${CSS}</style>
<script type="module" src="/app.mjs"></script>
</head>
<body data-state="loading">
<header>
<div class="brand"><h1><a href="/">USE THIS MODEL</a></h1>
<p class="sub"><time id="updated"></time> &middot; <a href="/docs">How it works</a> &middot; <a href="${C.API_PATH}" rel="nofollow">Bot API</a></p></div>
<div class="actions needs-picks">
<button type="button" id="btn-share">Share</button>
<button type="button" id="btn-lock">Share Locked Models</button>
<button type="button" id="btn-customize">Customize</button>
</div>
</header>
<main id="main" aria-live="polite"><noscript><p>This page needs JavaScript. Bots: use <a href="${C.API_PATH}">${C.API_PATH}</a> (see <a href="/docs">/docs</a>).</p></noscript></main>
<footer>Data refreshed daily from Epoch AI (ECI, CC-BY 4.0), Artificial Analysis, Design Arena, Vals AI. Prices: OpenRouter input list price per 1M tokens. <a href="/docs">Docs</a> &middot; <a href="https://github.com/chipallen2/use-this">GitHub</a></footer>

<div class="modal" id="detail" aria-hidden="true"><div id="detail-body" role="dialog" aria-label="Pick detail"></div></div>

<div class="modal" id="customize" aria-hidden="true"><div class="modal-card" role="dialog" aria-label="Customize settings">
<button class="close" data-dismiss="customize" aria-label="Close">&times;</button>
<h2 class="title">Customize</h2>
<p>Every setting ends up in the page URL. Apply reloads with the new link. <a href="/docs" target="_blank" rel="noopener">What do these settings mean?</a></p>
<form id="customize-form" novalidate><div class="cats" id="customize-cats"></div>
<div class="errors" id="customize-errors" hidden></div>
<button type="submit" class="primary" id="apply">Apply</button></form>
</div></div>

<div class="modal" id="lock" aria-hidden="true"><div class="modal-card" role="dialog" aria-label="Share locked models">
<button class="close" data-dismiss="lock" aria-label="Close">&times;</button>
<h2 class="title">Share Locked Models</h2>
<p>A locked link always shows exactly these models, even after the data changes, until you send a new link. Change any of them before copying.</p>
<div id="lock-cats"></div>
<input id="lock-url" readonly aria-label="Locked link">
<div class="row"><button type="button" class="primary" id="lock-copy">Copy locked link</button></div>
</div></div>
<div id="toast" role="status" hidden></div>
</body>
</html>
`;

// ---------- docs ----------
const benchRows = C.BENCHMARKS.map((b) => `<tr><td><code>${b.key}</code></td><td><a href="${b.url}">${esc(b.name)}</a></td><td>${esc(b.about)}</td><td>${data.benchmarks[b.key]?.models ?? 0}</td></tr>`).join("");
const rec = (k) => `<code>${k}=${C.RECOMMENDED[k].bench.map((b) => b.key).join(",")}&amp;${k}_max=${C.RECOMMENDED[k].max}&amp;${k}_min=${C.RECOMMENDED[k].min}</code>`;
const docsHtml = `<!DOCTYPE html>
<html lang="en"><head>
${HEAD("Use This Model - settings docs", "Every Use This Model URL setting, the normalization method, missing-data modes, price meaning and the bot endpoint.")}
<style>${CSS}
.doc{max-width:900px;background:#fff;color:#141414;border-radius:24px;padding:clamp(22px,3vw,44px);line-height:1.55}
.doc h2{margin:28px 0 8px;font-size:24px}.doc code{background:#f1f3f5;padding:1px 5px;border-radius:5px;font-size:.92em;word-break:break-all}
.doc pre{background:#141414;color:#fff;padding:14px;border-radius:12px;overflow-x:auto;font-size:13px}.doc pre code{background:none;color:inherit}
.doc table{min-width:0}</style>
</head><body data-state="docs">
<header><div class="brand"><h1><a href="/">USE THIS MODEL</a></h1><p class="sub">Settings reference (format v${C.SETTINGS_VERSION})</p></div></header>
<main><article class="doc">
<p>Use This Model shows three cards: <strong>Chatting</strong> (<code>chat</code>), <strong>Everyday Coding</strong> (<code>code</code>) and <strong>Crazy Hard Coding</strong> (<code>crazy</code>). For each one it recommends the <strong>cheapest model whose score is at least your minimum and whose input price is at most your maximum</strong>. There is no database and no account: every setting lives in the URL, so a link is the whole configuration. Save it, share it, or put it behind your own short link.</p>

<h2 id="params">Parameters</h2>
<p>Each category takes the same parameters, prefixed with its name. Replace <code>chat</code> with <code>code</code> or <code>crazy</code>.</p>
<table><thead><tr><th>Param</th><th>Required</th><th>Format</th><th>Meaning</th></tr></thead><tbody>
<tr><td><code>v</code></td><td>no</td><td><code>1</code></td><td>Settings format version. Omitted means 1. A future breaking change ships as <code>v=2</code>; v1 links keep working.</td></tr>
<tr><td><code>chat</code></td><td>yes</td><td><code>key[:weight],...</code></td><td>Benchmarks to score with, and their relative weights (default weight 1). <code>chat=eci</code>, <code>chat=eci:2,aai:1</code>.</td></tr>
<tr><td><code>chat_max</code></td><td>yes</td><td>number &ge; 0</td><td>Max <strong>input</strong> price in USD per 1M tokens. <code>chat_max=1.5</code></td></tr>
<tr><td><code>chat_min</code></td><td>yes</td><td>0-100</td><td>Min combined score (normalized scale, see below). <code>chat_min=70</code></td></tr>
<tr><td><code>chat_miss</code></td><td>no</td><td><code>exclude</code> | <code>reweight</code> | <code>zero</code></td><td>What to do when a model has no score on a chosen benchmark. Default <code>exclude</code>.</td></tr>
<tr><td><code>chat_cov</code></td><td>no</td><td>0-100</td><td>Only with <code>reweight</code>: minimum % of the chosen weight a model must have scores for.</td></tr>
<tr><td><code>chat_lock</code></td><td>no</td><td>OpenRouter model id</td><td>Locks the card to exactly this model (see Locked links). <code>chat_lock=openai/gpt-6.1-sol</code></td></tr>
</tbody></table>
<p>Unknown parameters, duplicated parameters, or invalid values make the link invalid: the page lists exactly what is wrong and the bot endpoint returns HTTP 400. Parameters starting with <code>utm_</code> are ignored so marketing tags never break a link.</p>

<h2 id="benchmarks">Benchmarks</h2>
<table><thead><tr><th>Key</th><th>Benchmark</th><th>What it measures</th><th>Models today</th></tr></thead><tbody>${benchRows}</tbody></table>
<p>Benchmark keys are permanent. If a source disappears its key stays valid; models just stop having that score, which the missing-data mode handles.</p>

<h2 id="normalization">How scores are normalized</h2>
<p>Benchmarks use different scales (ECI points, Elo, % accuracy), so every benchmark is rescaled to 0-100 by Use This Model's data refresh, with one fixed method. It is not a setting.</p>
<p><strong>${esc(NORMALIZATION)}</strong> A model's raw score is its best published configuration (for example its highest reasoning effort) on that benchmark. Normalization is computed over the models we publish, which are the models we can price.</p>
<p>The combined score for a category is the weighted average of the chosen normalized scores, so single-benchmark and multi-benchmark settings use the same 0-100 scale and a floor of 80 means the same thing either way. Because the scale is relative to the field, a model's score can move when much stronger or weaker models are added; a score of 100 always means "best tracked model on this benchmark today".</p>

<h2 id="missing">Missing data</h2>
<ul>
<li><code>exclude</code> (default): a model must have every chosen benchmark, otherwise it is not ranked.</li>
<li><code>reweight</code>: average only over the benchmarks the model has, re-dividing by their weights. Add <code>_cov</code> to require a minimum share of weight, e.g. <code>code_miss=reweight&amp;code_cov=50</code>.</li>
<li><code>zero</code>: a missing benchmark counts as 0.</li>
</ul>
<p>In every mode a model with no score on any chosen benchmark is not ranked.</p>

<h2 id="price">Price</h2>
<p>Price is the model's <strong>input price in USD per 1M tokens</strong>, the OpenRouter list price for that model id. It is one number every provider publishes, so it is comparable across all models. The real cost of a task also depends on output tokens (often several times more expensive per token) and on how verbose or agentic a model is, so two models with the same input price can cost very differently per task. Output price is shown in each model's detail view for reference; filtering and ranking use input price only.</p>

<h2 id="locks">Locked links</h2>
<p>Normally picks float: when data changes tomorrow, the same link may recommend a newer model. Add <code>chat_lock</code>, <code>code_lock</code> and/or <code>crazy_lock</code> to pin a card to exactly that model. Use <em>Share Locked Models</em> on the page to build one; you can choose any model per category before copying. A locked card always shows the locked model, even if it is retired from the data. Update your link when you want to move.</p>

<h2 id="examples">Examples</h2>
<p>Recommended settings (ECI everywhere):</p>
<pre><code>${esc(recUrl)}</code></pre>
<p>Coding blend, tolerate missing benchmarks if a model has at least half the weight:</p>
<pre><code>${esc(C.SITE_URL)}/?chat=eci&amp;chat_max=1&amp;chat_min=65&amp;code=aac:2,vibe:1,da:1&amp;code_max=3&amp;code_min=70&amp;code_miss=reweight&amp;code_cov=50&amp;crazy=eci,aac&amp;crazy_max=15&amp;crazy_min=90</code></pre>
<p>Same settings with locked models:</p>
<pre><code>${esc(recUrl)}&amp;chat_lock=openai/gpt-6.1-sol&amp;code_lock=anthropic/claude-sonnet-5.5&amp;crazy_lock=anthropic/claude-opus-5.5</code></pre>

<h2 id="api">Bot endpoint</h2>
<p><code>GET ${C.API_PATH}</code> takes exactly the same parameters and runs the same calculation code as the page, so bots and humans always get the same picks.</p>
<pre><code>curl '${esc(apiExample)}'</code></pre>
<p>200 response (abridged):</p>
<pre><code>{
  "v": 1,
  "data_updated_utc": "2026-11-11T12:00:00.000Z",
  "url": "${esc(recUrl)}",
  "categories": {
    "chat": {
      "title": "Chatting",
      "status": "ok",            // ok | no-model-qualifies | locked | locked-model-not-in-data
      "model": { "id": "...", "name": "...", "org": "...",
                 "input_usd_per_1m": 0.1, "output_usd_per_1m": 0.5, "score": 67.8 },
      "qualifying_count": 3,
      "runners_up": [ ... ],
      "settings": { ... }
    },
    "code": { ... }, "crazy": { ... }
  }
}</code></pre>
<p>No parameters, unknown parameters or invalid values return <strong>HTTP 400</strong>:</p>
<pre><code>{ "error": "invalid_settings",
  "errors": [ { "param": "code_min", "problem": "missing (min score, 0-100)" } ],
  "docs": "${C.DOCS_URL}",
  "example": "${esc(apiExample)}" }</code></pre>
<p>Raw data for your own math: <a href="/models.json"><code>/models.json</code></a> (normalized scores, raw scores, input/output $ per 1M, refreshed daily). The calculation module itself is <a href="/calc.mjs"><code>/calc.mjs</code></a>.</p>

<h2 id="sources">Data sources</h2>
<p>Refreshed daily. Epoch Capabilities Index &copy; Epoch AI, CC-BY 4.0 (<a href="https://epoch.ai/benchmarks">epoch.ai/benchmarks</a>). Artificial Analysis, Design Arena and Vals AI leaderboards. Prices from the OpenRouter model catalog. Only models with an OpenRouter listing (and therefore an input price) are published.</p>
<p><a href="/">&larr; Back to Use This Model</a></p>
</article></main></body></html>
`;

const llms = `# USE THIS MODEL

> Recommends which AI model to use for chatting, everyday coding and crazy-hard coding: the cheapest model that clears a score floor under a price cap. All settings are URL query params; there are no default picks.

## Bot endpoint

- [${C.API_PATH}](${apiExample}) - same params as the page, JSON picks. No/invalid params = HTTP 400 naming the bad settings.
- [Settings docs](${C.DOCS_URL}) - every param, normalization, missing-data modes, price meaning.
- [Raw data](${C.SITE_URL}/models.json) - normalized + raw benchmark scores, input/output USD per 1M tokens. Updated ${data.generated_utc}.

## Recommended settings

${recUrl}
`;

mkdirSync(join(DIST, "docs"), { recursive: true });
writeFileSync(OUT, indexHtml);
writeFileSync(join(DIST, "docs", "index.html"), docsHtml);
writeFileSync(join(DIST, "llms.txt"), llms);
writeFileSync(join(DIST, "models.json"), JSON.stringify(data));
copyFileSync("lib/calc.mjs", join(DIST, "calc.mjs"));
copyFileSync("web/app.mjs", join(DIST, "app.mjs"));
for (const f of readdirSync("assets")) copyFileSync(`assets/${f}`, join(DIST, f));
console.log(`wrote ${DIST}: index.html, docs/index.html, llms.txt, models.json (${data.models.length} models), calc.mjs, app.mjs, assets`);
