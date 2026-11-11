// tests/e2e.test.mjs - Playwright browser tests against a LOCAL server
// (tests/serve.mjs) serving a fresh render of dist/ from data/models.json,
// with /api/picks routed through the real api/picks.mjs handler.
// Covers: landing -> generate, picks from URL, detail chart, customize ->
// apply, no-model-qualifies card + chart + adjust link, share, locked links,
// invalid URL errors, docs page, and UI/bot parity.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";
import { startServer } from "./serve.mjs";
import * as C from "../lib/calc.mjs";

let server, url, browser;
const DATA = JSON.parse(readFileSync(new URL("../data/models.json", import.meta.url), "utf8"));

before(async () => {
  execFileSync("node", ["scripts/render.mjs", "data", "dist/index.html"], { stdio: "pipe" });
  ({ server, url } = await startServer());
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); server?.close(); });

async function open(path) {
  const page = await browser.newPage({ viewport: { width: 1300, height: 950 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(url + path);
  await page.waitForSelector("body[data-ready='1']");
  return { page, errors };
}
const cards = (page) => page.$$eval("[data-webmcp-pick]", (els) => Object.fromEntries(els.map((e) => [e.dataset.webmcpPick, { status: e.dataset.status, id: e.dataset.modelId }])));
const recQs = C.serializeSettings(C.RECOMMENDED);

test("landing: no params shows the form prefilled with recommended defaults; generate reloads with full URL", async () => {
  const { page, errors } = await open("/");
  assert.equal(await page.getAttribute("body", "data-state"), "landing");
  assert.equal(await page.isVisible("#btn-customize"), false);
  assert.equal(await page.inputValue("fieldset[data-cat=crazy] input[name=min]"), String(C.RECOMMENDED.crazy.min));
  assert.equal(await page.isChecked("fieldset[data-cat=chat] input[value=eci]"), true);
  await page.click("#generate");
  await page.waitForURL(/\?chat=eci/);
  await page.waitForSelector("body[data-ready='1']");
  assert.equal(new URL(page.url()).search.slice(1), recQs);
  const got = await cards(page);
  const want = C.picksResponse(DATA, C.RECOMMENDED).categories;
  for (const k of C.CATEGORY_KEYS) assert.equal(got[k].id, want[k].model.id, k);
  assert.deepEqual(errors, []);
  await page.close();
});

test("picks URL: UI picks equal the bot endpoint for the same params", async () => {
  const qs = "chat=aai&chat_max=2&chat_min=50&code=aac:2,eci&code_max=5&code_min=60&code_miss=reweight&code_cov=30&crazy=eci,aai&crazy_max=30&crazy_min=90";
  const { page, errors } = await open("/?" + qs);
  const api = await (await fetch(url + "/api/picks?" + qs)).json();
  const got = await cards(page);
  for (const k of C.CATEGORY_KEYS) assert.equal(got[k].id, api.categories[k].model?.id ?? "", k);
  await page.click("[data-open=code]");
  await page.waitForSelector("#detail.open svg rect.range");
  assert.ok((await page.$$("#detail circle.dot")).length > 5);
  assert.match(await page.innerText("#detail .prices"), /Output/);
  assert.deepEqual(errors, []);
  await page.close();
});

test("customize: popup edits settings and Apply reloads with the new URL; docs link present", async () => {
  const { page } = await open("/?" + recQs);
  await page.click("#btn-customize");
  await page.waitForSelector("#customize.open");
  assert.ok(await page.$("#customize a[href='/docs']"));
  await page.fill("#customize fieldset[data-cat=chat] input[name=max]", "0.5");
  await page.click("#apply");
  await page.waitForURL(/chat_max=0\.5/);
  await page.close();
});

test("no model qualifies: card message + adjust link; card still opens chart with range box", async () => {
  const qs = recQs.replace(/crazy_max=[^&]+/, "crazy_max=0.01").replace(/crazy_min=[^&]+/, "crazy_min=100");
  const { page } = await open("/?" + qs);
  assert.equal((await cards(page)).crazy.status, "none");
  assert.match(await page.innerText("[data-open=crazy]"), /No Model\s+Qualifies/);
  await page.click("[data-open=crazy] h2");
  await page.waitForSelector("#detail.open rect.range", { state: "attached" });
  assert.ok((await page.$$("#detail circle.dot")).length > 10, "all models still drawn");
  await page.click("#detail [data-customize]");
  await page.waitForSelector("#customize.open");
  await page.keyboard.press("Escape");
  await page.click("[data-open=crazy] .adjust");
  await page.waitForSelector("#customize.open");
  await page.close();
});

test("share copies the current URL; locked share builds editable locked URL that shows exactly those models", async () => {
  const { page } = await open("/?" + recQs);
  await page.click("#btn-share");
  assert.equal(await page.evaluate(() => window.__lastCopied), page.url());
  await page.click("#btn-lock");
  await page.waitForSelector("#lock.open");
  const pick = DATA.models.find((m) => m.id !== (C.picksResponse(DATA, C.RECOMMENDED).categories.crazy.model.id)).id;
  await page.selectOption("#lock-crazy", pick);
  const lockUrl = await page.inputValue("#lock-url");
  assert.ok(lockUrl.includes("crazy_lock=" + pick));
  assert.ok(lockUrl.includes("chat_lock=") && lockUrl.includes("code_lock="));
  await page.click("#lock-copy");
  assert.equal(await page.evaluate(() => window.__lastCopied), lockUrl);
  await page.goto(lockUrl);
  await page.waitForSelector("body[data-ready='1']");
  const got = await cards(page);
  assert.equal(got.crazy.status, "locked");
  assert.equal(got.crazy.id, pick);
  await page.close();
});

test("invalid URL lists bad settings and offers the form", async () => {
  const { page } = await open("/?chat=nope&code_max=x");
  assert.equal(await page.getAttribute("body", "data-state"), "invalid");
  const t = await page.innerText("#url-errors");
  assert.match(t, /unknown benchmark "nope"/);
  assert.match(t, /code_max/);
  assert.ok(await page.$("#landing-form"));
  await page.close();
});

test("docs page documents params, normalization, missing modes, price and bot endpoint", async () => {
  const page = await browser.newPage();
  await page.goto(url + "/docs");
  const text = await page.innerText("main");
  for (const s of ["chat_max", "chat_min", "chat_miss", "chat_cov", "chat_lock", "min-max", "reweight", "input price in USD per 1M tokens", "output tokens", "/api/picks", "HTTP 400"]) assert.ok(text.includes(s), s);
  await page.close();
  const r = await fetch(url + "/api/picks");
  assert.equal(r.status, 400);
});
