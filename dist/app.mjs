// web/app.mjs - browser UI. Served as /app.mjs next to /calc.mjs (a byte-for-
// byte copy of lib/calc.mjs) and /models.json (the daily data). All picks
// are computed here from the URL with the same module the bot endpoint uses.
import * as C from "./calc.mjs";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const money = (n) => (n == null ? "n/a" : "$" + +Number(n).toPrecision(3));
const COLORS = { chat: "chat", code: "everyday", crazy: "hard" };
const catTitle = (k) => C.CATEGORIES.find((c) => c.key === k).title;

let DATA = null, SETTINGS = null, PICKS = null;

// ---------- settings form (landing page + Customize popup) ----------
function benchLabel(b) { return b.key.toUpperCase() + " - " + b.name; }
function categoryFieldset(key, cat, { locks }) {
  const chosen = new Map((cat?.bench || []).map((b) => [b.key, b.w]));
  const counts = DATA.benchmarks;
  const benches = C.BENCHMARKS.map((b) => `<label class="bench"><input type="checkbox" name="b" value="${b.key}"${chosen.has(b.key) ? " checked" : ""}>
<span>${esc(benchLabel(b))} <small>(${counts[b.key]?.models ?? 0} models)</small></span>
<input type="number" class="w" name="w-${b.key}" value="${chosen.get(b.key) ?? 1}" min="0.1" max="100" step="any" aria-label="${esc(b.key)} weight" title="Weight"></label>`).join("");
  const miss = cat?.miss || C.DEFAULT_MISS;
  const lockSel = locks ? `<label>Lock to model <select name="lock"><option value="">Not locked (pick automatically)</option>${modelOptions(cat?.lock)}</select></label>` : "";
  return `<fieldset data-cat="${key}" class="cat ${COLORS[key]}"><legend>${esc(catTitle(key))}</legend>
<div class="benches"><p class="hint">Benchmarks + weight</p>${benches}</div>
<div class="nums">
<label>Max price <small>$ per 1M input tokens</small><input type="number" name="max" min="0" max="1000" step="any" value="${cat?.max ?? ""}"></label>
<label>Min score <small>0-100</small><input type="number" name="min" min="0" max="100" step="any" value="${cat?.min ?? ""}"></label>
<label>Missing data <select name="miss">${C.MISS_MODES.map((m) => `<option value="${m}"${m === miss ? " selected" : ""}>${m}</option>`).join("")}</select></label>
<label class="cov"${miss === "reweight" ? "" : " hidden"}>Min coverage % <small>reweight only, optional</small><input type="number" name="cov" min="0" max="100" step="any" value="${cat?.cov ?? ""}"></label>
${lockSel}
</div></fieldset>`;
}
function modelOptions(selected) {
  return [...DATA.models].sort((a, b) => (a.org + a.name).localeCompare(b.org + b.name))
    .map((m) => `<option value="${esc(m.id)}"${m.id === selected ? " selected" : ""}>${esc(m.org + ": " + m.name)} - ${money(m.input)}/1M</option>`).join("");
}
function settingsForm(settings, opts) {
  return C.CATEGORY_KEYS.map((k) => categoryFieldset(k, settings[k], opts)).join("");
}
function wireForm(root) {
  $$("select[name=miss]", root).forEach((s) => s.addEventListener("change", () => {
    $(".cov", s.closest("fieldset")).hidden = s.value !== "reweight";
  }));
}
// Form -> raw params -> the same parseSettings the URL goes through.
function readForm(root) {
  const p = new URLSearchParams();
  for (const fs of $$("fieldset[data-cat]", root)) {
    const k = fs.dataset.cat;
    const benches = $$("input[name=b]:checked", fs).map((cb) => {
      const w = $(`input[name=w-${cb.value}]`, fs).value.trim();
      return w === "" || Number(w) === 1 ? cb.value : `${cb.value}:${w}`;
    });
    p.set(k, benches.join(","));
    p.set(`${k}_max`, $("input[name=max]", fs).value.trim());
    p.set(`${k}_min`, $("input[name=min]", fs).value.trim());
    const miss = $("select[name=miss]", fs).value;
    if (miss !== C.DEFAULT_MISS) p.set(`${k}_miss`, miss);
    const cov = $("input[name=cov]", fs).value.trim();
    if (miss === "reweight" && cov !== "") p.set(`${k}_cov`, cov);
    const lock = $("select[name=lock]", fs)?.value;
    if (lock) p.set(`${k}_lock`, lock);
  }
  return C.parseSettings(p);
}
function submitForm(root, errBox) {
  const parsed = readForm(root);
  if (!parsed.ok) {
    errBox.hidden = false;
    errBox.innerHTML = "<strong>Fix these settings:</strong><ul>" + parsed.errors.map((e) => `<li><code>${esc(e.param)}</code> ${esc(e.problem)}</li>`).join("") + "</ul>";
    return;
  }
  location.assign("/?" + C.serializeSettings(parsed.settings));
}

