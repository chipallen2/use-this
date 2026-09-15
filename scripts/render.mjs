// scripts/render.mjs — builds dist/index.html from data/picks.json + data/candidates.json
// Locked design: v4.html landing + popup.html detail. Inline CSS, inline SVG, tiny inline JS (modal only).
// Usage: node scripts/render.mjs [datadir] [outpath]

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

const DATA = process.argv[2] || "data";
const OUT = process.argv[3] || "dist/index.html";

const RECALC_URL = process.env.RECALC_URL || "RECALC_URL_PLACEHOLDER";

const picks = JSON.parse(readFileSync(`${DATA}/picks.json`, "utf8"));
const cands = JSON.parse(readFileSync(`${DATA}/candidates.json`, "utf8"));

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

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
    [/^gemini-3\.8-flash$/, ["Gemini 3.8", "Flash"]],
    [/^gemini-3\.7-flash$/, ["Gemini 3.7", "Flash"]],
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

function cardClass(key) { return key === "agent" ? "chat" : key === "everyday" ? "everyday" : "hard"; }
function cardTitle(key) { return key === "agent" ? "Chatting" : key === "everyday" ? "Everyday Coding" : "Crazy Hard Coding"; }
function cardExpl(key) {
  return key === "agent" ? "Best for everyday chats"
    : key === "everyday" ? "Best for normal coding"
    : "Best money-no-object pick for really hard tasks";
}

