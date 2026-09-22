// scripts/render.mjs -- builds dist/index.html from data/picks.json + data/candidates.json
// Locked design: v4.html landing + popup.html detail. Inline CSS, inline SVG, tiny inline JS (modal only).
// Usage: node scripts/render.mjs [datadir] [outpath]

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, readdirSync } from "fs";
import { dirname } from "path";

const DATA = process.argv[2] || "data";
const OUT = process.argv[3] || "dist/index.html";

const RECALC_URL = process.env.RECALC_URL || "RECALC_URL_PLACEHOLDER";

const picks = JSON.parse(readFileSync(`${DATA}/picks.json`, "utf8"));
const cands = JSON.parse(readFileSync(`${DATA}/candidates.json`, "utf8"));

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Benchmark source links (footer + popup explain text). Applied AFTER esc().
const AA_URL = "https://artificialanalysis.ai/leaderboards/models";
const DEEPSWE_URL = "https://deepswe.datacurve.ai/";
const DESIGN_URL = "https://www.designarena.ai/leaderboard?section=agentic-web-dev";
const blink = (url, text) => `<a href="${url}" target="_blank" rel="noopener">${text}</a>`;
function linkify(s) {
  return String(s)
    .replace(/AA Intelligence Index/g, blink(AA_URL, "AA Intelligence Index"))
    .replace(/Artificial Analysis/g, blink(AA_URL, "Artificial Analysis"))
    .replace(/Design Arena/g, blink(DESIGN_URL, "Design Arena"))
    .replace(/DeepSWE/g, blink(DEEPSWE_URL, "DeepSWE"));
}

// Short display name from OpenRouter ID, e.g. openai/gpt-5.6-luna-pro -> ["GPT-5.6", "Luna Pro"]
function displayName(id) {
  const slug = id.split("/").pop();
  const map = [
    [/^gpt-6-astra$/, ["GPT-6", "Astra"]],
    [/^gpt-6-sol$/, ["GPT-6", "Sol"]],
    [/^gpt-5\.6-sol-pro$/, ["GPT-5.6", "Sol Pro"]],
    [/^gpt-5\.6-luna-pro$/, ["GPT-5.6", "Luna Pro"]],
    [/^gpt-5\.6-luna$/, ["GPT-5.6", "Luna"]],
    [/^gpt-5\.6-terra$/, ["GPT-5.6", "Terra"]],
    [/^gpt-5\.5-pro$/, ["GPT-5.5", "Pro"]],
    [/^claude-opus-5.*$/, ["Claude", "Opus 5"]],
    [/^claude-fable-5.*$/, ["Claude", "Fable 5"]],
    [/^claude-sonnet-5.*$/, ["Claude", "Sonnet 5"]],
    [/^gpt-5\.6-sol-pro$/, ["GPT-5.6", "Sol Pro"]],
    [/^gemini-3\.8-flash$/, ["Gemini 3.8", "Flash"]],
    [/^gemini-3\.7-flash$/, ["Gemini 3.7", "Flash"]],
    [/^muse-spark-1\.3-contributor$/, ["Muse Spark 1.3", "Contributor"]],
    [/^muse-spark-1\.3.*$/, ["Muse Spark 1.3", ""]],
    [/^muse-spark.*$/, ["Muse", "Spark"]],
    [/^glm-5\.3-flash$/, ["GLM-5.3", "Flash"]],
    [/^glm-5\.3$/, ["GLM-5.3", ""]],
    [/^grok-4\.6$/, ["Grok 4.6", ""]],
    [/^kimi-k3$/, ["Kimi K3", ""]],
  ];
  for (const [re, parts] of map) if (re.test(slug)) return parts;
  const bits = slug.split("-");
  return [bits.slice(0, 2).join(" ").toUpperCase(), bits.slice(2).join(" ")];
}

const effortLabel = (e) => (e ? `${e} thinking` : "default");

// (shortSource kept for why-text fallbacks; Signal column removed in favor of per-signal columns.)
function shortSource(s) {
  if (!s) return "";
  if (s.startsWith("50% DeepSWE")) return "blend";
  if (s.startsWith("Design Arena only")) return "Design only";
  if (s.startsWith("DeepSWE only")) return "DeepSWE only";
  return s;
}

function cardClass(key) { return key === "agent" ? "chat" : key === "everyday" ? "everyday" : "hard"; }
function cardTitle(key) { return key === "agent" ? "Chatting" : key === "everyday" ? "Everyday Coding" : "Crazy Hard Coding"; }
function cardExpl(key) {
  return key === "agent" ? "Best for everyday chats"
    : key === "everyday" ? "Best for normal coding"
    : "Best money-no-object pick for really hard tasks";
}

// Org colors (AA-style legend)
function orgOf(id) {
  const o = id.split("/")[0].toLowerCase();
  if (o === "openai") return "OpenAI";
  if (o === "anthropic") return "Anthropic";
  if (o === "google") return "Google";
  if (o === "meta") return "Meta";
  if (o === "x-ai") return "xAI";
  if (o === "z-ai") return "Z.ai";
  if (o === "moonshotai") return "Moonshot AI";
  if (o === "deepseek") return "DeepSeek";
  if (o === "alibaba" || o === "qwen") return "Alibaba";
  return o;
}
const ORG_COLORS = {
  "OpenAI": "#111111", "Anthropic": "#e8590c", "Google": "#2f9e44",
  "Meta": "#1971c2", "xAI": "#7048e8", "Z.ai": "#0c8599",
  "Moonshot AI": "#f08c00", "DeepSeek": "#0b7285", "Alibaba": "#d6336c",
};
const orgColor = (id) => ORG_COLORS[orgOf(id)] || "#868e96";

// Nice round ticks within [lo, hi]
function niceTicks(lo, hi, n) {
  if (!(hi > lo)) return [lo];
  const span = hi - lo, raw = span / n;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(4));
  return out.length ? out : [lo, hi];
}
// Log-friendly $ ticks within [lo, hi]
function moneyTicks(lo, hi) {
  const cand = [0.25, 0.5, 1, 2, 5, 10, 15, 20, 30, 50];
  const t = cand.filter((v) => v >= lo * 0.999 && v <= hi * 1.001);
  if (t.length >= 2) return t;
  return niceTicks(lo, hi, 5);
}