// ---------- landing / invalid ----------
function renderLanding(parsed) {
  const invalid = !parsed.empty;
  $("#main").innerHTML = `<section class="landing">
${invalid ? `<div class="errors" id="url-errors"><strong>This link has settings we can't use.</strong><ul>${parsed.errors.map((e) => `<li><code>${esc(e.param)}</code> ${esc(e.problem)}</li>`).join("")}</ul><p>Start again from the recommended settings below, or see the <a href="/docs">docs</a>.</p></div>` : ""}
<p class="lede">Tell your team which AI model to use. Choose the benchmarks you trust, the most you'll pay and the lowest score you'll accept for each job. We pick the <strong>cheapest model that clears the bar</strong>, updated daily.</p>
<p class="lede small">Everything lives in the link you get, so save it, share it, or put it behind your own short link. <a href="/docs">How settings work</a>.</p>
<form id="landing-form" novalidate>
<div class="cats">${settingsForm(C.RECOMMENDED, { locks: false })}</div>
<div class="errors" id="landing-errors" hidden></div>
<button type="submit" class="primary" id="generate">Generate my picks</button>
</form></section>`;
  const form = $("#landing-form");
  wireForm(form);
  form.addEventListener("submit", (e) => { e.preventDefault(); submitForm(form, $("#landing-errors")); });
}

// ---------- cards ----------
function card(key) {
  const p = PICKS[key], s = SETTINGS[key];
  const cls = COLORS[key];
  const w = p.winner;
  let body;
  if (!w) {
    body = `<h3 class="none"><span>No Model</span><span>Qualifies</span></h3>
<p class="details">Nothing scores ${esc(s.min)}+ at ${money(s.max)}/1M input or less. <a href="#" class="adjust" data-customize="1">Adjust settings</a></p>`;
  } else {
    const m = w.model;
    const badge = p.locked ? `<span class="thinking">Locked</span>` : "";
    body = `<h3>${badge}<span class="org">${esc(m.org || "")}</span><span>${esc(m.name)}</span></h3>
<p class="details">${p.lockedMissing ? `<span>Not in today's data</span>` : `<span>Input <strong>${money(m.input)}</strong> / 1M tokens</span><span>Score <strong>${w.score ?? "n/a"}</strong></span>`}</p>`;
  }
  return `<article class="card ${cls}" data-open="${key}" tabindex="0" role="button" aria-label="${esc(catTitle(key))} detail"
 data-webmcp-pick="${key}" data-status="${!w ? "none" : p.locked ? "locked" : "ok"}" data-model-id="${esc(w?.model.id || "")}">
<h2>${esc(catTitle(key))}</h2>
<p class="explanation">${esc(C.CATEGORIES.find((c) => c.key === key).blurb)}</p>
${body}
<p class="tap">Tap for detail &#8594;</p></article>`;
}
function renderPicks() {
  $("#main").innerHTML = `<div class="cards">${C.CATEGORY_KEYS.map(card).join("")}</div>`;
  $$("[data-open]").forEach((el) => {
    el.addEventListener("click", (e) => {
      if (e.target.closest("[data-customize]")) { e.preventDefault(); e.stopPropagation(); openCustomize(); return; }
      openDetail(el.dataset.open);
    });
    el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDetail(el.dataset.open); } });
  });
}