// Inline SVG scatter: x = price (cheap on RIGHT), y = score. Top 8 by (score desc, price asc), winner highlighted.
function scatter(list, winner, cutoff, color, benchLabel) {
  const pts = [...list].sort((a, b) => b.score - a.score || a.costPerTask - b.costPerTask).slice(0, 8);
  const W = 720, H = 470, L = 70, R = 695, T = 30, B = 380;
  const scores = pts.map((p) => p.score);
  const costs = pts.map((p) => p.costPerTask);
  const sMin = Math.min(cutoff, ...scores), sMax = Math.max(...scores);
  const cMin = Math.min(...costs), cMax = Math.max(...costs);
  const padS = Math.max(0.5, (sMax - sMin) * 0.15);
  const y = (s) => B - ((s - (sMin - padS)) / ((sMax + padS) - (sMin - padS))) * (B - T);
  const logMin = Math.log10(Math.max(0.05, cMin * 0.8)), logMax = Math.log10(cMax * 1.15);
  const x = (c) => R - ((Math.log10(Math.max(0.05, c)) - logMin) / Math.max(0.01, logMax - logMin)) * (R - L);
  const yCut = y(cutoff);
  const frontier = pts.reduce((a, b) => (b.score > a.score ? b : a));
  const short = (p) => esc(`${displayName(p.openRouterId)[0]}${p.effort ? " " + p.effort : ""}`.slice(0, 18));
  const key = (p) => p.openRouterId + "|" + p.effort;
  const cheapest = pts.reduce((a, b) => (b.costPerTask < a.costPerTask ? b : a));
  const priciest = pts.reduce((a, b) => (b.costPerTask > a.costPerTask ? b : a));
  const labeled = new Set([key(winner), key(frontier), key(cheapest), key(priciest)]);
  let dots = "";
  let below = false;
  for (const p of pts) {
    const isWin = key(p) === key(winner);
    const cx = Math.round(x(p.costPerTask)), cy = Math.round(y(p.score));
    if (isWin) {
      dots += `<circle cx="${cx}" cy="${cy}" r="14" fill="#2345ff" stroke="#141414" stroke-width="3"/>`;
      dots += `<text x="${cx}" y="${cy - 24}" font-size="13" font-weight="900" fill="#2345ff" text-anchor="middle">USE THIS</text>`;
      dots += `<text x="${cx}" y="${cy + 34}" font-size="11" font-weight="900" fill="#2345ff" text-anchor="middle">${short(p)}</text>`;
    } else {
      dots += `<circle cx="${cx}" cy="${cy}" r="10" fill="#141414"/>`;
      if (labeled.has(key(p))) {
        below = !below;
        const ly = below ? cy + 26 : cy - 20;
        dots += `<text x="${cx}" y="${ly}" font-size="11" font-weight="900" fill="#141414" text-anchor="middle">${short(p)}</text>`;
      }
    }
  }
  const fx = Math.round(x(frontier.costPerTask)), fy = Math.round(y(frontier.score));
  const fl = fy - 30 < 24 ? fy + 44 : fy - 30;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Scatter chart of price versus ${esc(benchLabel)} score">
<line x1="${L}" y1="${T}" x2="${L}" y2="${B}" stroke="#141414" stroke-width="3"/>
<line x1="${L}" y1="${B}" x2="${R}" y2="${B}" stroke="#141414" stroke-width="3"/>
<line x1="${L}" y1="${yCut}" x2="${R}" y2="${yCut}" stroke="#141414" stroke-width="2.5" stroke-dasharray="9 7"/>
<text x="600" y="${Math.round(yCut) - 8}" font-size="13" font-weight="900" fill="#141414">CUTOFF</text>
<text x="${L}" y="${Math.round(y(sMax)) - 8}" font-size="12" font-weight="700" fill="#141414">${sMax}%</text>
<text x="${L}" y="${Math.round(yCut) + 18}" font-size="12" font-weight="700" fill="#141414">${cutoff}%</text>
<text x="16" y="210" font-size="13" font-weight="900" fill="#141414" transform="rotate(-90 16 210)">${esc(benchLabel)} score</text>
<text x="${L}" y="402" font-size="12" font-weight="900" fill="#141414">$${cMax} EXPENSIVE</text>
<text x="560" y="402" font-size="12" font-weight="900" fill="#141414">CHEAPEST $ &#8594;</text>
<text x="250" y="428" font-size="13" font-weight="900" fill="#141414">price per task (cheapest on RIGHT)</text>
<text x="120" y="${fl}" font-size="14" font-weight="900" fill="#141414">FRONTIER</text>
<line x1="150" y1="${fl + 4}" x2="${fx + 14}" y2="${fy - 14}" stroke="#141414" stroke-width="2.5"/>
${dots}
</svg>`;
}

function modal(key, color, benchLabel, thresholdPct, whyText) {
  const w = picks[key].winner;
  const list = cands[key];
  const cutoff = picks[key].cutoff;
  const [l1, l2] = displayName(w.openRouterId);
  const rows = [...list].sort((a, b) => a.costPerTask - b.costPerTask).map((p) => {
    const isWin = p.openRouterId === w.openRouterId && p.effort === w.effort;
    const [n1, n2] = displayName(p.openRouterId);
    return `<tr${isWin ? ' class="win"' : ""}><td>${esc(n1 + (n2 ? " " + n2 : ""))}${isWin ? " &#9733;" : ""}</td><td>${esc(p.effort || "default")}</td><td>${p.score}%</td><td>$${p.costPerTask}</td></tr>`;
  }).join("");
  return `<div class="modal" id="modal-${key}" aria-hidden="true"><div class="modal-card ${color}" role="dialog" aria-label="${cardTitle(key)} detail">
<button class="close" data-close="${key}" aria-label="Close">&times;</button>
<p class="kicker">${cardTitle(key)} - detail</p>
<p class="winner"><span class="use">Use this</span><span class="name">${esc(l1 + (l2 ? " " + l2 : ""))}</span><span class="think">${esc(effortLabel(w.effort))}</span></p>
<p class="why">${whyText}</p>
<div class="chart-box"><h2>Price vs quality</h2><p class="sub">Right = cheaper. Up = better ${esc(benchLabel)} score.</p>
${scatter(list, w, cutoff, color, benchLabel)}
<p class="explain"><strong>Score = ${esc(benchLabel)},</strong> cutoff = ${thresholdPct}% of the best (frontier) score, here ${cutoff}%. Cheapest model above the cutoff wins.</p>
<table><caption>All contenders</caption><tr><th>Model</th><th>Thinking</th><th>Score</th><th>Price/task</th></tr>${rows}</table>
<div class="id-row"><span class="tag">Copy-paste OpenRouter ID</span><code>${esc(w.openRouterId)}</code></div>
</div></div></div>`;
}

const dateStr = new Date(picks.date + "T12:00:00").toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

function card(key, color) {
  const w = picks[key].winner;
  const [l1, l2] = displayName(w.openRouterId);
  const quality = w.relative;
  return `<article class="${color}" data-open="${key}" tabindex="0" role="button" aria-label="${cardTitle(key)} detail">
<h2>${cardTitle(key)}</h2>
<p class="explanation">${cardExpl(key)}</p>
<h3><span class="thinking">${esc(effortLabel(w.effort))}</span><span>${esc(l1)}</span>${l2 ? `<span>${esc(l2)}</span>` : ""}</h3>
<p class="details"><span>Price <strong>$${w.costPerTask}</strong></span><span>Quality <strong>${quality}%</strong></span></p>
<p class="tap">Tap for detail &#8594;</p>
</article>`;
}

const why = {
  agent: `Cheapest chat model clearing 90% of frontier quality at $${picks.agent.winner.costPerTask}/task.`,
  everyday: `Cheapest model clearing 90% of frontier DeepSWE quality at $${picks.everyday.winner.costPerTask}/task.`,
  hard: `Cheapest model clearing 97% of frontier DeepSWE quality at $${picks.hard.winner.costPerTask}/task. Frontier quality without the frontier bill.`,
};

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#2345ff">
<title>USE THIS - Today's Best Model</title>
<style>
*{box-sizing:border-box}
html{min-height:100%}
body{margin:0;min-height:100svh;padding:clamp(20px,3vw,52px);display:flex;flex-direction:column;background:#2345ff;color:#fff;font-family:Arial,Helvetica,sans-serif;-webkit-font-smoothing:antialiased}
header{margin-bottom:clamp(28px,4vh,48px)}
h1{margin:0;font-size:clamp(26px,7vw,112px);white-space:nowrap;font-weight:900;line-height:.96;letter-spacing:-.065em}
header p{margin:18px 0 0;font-size:clamp(18px,1.7vw,26px);line-height:1.35}
.pick-date{display:flex;align-items:center;flex-wrap:wrap;gap:12px 20px;margin-top:22px;font-size:clamp(16px,1.4vw,22px);font-weight:700}
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
svg{width:100%;height:auto;display:block}
.explain{margin:16px 0 0;font-size:clamp(14px,1.5vw,17px);line-height:1.5;max-width:60em}
table{width:100%;margin-top:20px;border-collapse:collapse;font-size:14px;background:#fff;color:#141414;border-radius:16px;overflow:hidden}
caption{text-align:left;font-weight:900;font-size:13px;letter-spacing:.06em;text-transform:uppercase;padding:14px 16px 0}
th,td{text-align:left;padding:11px 14px;border-top:2px solid #ff795e}
th{font-size:12px;letter-spacing:.06em;text-transform:uppercase}
tr.win td{background:#141414;color:#fff;font-weight:900}
.id-row{margin-top:16px;background:#141414;color:#fff;border-radius:14px;padding:14px 16px;font-size:14px;display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center}
.id-row code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px;background:#2a2a2a;padding:8px 12px;border-radius:8px;word-break:break-all}
.id-row .tag{font-size:12px;font-weight:900;letter-spacing:.07em;text-transform:uppercase;color:#c5ff32}
@media(max-width:850px){main{grid-template-columns:1fr}article{min-height:390px;padding:30px}h2{max-width:none;font-size:clamp(32px,7vw,48px)}h3{font-size:clamp(52px,10vw,80px);padding-top:52px}.explanation{font-size:16px}header{padding-top:8px}}
@media(max-width:640px){th:nth-child(2),td:nth-child(2){display:none}.id-row code{font-size:12px}}
</style>
</head>
<body>
<header>
<h1>TODAY'S BEST MODEL</h1>
<p>We crunch every major benchmark so you don't have to. Here's what to use right now.</p>
<div class="pick-date">
<time datetime="${picks.date}">Picks for ${esc(dateStr)}</time>
<button class="recalculate" id="recalc" type="button">Recalculate for today</button>
</div>
</header>
<main aria-label="AI model recommendations">
${card("agent", "chat")}
${card("everyday", "everyday")}
${card("hard", "hard")}
</main>
<footer>Updated ${esc(dateStr)} - scores: AA Intelligence Index (chat), DeepSWE v1.1 (coding)</footer>
${modal("agent", "chat", "AA Intelligence Index", 90, why.agent)}
${modal("everyday", "everyday", "DeepSWE v1.1", 90, why.everyday)}
${modal("hard", "hard", "DeepSWE v1.1", 97, why.hard)}
<script>
(function(){
function open(key){var m=document.getElementById("modal-"+key);if(m){m.classList.add("open");m.setAttribute("aria-hidden","false");}}
function close(key){var m=document.getElementById("modal-"+key);if(m){m.classList.remove("open");m.setAttribute("aria-hidden","true");}}
document.querySelectorAll("[data-open]").forEach(function(el){
el.addEventListener("click",function(){open(el.getAttribute("data-open"));});
el.addEventListener("keydown",function(e){if(e.key==="Enter"||e.key===" "){e.preventDefault();open(el.getAttribute("data-open"));}});
});
document.querySelectorAll("[data-close]").forEach(function(b){b.addEventListener("click",function(e){e.stopPropagation();close(b.getAttribute("data-close"));});});
document.querySelectorAll(".modal").forEach(function(m){m.addEventListener("click",function(e){if(e.target===m)m.classList.remove("open");});});
document.addEventListener("keydown",function(e){if(e.key==="Escape")document.querySelectorAll(".modal.open").forEach(function(m){m.classList.remove("open");});});
var btn=document.getElementById("recalc");
if(btn){btn.addEventListener("click",function(){
btn.disabled=true;btn.textContent="Checking...";
fetch("${RECALC_URL}",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"})
.then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j};});})
.then(function(res){
if(res.j&&res.j.recalculated){btn.textContent="Fresh picks incoming - check back soon!";}
else{btn.textContent="Already fresh ("+((res.j&&res.j.last_calc)||"today")+")."; }
})
.catch(function(){btn.textContent="Recalculate for today";btn.disabled=false;});
});}
})();
</script>
</body>
</html>`;

mkdirSync(dirname(OUT), { recursive: true });
let out = html;
writeFileSync(OUT, out);
console.log(`wrote ${OUT} (${out.length} bytes)`);