// Inline SVG scatter (AA/DeepSWE style): x = cost/task, CHEAP on LEFT; y = score.
// Light grid, $ and % ticks, dots colored by org, all dots labeled + native
// <title> tooltips, dashed CUTOFF line with shaded winning zone above it,
// FRONTIER tag on the top scorer, USE THIS ring + callout on the winner.
function scatter(list, winner, cutoff, color, benchLabel, thresholdPct) {
  const pts = [...list].sort((a, b) => a.costPerTask - b.costPerTask);
  const W = 760, H = 480, L = 56, R = 740, T = 26, B = 392;
  const scores = pts.map((p) => p.score);
  const costs = pts.map((p) => p.costPerTask);
  const key = (p) => p.openRouterId + "|" + p.effort;
  // Tooltip signal detail for coding pools (entries carry deepRaw/designElo).
  const signalTip = (p) => {
    if (p.deepRaw == null && p.designElo == null) return "";
    const bits = [];
    if (p.deepRaw != null) bits.push(`DeepSWE ${p.deepRaw}%`);
    if (p.designElo != null) bits.push(`Design Elo ${p.designElo}`);
    return " (" + bits.join(", ") + ")";
  };
  const frontier = pts.reduce((a, b) => (b.score > a.score || (b.score === a.score && b.costPerTask < a.costPerTask) ? b : a));
  const yHi = Math.max(...scores);
  const yPadTop = Math.max(0.5, (yHi - cutoff) * 0.35);
  const yMax = yHi + yPadTop;
  const yMinZoom = cutoff - Math.max(0.5, (yHi - cutoff) * 0.3);
  const yMinFull = 0; // expanded view always bottoms at exactly 0
  const y = (s) => B - ((s - yMinZoom) / (yMax - yMinZoom)) * (B - T);
  const yF = (s) => B - ((s - yMinFull) / (yMax - yMinFull)) * (B - T);
  const cLo = Math.min(...costs), cHi = Math.max(...costs);
  const logMin = Math.log10(Math.max(0.05, cLo * 0.85)), logMax = Math.log10(cHi * 1.12);
  const x = (c) => L + ((Math.log10(Math.max(0.05, c)) - logMin) / Math.max(0.01, logMax - logMin)) * (R - L);
  const yCut = y(cutoff);
  const short = (p) => {
    const [n1, n2] = displayName(p.openRouterId);
    return (n1 + (n2 ? " " + n2 : "") + (p.effort ? " " + p.effort : "")).slice(0, 26);
  };
  // Gridlines + ticks
  let grid = "";
  // winning zone: above cutoff (height recomputed by the range toggle)
  grid += `<rect x="${L}" y="${T}" width="${R - L}" height="${Math.max(0, Math.round(yCut) - T)}" fill="#e9fbe8" data-zone="1"/>`;
  const yGridZoom = niceTicks(yMinZoom, yMax, 6).map((t) => {
    const yy = Math.round(y(t));
    return `<line x1="${L}" y1="${yy}" x2="${R}" y2="${yy}" stroke="#dee2e6" stroke-width="1"/>` +
      `<text x="${L - 7}" y="${yy + 4}" font-size="11" fill="#495057" text-anchor="end">${t}%</text>`;
  }).join("");
  const yGridFull = niceTicks(yMinFull, yMax, 10).map((t) => {
    const yy = Math.round(yF(t));
    return `<line x1="${L}" y1="${yy}" x2="${R}" y2="${yy}" stroke="#dee2e6" stroke-width="1"/>` +
      `<text x="${L - 7}" y="${yy + 4}" font-size="11" fill="#495057" text-anchor="end">${t}%</text>`;
  }).join("");
  grid = `<g class="ygrid-zoom">${yGridZoom}</g><g class="ygrid-full" style="display:none">${yGridFull}</g>`;
  for (const t of moneyTicks(cLo, cHi)) {
    const xx = Math.round(x(t));
    grid += `<line x1="${xx}" y1="${T}" x2="${xx}" y2="${B}" stroke="#e9ecef" stroke-width="1"/>`;
    grid += `<text x="${xx}" y="${B + 20}" font-size="11" fill="#495057" text-anchor="middle">$${t}</text>`;
  }
  // Cutoff line
  const cut = `<line x1="${L}" y1="${Math.round(yCut)}" x2="${R}" y2="${Math.round(yCut)}" stroke="#e03131" stroke-width="2" stroke-dasharray="8 6" data-y="${cutoff}"/>` +
    `<text x="${R - 4}" y="${Math.round(yCut) - 7}" font-size="12" font-weight="900" fill="#e03131" text-anchor="end" data-y="${cutoff}" data-dy="-7">CUTOFF ${cutoff}% (${thresholdPct}% of frontier)</text>`;
  // Dots + labels with simple collision stagger.
  // Below-cutoff dots render dimmed (smaller, translucent gray) but stay
  // tappable with full tooltips. Only above-cutoff dots get text labels,
  // to avoid clutter.
  let dots = "", labels = "";
  const placed = [];
  const keyWin = key(winner), keyFront = key(frontier);
  const above = (p) => p.score >= cutoff;
  const ordered = [...pts].sort((a, b) => x(a.costPerTask) - x(b.costPerTask));
  for (const p of ordered) {
    const isWin = key(p) === keyWin;
    const isAbove = above(p);
    const cx = Math.round(x(p.costPerTask)), cy = Math.round(y(p.score));
    const c = isAbove ? orgColor(p.openRouterId) : "#adb5bd";
    const tip = short(p) + " - " + orgOf(p.openRouterId) + " - " + p.score + "% - $" + p.costPerTask + "/task" + (isAbove ? "" : " (below cutoff)") + (isWin ? " - USE THIS" : "") + signalTip(p);
    const dat = `class="dot" data-name="${esc(short(p))}" data-org="${esc(orgOf(p.openRouterId))}" data-score="${p.score}" data-cost="${p.costPerTask}"` + (isWin ? ` data-win="1"` : "") + (isAbove ? "" : ` data-below="1"`);
    if (isWin) {
      dots += `<circle cx="${cx}" cy="${cy}" r="13" fill="${c}" stroke="#141414" stroke-width="4" data-y="${p.score}" ${dat}><title>${esc(tip)}</title></circle>`;
      // USE THIS badge: same pill-beside-dot language as FRONTIER, but dominant -
      // card-accent fill, larger pill, star kept. Merged when winner == frontier.
      const accent = color === "chat" ? ["#c5ff32", "#141414"] : color === "everyday" ? ["#ff795e", "#141414"] : ["#7926ec", "#fff"];
      const winLabel = key(p) === keyFront ? "★ USE THIS \u00b7 FRONTIER " + frontier.score + "%" : "★ USE THIS";
      const wbw = Math.round(winLabel.length * 8.2 + 26);
      let wbx = cx + 20;
      if (wbx + wbw > R) wbx = cx - 20 - wbw;
      if (wbx < L) wbx = L;
      labels += `<g><rect x="${wbx}" y="${cy - 13}" width="${wbw}" height="26" rx="13" fill="${accent[0]}" stroke="#141414" stroke-width="2" data-y="${p.score}" data-dy="-13" data-badge="1"/><text x="${wbx + wbw / 2}" y="${cy + 5}" font-size="13" font-weight="900" fill="${accent[1]}" text-anchor="middle" data-y="${p.score}" data-dy="5">${esc(winLabel)}</text></g>`;
      labels += `<text x="${cx}" y="${cy + 32}" font-size="11" font-weight="900" fill="#141414" text-anchor="middle" data-y="${p.score}" data-dy="32">${esc(short(p))}</text>`;
      placed.push({ x: cx, row: 1 }, { x: cx, row: -1 });
    } else if (isAbove) {
      dots += `<circle cx="${cx}" cy="${cy}" r="6.5" fill="${c}" data-y="${p.score}" ${dat}><title>${esc(tip)}</title></circle>`;
      // alternate above/below, flip if too close to last label on that row
      let row = placed.length % 2 === 0 ? 1 : -1;
      const tooClose = (r) => placed.some((q) => q.row === r && Math.abs(q.x - cx) < 62);
      if (tooClose(row)) row = -row;
      if (tooClose(row)) row = 0; // give up staggering, put further above
      const ly = row === 1 ? cy - 14 : row === -1 ? cy + 24 : cy - 26;
      const ldy = +((ly - y(p.score)).toFixed(2));
      labels += `<text x="${cx}" y="${ly}" font-size="10" font-weight="700" fill="#343a40" text-anchor="middle" data-y="${p.score}" data-dy="${ldy}">${esc(short(p))}</text>`;
      placed.push({ x: cx, row });
    } else {
      // Below cutoff: dimmed, unlabeled, still tappable with full tooltip.
      dots += `<circle cx="${cx}" cy="${cy}" r="4" fill="${c}" opacity="0.45" data-y="${p.score}" ${dat}><title>${esc(tip)}</title></circle>`;
    }
  }
  const fx = Math.round(x(frontier.costPerTask)), fy = Math.round(y(frontier.score));
  // FRONTIER badge: small dark pill directly beside the frontier dot, no leader line.
  // (When frontier == winner the label merges into the USE THIS pill beside the dot.)
  let frontTag = "";
  if (keyFront !== keyWin) {
    const fLabel = `FRONTIER ${frontier.score}%`;
    const bw = Math.round(fLabel.length * 7.4 + 22);
    let bx = fx + 14;
    if (bx + bw > R) bx = fx - 14 - bw;
    if (bx < L) bx = L;
    frontTag = `<g><rect x="${bx}" y="${fy - 11}" width="${bw}" height="22" rx="11" fill="#141414" data-y="${frontier.score}" data-dy="-11" data-badge="1"/><text x="${bx + bw / 2}" y="${fy + 4}" font-size="12" font-weight="900" fill="#fff" text-anchor="middle" data-y="${frontier.score}" data-dy="4">${esc(fLabel)}</text></g>`;
  }
  const orgs = [...new Set(pts.map((p) => orgOf(p.openRouterId)))];
  const legend = '<div class="legend">' + orgs.map((o) => '<span><i style="background:' + (ORG_COLORS[o] || "#868e96") + '"></i>' + esc(o) + '</span>').join("") + '</div>';
  return { legend, svg: `<svg viewBox="0 0 ${W} ${H + 40}" role="img" aria-label="Scatter chart of cost per task versus ${esc(benchLabel)} score" data-ymin-zoom="${+yMinZoom.toFixed(3)}" data-ymax="${+yMax.toFixed(3)}" data-cutoff="${cutoff}" data-t="${T}" data-b="${B}">
<defs><clipPath id="clip-${color}"><rect x="${L}" y="${T}" width="${R - L}" height="${B - T}"/></clipPath></defs>
${grid}
<line x1="${L}" y1="${T}" x2="${L}" y2="${B}" stroke="#adb5bd" stroke-width="1"/>
<line x1="${L}" y1="${B}" x2="${R}" y2="${B}" stroke="#adb5bd" stroke-width="1"/>
${cut}
<g clip-path="url(#clip-${color})">${dots}</g>
${labels}
${frontTag}
<text x="${L}" y="${B + 38}" font-size="12" font-weight="700" fill="#495057">&#8592; Cheaper</text>
<text x="${R}" y="${B + 38}" font-size="12" font-weight="700" fill="#495057" text-anchor="end">Pricier &#8594;</text>
<text x="${(L + R) / 2}" y="${B + 38}" font-size="13" font-weight="900" fill="#141414" text-anchor="middle">Cost per task ($) (log scale)</text>
<text x="14" y="210" font-size="12" font-weight="700" fill="#495057" transform="rotate(-90 14 210)" text-anchor="middle">${esc(benchLabel)} score (%)</text>
</svg>` };
}