// ---------- detail popup ----------
function benchDesc(s) {
  const tot = s.bench.reduce((a, b) => a + b.w, 0);
  if (s.bench.length === 1) return C.benchmarkByKey(s.bench[0].key).name;
  return s.bench.map((b) => `${Math.round((b.w / tot) * 1000) / 10}% ${C.benchmarkByKey(b.key).name}`).join(" + ");
}
function chart(key) {
  const p = PICKS[key], s = SETTINGS[key];
  const rows = p.scored.filter((r) => Number.isFinite(r.model.input));
  const W = 760, H = 430, L = 56, R = 740, T = 18, B = 370;
  const prices = rows.map((r) => Math.max(0.001, r.model.input)).concat([Math.max(0.001, s.max)]);
  const lo = Math.log10(Math.min(...prices) * 0.7), hi = Math.log10(Math.max(...prices) * 1.4);
  const x = (v) => L + ((Math.log10(Math.max(0.001, v)) - lo) / Math.max(0.01, hi - lo)) * (R - L);
  const y = (v) => B - (v / 100) * (B - T);
  let g = "";
  for (let t = 0; t <= 100; t += 20) g += `<line x1="${L}" y1="${y(t)}" x2="${R}" y2="${y(t)}" stroke="#dee2e6"/><text x="${L - 8}" y="${y(t) + 4}" font-size="11" text-anchor="end" fill="#495057">${t}</text>`;
  for (const t of [0.001, 0.003, 0.01, 0.03, 0.1, 0.3, 1, 3, 10, 30, 100, 300, 1000]) {
    const xx = x(t);
    if (xx < L - 1 || xx > R + 1) continue;
    g += `<line x1="${xx}" y1="${T}" x2="${xx}" y2="${B}" stroke="#eef0f2"/><text x="${xx}" y="${B + 18}" font-size="11" text-anchor="middle" fill="#495057">$${t}</text>`;
  }
  const bx = Math.min(R, x(s.max)), by = y(s.min);
  const box = `<rect class="range" x="${L}" y="${T}" width="${Math.max(0, bx - L)}" height="${Math.max(0, by - T)}" fill="#e9fbe8" stroke="#2b8a3e" stroke-width="2" stroke-dasharray="7 5"/>
<text x="${L + 6}" y="${T + 14}" font-size="11" font-weight="900" fill="#2b8a3e">QUALIFYING RANGE: score &#8805; ${esc(s.min)}, input &#8804; ${money(s.max)}/1M</text>`;
  const winId = p.winner?.model.id;
  const qual = new Set(p.qualifying.map((r) => r.model.id));
  let dots = "", lab = "";
  for (const r of rows) {
    const cx = x(r.model.input).toFixed(1), cy = y(r.score).toFixed(1);
    const isWin = r.model.id === winId, isQ = qual.has(r.model.id);
    const tip = `${r.model.org}: ${r.model.name} - score ${r.score} - ${money(r.model.input)}/1M input${isWin ? " - USE THIS" : ""}`;
    dots += `<circle class="dot${isWin ? " win" : ""}" cx="${cx}" cy="${cy}" r="${isWin ? 11 : isQ ? 6 : 4.5}" fill="${isQ || isWin ? "#2345ff" : "#adb5bd"}"${isWin ? ' stroke="#141414" stroke-width="4"' : ""} data-id="${esc(r.model.id)}"><title>${esc(tip)}</title></circle>`;
    if (isWin) lab += `<text x="${cx}" y="${+cy - 18}" font-size="12" font-weight="900" text-anchor="middle" fill="#141414">&#9733; ${esc(r.model.name)}</text>`;
  }
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Input price versus score for every ranked model, with the qualifying range drawn">${g}${box}
<line x1="${L}" y1="${T}" x2="${L}" y2="${B}" stroke="#adb5bd"/><line x1="${L}" y1="${B}" x2="${R}" y2="${B}" stroke="#adb5bd"/>
${dots}${lab}
<text x="${(L + R) / 2}" y="${B + 40}" font-size="13" font-weight="900" text-anchor="middle">Input price, $ per 1M tokens (log scale) &#8594; pricier</text>
<text x="14" y="${(T + B) / 2}" font-size="12" font-weight="700" transform="rotate(-90 14 ${(T + B) / 2})" text-anchor="middle">Score (0-100)</text></svg>`;
}
function openDetail(key) {
  const p = PICKS[key], s = SETTINGS[key], w = p.winner;
  const qual = new Set(p.qualifying.map((r) => r.model.id));
  const head = `<th>Model</th><th>Score</th>${s.bench.length > 1 ? s.bench.map((b) => `<th>${esc(b.key.toUpperCase())}</th>`).join("") : ""}<th>Input $/1M</th><th>Output $/1M</th>`;
  const tr = (r) => `<tr class="${r.model.id === w?.model.id ? "win" : qual.has(r.model.id) ? "" : "below"}"><td>${esc(r.model.org + ": " + r.model.name)}${r.model.id === w?.model.id ? " &#9733;" : ""}</td><td>${r.score ?? "-"}</td>${s.bench.length > 1 ? s.bench.map((b) => `<td>${r.model.scores[b.key] ?? "-"}</td>`).join("") : ""}<td>${money(r.model.input)}</td><td>${money(r.model.output)}</td></tr>`;
  const ranked = [...p.scored].sort((a, b) => b.score - a.score || a.model.input - b.model.input);
  const why = w
    ? (p.locked ? `Locked in this link. The automatic pick would be ${p.qualifying[0] ? esc(p.qualifying[0].model.name) : "none (no model qualifies)"}.` : `Cheapest model scoring at least ${esc(s.min)} with input price at most ${money(s.max)} per 1M tokens.`)
    : `No model scores at least ${esc(s.min)} with input price at most ${money(s.max)} per 1M tokens. Nothing is inside the green box. <a href="#" data-customize="1">Adjust settings</a>`;
  $("#detail-body").innerHTML = `<div class="modal-card ${COLORS[key]}">
<button class="close" data-close aria-label="Close">&times;</button>
<p class="kicker">${esc(catTitle(key))} - detail</p>
<p class="winner">${w ? `<span class="use">${p.locked ? "Locked" : "Use this"}</span><span class="name">${esc((w.model.org ? w.model.org + ": " : "") + w.model.name)}</span>` : `<span class="use">No model qualifies</span>`}</p>
${w && !p.lockedMissing ? `<p class="prices">Input <strong>${money(w.model.input)}</strong> / 1M tokens &middot; Output <strong>${money(w.model.output)}</strong> / 1M tokens &middot; Score <strong>${w.score ?? "n/a"}</strong></p>` : ""}
<p class="why">${why}</p>
<div class="chart-box"><h2>Score vs input price</h2><p class="sub">Score = ${esc(benchDesc(s))}. Missing data: ${esc(s.miss)}${s.cov != null ? ` (min coverage ${esc(s.cov)}%)` : ""}. Hover a dot for details.</p>
${chart(key)}
<div class="table-scroll"><table><caption>Ranked models (dimmed = outside the range)</caption><thead><tr>${head}</tr></thead><tbody>${ranked.map(tr).join("")}</tbody></table></div>
${p.unscored.length ? `<details class="unscored"><summary>${p.unscored.length} models not ranked under these settings</summary><p>${p.unscored.map((r) => esc(r.model.name) + " (" + esc(r.reason) + ")").join(", ")}</p></details>` : ""}
<p class="norm-note">Scores are each benchmark rescaled 0-100 across the models we track (best = 100). Price is the OpenRouter input list price; real cost also depends on output tokens. <a href="/docs">Docs</a></p>
</div>
${w ? `<div class="id-row"><span class="tag">Copy-paste OpenRouter ID</span><code>${esc(w.model.id)}</code></div>` : ""}
</div>`;
  openModal("detail");
  $$("#detail [data-close]").forEach((b) => b.addEventListener("click", () => closeModal("detail")));
  $$("#detail [data-customize]").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); closeModal("detail"); openCustomize(); }));
}

// ---------- popups ----------
function openModal(id) { const m = $("#" + id); m.classList.add("open"); m.setAttribute("aria-hidden", "false"); }
function closeModal(id) { const m = $("#" + id); m.classList.remove("open"); m.setAttribute("aria-hidden", "true"); }
function openCustomize() {
  const base = SETTINGS || C.RECOMMENDED;
  $("#customize-cats").innerHTML = settingsForm(base, { locks: true });
  $("#customize-errors").hidden = true;
  wireForm($("#customize-form"));
  openModal("customize");
}
function lockUrl() {
  const s = structuredClone(SETTINGS);
  for (const k of C.CATEGORY_KEYS) s[k].lock = $(`#lock-${k}`).value || null;
  return location.origin + "/?" + C.serializeSettings(s);
}
function openLock() {
  $("#lock-cats").innerHTML = C.CATEGORY_KEYS.map((k) => `<label class="${COLORS[k]}">${esc(catTitle(k))}<select id="lock-${k}"><option value="">Not locked</option>${modelOptions(PICKS[k].winner?.model.id)}</select></label>`).join("");
  const upd = () => { $("#lock-url").value = lockUrl(); };
  $$("#lock-cats select").forEach((s) => s.addEventListener("change", upd));
  upd();
  openModal("lock");
}
async function copy(text, msg) {
  window.__lastCopied = text;
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); } catch {}
    ta.remove();
  }
  toast(msg);
}
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 2500);
}

// ---------- boot ----------
async function main() {
  try {
    const r = await fetch("/models.json", { cache: "no-cache" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    DATA = await r.json();
  } catch (e) {
    $("#main").innerHTML = `<p class="errors">Could not load model data (${esc(e.message)}). Please reload.</p>`;
    return;
  }
  const d = new Date(DATA.generated_utc);
  $("#updated").textContent = "Data updated " + d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  $("#updated").setAttribute("datetime", DATA.generated_utc);
  const parsed = C.parseSettings(location.search);
  document.body.dataset.state = parsed.empty ? "landing" : parsed.ok ? "picks" : "invalid";
  if (parsed.ok) {
    SETTINGS = parsed.settings;
    PICKS = C.computePicks(DATA, SETTINGS);
    renderPicks();
  } else renderLanding(parsed);

  $("#btn-customize").addEventListener("click", openCustomize);
  $("#btn-share").addEventListener("click", () => copy(location.href, "Link copied"));
  $("#btn-lock").addEventListener("click", openLock);
  $("#lock-copy").addEventListener("click", () => copy($("#lock-url").value, "Locked link copied"));
  const cf = $("#customize-form");
  cf.addEventListener("submit", (e) => { e.preventDefault(); submitForm(cf, $("#customize-errors")); });
  $$("[data-dismiss]").forEach((b) => b.addEventListener("click", () => closeModal(b.dataset.dismiss)));
  $$(".modal").forEach((m) => m.addEventListener("click", (e) => { if (e.target === m) closeModal(m.id); }));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") $$(".modal.open").forEach((m) => closeModal(m.id)); });

  // WebMCP: agents in the page get the exact bot-endpoint JSON.
  if (document.modelContext?.registerTool && SETTINGS) {
    document.modelContext.registerTool({
      name: "get_picks",
      description: "Returns this page's three model picks (chat, code, crazy) computed from the URL settings, as the same JSON the /api/picks endpoint returns.",
      inputSchema: { type: "object", properties: {} },
      execute: () => Promise.resolve(JSON.stringify(C.picksResponse(DATA, SETTINGS, location.origin + "/"))),
    });
  }
  document.body.dataset.ready = "1";
}
main();