function modal(key, color, benchLabel, thresholdPct, whyText) {
  const w = picks[key].winner;
  const list = cands[key];
  const cutoff = picks[key].cutoff;
  const [l1, l2] = displayName(w.openRouterId);
  const ch = scatter(list, w, cutoff, color, benchLabel, thresholdPct);
  const isCoding = key !== "agent";
  // Coding tables show the blend math transparently: Combined + per-signal raw/norm.
  // Both signals are min-max normalized to 0-100 for blending; table shows raw DeepSWE % + Elo.
  const fmtDeep = (p) => p.deepScore == null ? "-" : (p.deepRaw != null ? `${p.deepRaw}%*` : `${p.deepScore}%`);
  const fmtDesign = (p) => p.designScore == null ? "-" : `Elo ${p.designElo}*`;
  const sortVal = (v) => v == null ? "" : String(v);
  const rows = [...list].sort((a, b) => b.score - a.score || a.costPerTask - b.costPerTask).map((p) => {
    const isWin = p.openRouterId === w.openRouterId && p.effort === w.effort;
    const below = p.score < cutoff;
    const [n1, n2] = displayName(p.openRouterId);
    const nameCell = `<td>${esc(n1 + (n2 ? " " + n2 : ""))}${isWin ? " &#9733;" : ""}</td>`;
    const thinkCell = `<td>${esc(p.effort || "default")}</td>`;
    const priceCell = `<td data-v="${p.costPerTask}">$${p.costPerTask}</td>`;
    let scoreCells, headExtra;
    if (isCoding) {
      scoreCells = `<td data-v="${p.score}">${p.score}%</td><td data-v="${sortVal(p.deepScore)}">${esc(fmtDeep(p))}</td><td data-v="${sortVal(p.designScore)}">${esc(fmtDesign(p))}</td>`;
      headExtra = "";
    } else {
      scoreCells = `<td data-v="${p.score}">${p.score}%</td>`;
      headExtra = "";
    }
    void headExtra;
    return `<tr${isWin ? ' class="win"' : below ? ' class="below"' : ""}>${nameCell}${thinkCell}${scoreCells}${priceCell}</tr>`;
  }).join("");
  const head = isCoding
    ? `<th><button type="button" data-col="0" data-type="str">Model</button></th><th>Thinking</th><th><button type="button" data-col="2" data-type="num" data-dir="desc">Combined &#9660;</button></th><th><button type="button" data-col="3" data-type="num">DeepSWE *</button></th><th><button type="button" data-col="4" data-type="num">Design *</button></th><th><button type="button" data-col="5" data-type="num">Price</button></th>`
    : `<th><button type="button" data-col="0" data-type="str">Model</button></th><th>Thinking</th><th><button type="button" data-col="2" data-type="num" data-dir="desc">Score &#9660;</button></th><th><button type="button" data-col="3" data-type="num">Price</button></th>`;
  return `<div class="modal" id="modal-${key}" aria-hidden="true"><div class="modal-card ${color}" role="dialog" aria-label="${cardTitle(key)} detail">
<button class="close" data-close="${key}" aria-label="Close">&times;</button>
<p class="kicker">${cardTitle(key)} - detail</p>
<p class="winner"><span class="use">Use this</span><span class="name">${esc(l1 + (l2 ? " " + l2 : ""))}</span><span class="think">${esc(effortLabel(w.effort))}</span></p>
<p class="why">${linkify(whyText)}</p>
<div class="chart-box"><h2>Quality vs cost</h2><p class="sub">Left = cheaper. Up = better ${esc(benchLabel)} score. Hover or tap any dot for details.</p>
<button class="yrange" type="button" data-mode="zoom">View All</button>
${ch.legend}
${ch.svg}
<div class="tip" hidden></div>
<p class="explain"><strong>Score = ${linkify(esc(benchLabel))},</strong> cutoff = ${thresholdPct}% of the best (frontier) score, here ${cutoff}%. Cheapest model above the cutoff wins.${key === "agent" ? "" : linkify(" Coding score = 50% DeepSWE + 50% Design Arena Full-Stack (both min-max normalized to 0-100); models missing one signal use the other at 100%.")}</p>
<table class="sortable"><caption>All contenders (dimmed = below cutoff)</caption><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>
${isCoding ? linkify('<p class="norm-note">* Both signals min-max normalized to 0-100 for blending. DeepSWE shows raw test %; Design shows raw Elo.</p>') : ""}
<div class="id-row"><span class="tag">Copy-paste OpenRouter ID</span><code>${esc(w.openRouterId)}</code></div>
</div></div></div>`;
}

const dateStr = new Date(picks.date + "T12:00:00-07:00").toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", month: "long", day: "numeric", year: "numeric" });
// Calc timestamp: CALC_ISO_UTC env (weekly cron sets from `date -u`) else fall back to
// picks.date at 09:00 PT (16:00 UTC summer / 17:00 UTC winter) - Mondays 12:00 UTC cron.
const calcISO = process.env.CALC_ISO_UTC || new Date(picks.date + "T16:00:00Z").toISOString();
const calcPT = new Date(calcISO).toLocaleTimeString("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).replace(/([AP]M)/, m => m.toLowerCase()).replace(/\s+(?=[AP]M)/i, "");

function card(key, color) {
  const w = picks[key].winner;
  const [l1, l2] = displayName(w.openRouterId);
  const quality = w.relative;
  const full = `${l1}${l2 ? " " + l2 : ""}`;
  // WebMCP machine-readable pick: agents consume data-* instead of scraping pixels.
  return `<article class="${color}" data-open="${key}" tabindex="0" role="button" aria-label="${cardTitle(key)} detail"
 data-webmcp-pick="${key}" data-category="${cardTitle(key)}" data-model="${esc(full)}" data-thinking="${esc(w.effort || "default")}" data-price="${w.costPerTask}" data-quality="${quality}" data-openrouter-id="${esc(w.openRouterId)}">
<h2>${cardTitle(key)}</h2>
<p class="explanation">${cardExpl(key)}</p>
<h3><span class="thinking">${esc(effortLabel(w.effort))}</span><span>${esc(l1)}</span>${l2 ? `<span>${esc(l2)}</span>` : ""}</h3>
<p class="details"><span>Price <strong>$${w.costPerTask}</strong></span><span>Quality <strong>${quality}%</strong></span></p>
<p class="tap">Tap for detail &#8594;</p>
</article>`;
}

const why = {
  agent: `Cheapest chat model clearing 90% of frontier quality at $${picks.agent.winner.costPerTask}/task.`,
  everyday: `Cheapest model clearing 90% of frontier blended coding quality at $${picks.everyday.winner.costPerTask}/task. Score = ${esc(picks.everyday.winner.sources || "50% DeepSWE + 50% Design Arena Full-Stack")}.`,
  hard: `Cheapest model clearing 97% of frontier blended coding quality at $${picks.hard.winner.costPerTask}/task. Score = ${esc(picks.hard.winner.sources || "50% DeepSWE + 50% Design Arena Full-Stack")}. Frontier quality without the frontier bill.`,
};

// WebMCP structured data response: first application/ld+json block on the
// page is the declarative form tool's response payload (per WebMCP draft:
// navigating form tools return the target page's first ld+json block).
const pickLD = (key, title) => {
  const w = picks[key].winner;
  const [l1, l2] = displayName(w.openRouterId);
  return {
    "@type": "ListItem",
    position: key === "agent" ? 1 : key === "everyday" ? 2 : 3,
    name: `${title}: ${l1}${l2 ? " " + l2 : ""}`,
    item: {
      "@type": "SoftwareApplication",
      applicationCategory: title,
      name: `${l1}${l2 ? " " + l2 : ""}`,
      additionalProperty: [
        { "@type": "PropertyValue", name: "thinking", value: w.effort || "default" },
        { "@type": "PropertyValue", name: "pricePerTaskUSD", value: w.costPerTask },
        { "@type": "PropertyValue", name: "qualityPct", value: w.relative },
        { "@type": "PropertyValue", name: "openRouterId", value: w.openRouterId },
      ],
    },
  };
};
const ld = {
  "@context": "https://schema.org",
  "@type": "ItemList",
  name: `USE THIS MODEL picks for ${picks.date}`,
  itemListElement: [pickLD("agent", "Chatting"), pickLD("everyday", "Everyday Coding"), pickLD("hard", "Crazy Hard Coding")],
};
const ldJson = JSON.stringify(ld).replace(/</g, "\\u003c");

const htmlTemplate = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#2345ff">
<meta name="description" content="Today's best AI model for chatting, coding, and hard coding - recomputed from live benchmarks.">
<link rel="describedby" href="/llms.txt">
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">
<link rel="icon" type="image/png" sizes="64x64" href="/favicon-64.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta property="og:title" content="Use This Model - Today's Best Model">
<meta property="og:description" content="Today's best AI model for chatting, coding, and hard coding - recomputed from live benchmarks.">
<meta property="og:image" content="https://usethismodel.vercel.app/og-image.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="1200">
<meta property="og:url" content="https://usethismodel.vercel.app/">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary_large_image">
<script type="application/ld+json">{LDJSON}</script>
<title>Use This Model - Today's Best Model</title>
<style>
*{box-sizing:border-box}
html{min-height:100%}
body{margin:0;min-height:100svh;padding:clamp(20px,3vw,52px);display:flex;flex-direction:column;background:#2345ff;color:#fff;font-family:Arial,Helvetica,sans-serif;-webkit-font-smoothing:antialiased}
header{margin-bottom:clamp(28px,4vh,48px)}
h1{margin:0;font-size:clamp(26px,7vw,112px);white-space:nowrap;font-weight:900;line-height:.96;letter-spacing:-.065em}
header p{margin:18px 0 0;font-size:clamp(18px,1.7vw,26px);line-height:1.35}
.pick-date{display:flex;align-items:center;flex-wrap:wrap;gap:12px 20px;margin-top:22px;font-size:clamp(16px,1.4vw,22px);font-weight:700}
.pick-date .calc-time{font-weight:400;opacity:.65;font-size:.8em}
.recalculate{padding:10px 18px;border:2px solid currentColor;border-radius:999px;background:transparent;color:inherit;font:inherit;font-size:14px;cursor:pointer}
.recalculate:disabled{opacity:.55;cursor:default}
main{flex:1;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:clamp(14px,1.5vw,24px)}
article{min-height:460px;padding:clamp(24px,2.6vw,44px);border-radius:24px;display:flex;flex-direction:column;color:#141414;cursor:pointer}
.chat{background:#c5ff32}.everyday{background:#ff795e}.hard{background:#7926ec;color:#fff}
h2{margin:0;max-width:10em;font-size:clamp(29px,3vw,48px);font-weight:800;line-height:1.03;letter-spacing:-.045em}
.explanation{margin:14px 0 0;font-size:clamp(15px,1.2vw,20px);line-height:1.4;max-width:28em;text-wrap:pretty}
h3{margin:auto 0 0;padding-top:65px;font-size:clamp(42px,5vw,84px);font-weight:900;line-height:.97;letter-spacing:-.055em;position:relative}
h3 span{display:block}
h3 .thinking{position:absolute;top:12px;left:0;display:inline-flex;align-items:center;padding:7px 12px;border:2px solid currentColor;border-radius:999px;font-size:clamp(12px,1.1vw,16px);font-weight:900;line-height:1;letter-spacing:.045em;white-space:nowrap;text-transform:uppercase}
.details{display:flex;flex-wrap:wrap;gap:8px 22px;margin:28px 0 0;font-size:15px;line-height:1.5}
.tap{margin:14px 0 0;font-size:13px;font-weight:900;letter-spacing:.07em;text-transform:uppercase;opacity:.85}
.hard .tap{opacity:1}
footer{padding-top:20px;text-align:center;font-size:12px;line-height:1.4}
footer a,.explain a,.why a,.norm-note a{color:inherit}
.modal{display:none;position:fixed;inset:0;background:rgba(10,10,40,.72);z-index:50;overflow-y:auto;padding:clamp(12px,3vw,40px)}
.modal.open{display:block}
.modal-card{max-width:920px;margin:0 auto;border-radius:24px;padding:clamp(24px,3vw,44px);position:relative;background:#ff795e;color:#141414}
.modal-card.chat{background:#c5ff32}.modal-card.everyday{background:#ff795e}.modal-card.hard{background:#7926ec;color:#fff}
.close{position:absolute;top:14px;right:16px;border:2px solid currentColor;background:transparent;color:inherit;font-size:26px;font-weight:900;width:44px;height:44px;border-radius:50%;cursor:pointer;line-height:1}
.kicker{margin:0;font-size:clamp(13px,1.4vw,16px);font-weight:900;letter-spacing:.09em;text-transform:uppercase}
.winner{margin:18px 0 0;display:flex;flex-wrap:wrap;gap:10px;align-items:center}
.winner .use{background:#141414;color:#fff;font-weight:900;font-size:13px;letter-spacing:.08em;padding:8px 14px;border-radius:999px;text-transform:uppercase}
.winner .name{font-weight:900;font-size:clamp(20px,2.6vw,32px);letter-spacing:-.03em}
.think{display:inline-block;border:2px solid currentColor;border-radius:999px;padding:6px 12px;font-size:12px;font-weight:900;letter-spacing:.06em;text-transform:uppercase}
.why{margin:12px 0 0;font-size:clamp(16px,1.8vw,22px);line-height:1.35;font-weight:700}
.chart-box{margin-top:24px;background:#fff;border-radius:16px;padding:clamp(14px,2vw,24px);color:#141414}
.chart-box h2{margin:0 0 4px;font-size:15px;font-weight:900;letter-spacing:.05em;text-transform:uppercase}
.chart-box .sub{margin:0 0 12px;font-size:13px;font-weight:700}
.legend{display:flex;flex-wrap:wrap;gap:6px 14px;margin:2px 0 8px;font-size:12px;font-weight:700;color:#343a40}
.legend i{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:5px;vertical-align:baseline}
svg{width:100%;height:auto;display:block}
.explain{margin:16px 0 0;font-size:clamp(14px,1.5vw,17px);line-height:1.5;max-width:60em}
table{width:100%;margin-top:20px;border-collapse:collapse;font-size:14px;background:#fff;color:#141414;border-radius:16px;overflow:hidden}
caption{text-align:left;font-weight:900;font-size:13px;letter-spacing:.06em;text-transform:uppercase;padding:14px 16px 0}
th,td{text-align:left;padding:11px 14px;border-top:2px solid #ff795e}
th{font-size:12px;letter-spacing:.06em;text-transform:uppercase}
th button{background:none;border:0;padding:0;font:inherit;font-size:12px;font-weight:900;letter-spacing:.06em;text-transform:uppercase;color:inherit;cursor:pointer}
th button:hover{text-decoration:underline}
.chart-box{position:relative}
.yrange{margin:0 0 10px;padding:6px 14px;border:2px solid #141414;border-radius:999px;background:#fff;color:#141414;font-size:12px;font-weight:900;letter-spacing:.05em;text-transform:uppercase;cursor:pointer}
.norm-note{margin:10px 2px 0;font-size:12px;color:#495057}
svg circle.dot{cursor:pointer}
.tip{position:absolute;z-index:5;max-width:230px;background:#141414;color:#fff;border-radius:12px;padding:10px 14px;font-size:13px;line-height:1.5;box-shadow:0 6px 20px rgba(0,0,0,.35)}
.tip strong{display:block;font-size:14px;margin-bottom:2px}
tr.win td{background:#141414;color:#fff;font-weight:900}
tr.below td{opacity:.55}
.id-row{margin-top:16px;background:#141414;color:#fff;border-radius:14px;padding:14px 16px;font-size:14px;display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center}
.id-row code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px;background:#2a2a2a;padding:8px 12px;border-radius:8px;word-break:break-all}
.id-row .tag{font-size:12px;font-weight:900;letter-spacing:.07em;text-transform:uppercase;color:#c5ff32}
@media(max-width:850px){main{grid-template-columns:1fr}article{min-height:390px;padding:30px}h2{max-width:none;font-size:clamp(32px,7vw,48px)}h3{font-size:clamp(52px,10vw,80px);padding-top:52px}.explanation{font-size:16px}header{padding-top:8px}}
@media(max-width:640px){th:nth-child(2),td:nth-child(2){display:none}.id-row code{font-size:12px}}
</style>
</head>
<body>
<header>
<h1>USE THIS MODEL</h1>
<p>We crunch every major benchmark so you don't have to. Here's what to use right now.</p>
<div class="pick-date">
<time datetime="${picks.date}">Picks for ${esc(dateStr)}</time> <span class="calc-time" data-calc-utc="${calcISO}">\u00B7 ${esc(calcPT)}</span>
<!-- WebMCP declarative tool: browser agents call recalculate_picks instead of clicking. -->
<form id="recalc-form" method="POST" action="${RECALC_URL}" toolname="recalculate_picks" tooldescription="Check whether today's picks are stale and trigger a fresh benchmark recompute. POSTs to the recalculation endpoint; responds already-fresh or recalculation-started." toolautosubmit>
<button class="recalculate" id="recalc" type="submit">Recalculate for today</button>
</form>
</div>
</header>
<main aria-label="AI model recommendations">
${card("agent", "chat")}
${card("everyday", "everyday")}
${card("hard", "hard")}
</main>
<footer>Updated ${esc(dateStr)} - ${linkify("scores: AA Intelligence Index (chat), DeepSWE v1.1 + Design Arena Full-Stack (coding)")}</footer>
${modal("agent", "chat", "AA Intelligence Index", 90, why.agent)}
${modal("everyday", "everyday", "DeepSWE + Design Arena", 90, why.everyday)}
${modal("hard", "hard", "DeepSWE + Design Arena", 97, why.hard)}
<script>
(function(){
function open(key){var m=document.getElementById("modal-"+key);if(m){m.classList.add("open");m.setAttribute("aria-hidden","false");}}
function close(key){var m=document.getElementById("modal-"+key);if(m){m.classList.remove("open");m.setAttribute("aria-hidden","true");var t=m.querySelector(".tip");if(t)t.hidden=true;}}
document.querySelectorAll("[data-open]").forEach(function(el){
el.addEventListener("click",function(){open(el.getAttribute("data-open"));});
el.addEventListener("keydown",function(e){if(e.key==="Enter"||e.key===" "){e.preventDefault();open(el.getAttribute("data-open"));}});
});
document.querySelectorAll("[data-close]").forEach(function(b){b.addEventListener("click",function(e){e.stopPropagation();close(b.getAttribute("data-close"));});});
document.querySelectorAll(".modal").forEach(function(m){m.addEventListener("click",function(e){if(e.target===m)m.classList.remove("open");});});
document.addEventListener("keydown",function(e){if(e.key==="Escape")document.querySelectorAll(".modal.open").forEach(function(m){m.classList.remove("open");var t=m.querySelector(".tip");if(t)t.hidden=true;});});
// Tap/hover tooltips for chart dots (touch + desktop; native <title> covers desktop hover).
document.querySelectorAll(".chart-box").forEach(function(box){
var svg=box.querySelector("svg"),tip=box.querySelector(".tip");
if(!svg||!tip)return;
svg.addEventListener("click",function(e){
var dot=e.target&&e.target.closest?e.target.closest("circle.dot"):null;
if(!dot){tip.hidden=true;return;}
e.stopPropagation();
var s="<strong>"+dot.getAttribute("data-name")+(dot.getAttribute("data-win")?" &#9733; USE THIS":"")+"</strong>"+dot.getAttribute("data-org")+" · Score "+dot.getAttribute("data-score")+"% · $"+dot.getAttribute("data-cost")+"/task";
tip.innerHTML=s;
tip.style.visibility="hidden";tip.hidden=false;
var svgR=svg.getBoundingClientRect(),boxR=box.getBoundingClientRect();
var cx=parseFloat(dot.getAttribute("cx")),cy=parseFloat(dot.getAttribute("cy"));
var px=svgR.left-boxR.left+(cx/760)*svgR.width,py=svgR.top-boxR.top+(cy/520)*svgR.height;
var tw=tip.offsetWidth,th=tip.offsetHeight;
var left=px+14;if(left+tw>boxR.width-8)left=px-tw-14;if(left<8)left=8;
var top=py-th-14;if(top<8)top=py+18;
tip.style.left=left+"px";tip.style.top=top+"px";tip.style.visibility="";
});
});
// Sortable data tables: click Model / Score / Price headers to toggle asc/desc.
document.querySelectorAll("table.sortable").forEach(function(tbl){
var body=tbl.querySelector("tbody");
tbl.querySelectorAll("th button[data-col]").forEach(function(btn){
btn.addEventListener("click",function(e){
e.stopPropagation();
var col=parseInt(btn.getAttribute("data-col"),10);
var num=btn.getAttribute("data-type")==="num";
var dir=btn.getAttribute("data-dir")==="asc"?"desc":"asc";
btn.setAttribute("data-dir",dir);
tbl.querySelectorAll("th button[data-col]").forEach(function(b){
var label=b.textContent.replace(/ [▲▼]$/,"");
b.textContent=label+(b===btn?(dir==="asc"?" ▲":" ▼"):"");
});
var rows=Array.prototype.slice.call(body.rows);
rows.sort(function(a,b){
var ca=a.cells[col],cb=b.cells[col];
var va=(ca.getAttribute("data-v")!=null&&ca.getAttribute("data-v")!=="")?ca.getAttribute("data-v"):ca.textContent.trim();
var vb=(cb.getAttribute("data-v")!=null&&cb.getAttribute("data-v")!=="")?cb.getAttribute("data-v"):cb.textContent.trim();
if(num&&(va===""||vb==="")){
if(va===""&&vb==="")return 0;
return (va==="")?1:-1;
}
var cmp=num?(parseFloat(va)-parseFloat(vb)):va.localeCompare(vb);
return dir==="asc"?cmp:-cmp;
});
rows.forEach(function(r){body.appendChild(r);});
});
});
});
// Y range toggle: zoomed (competitive range) <-> full (0 to top).
document.querySelectorAll(".chart-box").forEach(function(box){
var tbtn=box.querySelector(".yrange"),tsvg=box.querySelector("svg");
if(!tbtn||!tsvg)return;
tbtn.addEventListener("click",function(e){
e.stopPropagation();
var full=tbtn.getAttribute("data-mode")!=="full";
tbtn.setAttribute("data-mode",full?"full":"zoom");
tbtn.textContent=full?"Zoom In":"View All";
var yMinZ=parseFloat(tsvg.getAttribute("data-ymin-zoom")),
yMax=parseFloat(tsvg.getAttribute("data-ymax")),
T=parseFloat(tsvg.getAttribute("data-t")),
B=parseFloat(tsvg.getAttribute("data-b")),
cut=parseFloat(tsvg.getAttribute("data-cutoff"));
var Y=function(s){return full?B-((s-0)/(yMax-0))*(B-T):B-((s-yMinZ)/(yMax-yMinZ))*(B-T);};
tsvg.querySelectorAll("[data-y]").forEach(function(el){
var v=parseFloat(el.getAttribute("data-y")),dy=parseFloat(el.getAttribute("data-dy")||"0");
var ny=Math.round(Y(v)+dy),tag=el.tagName.toLowerCase();
if(tag==="circle")el.setAttribute("cy",ny);
else if(tag==="text")el.setAttribute("y",ny);
else if(tag==="line"){el.setAttribute("y1",ny);el.setAttribute("y2",ny);}
else if(tag==="rect")el.setAttribute("y",ny);
});
var z=tsvg.querySelector("[data-zone]");
if(z)z.setAttribute("height",Math.max(0,Math.round(Y(cut)-T)));
tsvg.querySelectorAll(".ygrid-zoom").forEach(function(g){g.style.display=full?"none":"";});
tsvg.querySelectorAll(".ygrid-full").forEach(function(g){g.style.display=full?"":"none";});
});
});
// WebMCP imperative tools + declarative form hookup. Human UX unchanged:
// the recalc form still POSTs the same endpoint; agents get structured tools.
// Imperative API: document.modelContext.registerTool({name, description,
// inputSchema, execute}) per https://webmachinelearning.github.io/webmcp/
// Declarative API: toolname/tooldescription/toolautosubmit on the recalc
// <form> per declarative-api-explainer.md in that repo.
var RECALC_ENDPOINT="${RECALC_URL}";
function collectPicks(){
var out={};
document.querySelectorAll("[data-webmcp-pick]").forEach(function(el){
var k=el.getAttribute("data-webmcp-pick");
out[k]={category:el.getAttribute("data-category"),model:el.getAttribute("data-model"),thinking:el.getAttribute("data-thinking"),pricePerTask:parseFloat(el.getAttribute("data-price")),qualityPct:parseFloat(el.getAttribute("data-quality")),openRouterId:el.getAttribute("data-openrouter-id")};
});
return out;
}
function doRecalc(){
return fetch(RECALC_ENDPOINT,{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"})
.then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j};});})
.then(function(res){
if(res.j&&res.j.recalculated)return "Recalculation started - fresh picks incoming, check back soon.";
return "Picks already fresh (last calc: "+((res.j&&res.j.last_calc)||"today")+").";
});
}
if(document.modelContext&&document.modelContext.registerTool){
try{
document.modelContext.registerTool({name:"get_picks",description:"Returns the 3 current model picks (chatting, everyday coding, crazy hard coding) with model name, thinking level, price per task, quality score, and copy-paste OpenRouter ID.",inputSchema:{type:"object",properties:{}},execute:function(){return Promise.resolve(JSON.stringify(collectPicks()));}});
document.modelContext.registerTool({name:"recalculate_picks",description:"Check whether today's picks are stale and trigger a fresh benchmark recompute.",inputSchema:{type:"object",properties:{}},execute:function(){return doRecalc();}});
}catch(e){}
}
var recalcForm=document.getElementById("recalc-form");
// Calc time: rewrite baked PT fallback in the viewer's own timezone.
(function(){try{var el=document.querySelector(".calc-time");if(!el||!el.getAttribute("data-calc-utc"))return;var d=new Date(el.getAttribute("data-calc-utc"));var s=d.toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",timeZoneName:"short"}).replace(/([AP]M)/,function(m){return m.toLowerCase();}).replace(/\s+(?=[AP]M)/i,"");el.textContent="\u00B7 "+s;}catch(e){}})();
if(recalcForm){recalcForm.addEventListener("submit",function(ev){
if(ev.agentInvoked&&ev.respondWith){ev.preventDefault();ev.respondWith(doRecalc());return;}
ev.preventDefault();
var btn=document.getElementById("recalc");
if(btn){btn.disabled=true;btn.textContent="Checking...";}
doRecalc().then(function(msg){if(btn)btn.textContent=msg;}).catch(function(){if(btn){btn.textContent="Recalculate for today";btn.disabled=false;}});
});}
})();
</script>
</body>
</html>`;

const html = htmlTemplate.split("{LDJSON}").join(ldJson);

// ---- llms.txt (https://llmstxt.org/ spec v2: H1 + blockquote + H2 file lists) ----
function pickLine(key, title) {
  const w = picks[key].winner;
  const [l1, l2] = displayName(w.openRouterId);
  const full = `${l1}${l2 ? " " + l2 : ""}`;
  return `- [${title}: ${full} (${effortLabel(w.effort)})](https://usethismodel.vercel.app/) - $${w.costPerTask}/task, quality ${w.relative}%, copy-paste OpenRouter ID: \`${w.openRouterId}\``;
}
const llms = `# USE THIS MODEL

> ${dateStr} picks: the single best AI model to use today for chatting, everyday coding, and crazy-hard coding, recomputed from live benchmarks.

Cheapest model clearing the cutoff wins: 90% of frontier quality for chatting and everyday coding, 97% for crazy-hard coding. Chat score = Artificial Analysis Intelligence Index; coding score = 50% DeepSWE + 50% Design Arena Full-Stack (both min-max normalized 0-100; single-signal models pass at 100%).

## Picks

${pickLine("agent", "Chatting")}
${pickLine("everyday", "Everyday Coding")}
${pickLine("hard", "Crazy Hard Coding")}

## Full page

- [USE THIS MODEL - interactive charts, tables, detail popups](https://usethismodel.vercel.app/)

## For agents

The full page exposes two WebMCP tools (spec: https://webmachinelearning.github.io/webmcp/):
- \`get_picks\`: Returns the 3 current picks as structured JSON (no args).
- \`recalculate_picks\`: Triggers a fresh benchmark recompute (no args).

How to call:
- Requires a WebMCP-capable browser (Chrome 146+ with WebMCP enabled).
- Call them through the browser agent's \`modelContext\`.

Fallback: Without a WebMCP browser, this llms.txt is the machine-readable source of truth - re-fetch it for fresh picks.
`;

mkdirSync(dirname(OUT), { recursive: true });
let out = html;
writeFileSync(OUT, out);
console.log(`wrote ${OUT} (${out.length} bytes)`);
writeFileSync(dirname(OUT) + "/llms.txt", llms);
console.log(`wrote ${dirname(OUT)}/llms.txt (${llms.length} bytes)`);

// Static brand assets: copy assets/* (og-image, favicons) into dist/ so they
// survive fresh renders and weekly workflow runs.
try {
  for (const f of readdirSync("assets")) {
    copyFileSync(`assets/${f}`, `${dirname(OUT)}/${f}`);
  }
  console.log("copied assets/* -> " + dirname(OUT));
} catch (e) {
  console.log("no assets/ dir, skipping static copy");
}
