// tests/calc.test.mjs - unit tests for lib/calc.mjs (shared by UI + bot endpoint)
// and the bot handler (api/picks.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as C from "../lib/calc.mjs";
import { handle } from "../api/picks.mjs";

const M = (id, input, scores, output = input * 5) => ({ id, name: id.split("/")[1], org: id.split("/")[0], input, output, scores });
const DATA = {
  generated_utc: "2026-11-11T12:00:00.000Z",
  models: [
    M("a/cheap", 0.1, { eci: 60, aai: 50 }),
    M("a/mid", 1, { eci: 80, aai: 90, aac: 70 }),
    M("b/top", 10, { eci: 100, aai: 100, aac: 100 }),
    M("b/coder", 2, { aac: 95 }),            // no eci
    M("c/twin-a", 1, { eci: 80, aai: 70 }),  // ties a/mid on price
  ],
};
const Q = (o) => C.parseSettings(new URLSearchParams(o));
const BASE = { chat: "eci", chat_max: "5", chat_min: "70", code: "eci", code_max: "5", code_min: "70", crazy: "eci", crazy_max: "50", crazy_min: "90" };

test("parse: v optional, defaults to 1; v=1 accepted; v=2 rejected", () => {
  const a = Q(BASE); assert.ok(a.ok); assert.equal(a.settings.v, 1);
  assert.ok(Q({ ...BASE, v: "1" }).ok);
  const b = Q({ ...BASE, v: "2" });
  assert.ok(!b.ok); assert.ok(b.errors.some((e) => e.param === "v"));
});

test("parse: empty -> empty flag; utm_ ignored", () => {
  assert.equal(C.parseSettings("").empty, true);
  assert.equal(C.parseSettings("?utm_source=x").empty, true);
  assert.ok(Q({ ...BASE, utm_source: "slack" }).ok);
});

test("parse: names every missing setting", () => {
  const r = Q({ chat: "eci" });
  const params = r.errors.map((e) => e.param).sort();
  assert.deepEqual(params, ["chat_max", "chat_min", "code", "code_max", "code_min", "crazy", "crazy_max", "crazy_min"]);
});

test("parse: invalid values, unknown and duplicate params", () => {
  const bad = (o, param) => { const r = Q({ ...BASE, ...o }); assert.ok(!r.ok, JSON.stringify(o)); assert.ok(r.errors.some((e) => e.param === param), param + " " + JSON.stringify(r.errors)); };
  bad({ chat: "nope" }, "chat");
  bad({ chat: "eci:0" }, "chat");
  bad({ chat: "eci:-1" }, "chat");
  bad({ chat: "eci,eci" }, "chat");
  bad({ chat: "eci:1:2" }, "chat");
  bad({ chat_max: "abc" }, "chat_max");
  bad({ chat_max: "-1" }, "chat_max");
  bad({ chat_min: "101" }, "chat_min");
  bad({ chat_miss: "maybe" }, "chat_miss");
  bad({ chat_cov: "50" }, "chat_cov"); // cov needs reweight
  bad({ chat_lock: "bad id with spaces" }, "chat_lock");
  bad({ foo: "1" }, "foo");
  const dup = C.parseSettings("chat=eci&chat=aai&chat_max=1&chat_min=1&code=eci&code_max=1&code_min=1&crazy=eci&crazy_max=1&crazy_min=1");
  assert.ok(dup.errors.some((e) => e.param === "chat" && /more than once/.test(e.problem)));
});

test("parse: weights, miss modes, cov, lock round-trip through serialize", () => {
  const r = Q({ ...BASE, code: "aac:2,eci", code_miss: "reweight", code_cov: "50", crazy_lock: "b/top" });
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.deepEqual(r.settings.code.bench, [{ key: "aac", w: 2 }, { key: "eci", w: 1 }]);
  const qs = C.serializeSettings(r.settings);
  assert.match(qs, /code=aac:2,eci&/);
  assert.match(qs, /crazy_lock=b\/top/);
  assert.deepEqual(C.parseSettings(qs).settings, r.settings);
  assert.ok(!C.serializeSettings(r.settings, { includeLocks: false }).includes("lock"));
  assert.ok(!qs.includes("chat_miss"), "default miss mode not serialized");
});

test("recommended defaults serialize to a valid, short URL", () => {
  const qs = C.serializeSettings(C.RECOMMENDED);
  const r = C.parseSettings(qs);
  assert.ok(r.ok); assert.deepEqual(r.settings.chat, C.RECOMMENDED.chat);
  assert.ok(C.settingsUrl(C.RECOMMENDED).length < 200);
  for (const k of C.CATEGORY_KEYS) assert.equal(C.RECOMMENDED[k].bench[0].key, "eci");
});

test("score: single benchmark returns the normalized score as-is", () => {
  const cat = { bench: [{ key: "eci", w: 1 }], miss: "exclude", cov: null };
  assert.equal(C.scoreModel(DATA.models[1], cat).score, 80);
});

test("score: weighted average of normalized scores", () => {
  const cat = { bench: [{ key: "eci", w: 3 }, { key: "aai", w: 1 }], miss: "exclude", cov: null };
  assert.equal(C.scoreModel(DATA.models[1], cat).score, 82.5); // (3*80+90)/4
});

test("missing-data modes: exclude / reweight / zero / cov floor", () => {
  const bench = [{ key: "eci", w: 1 }, { key: "aac", w: 1 }];
  const cheap = DATA.models[0]; // eci 60, no aac
  assert.equal(C.scoreModel(cheap, { bench, miss: "exclude" }).score, null);
  assert.equal(C.scoreModel(cheap, { bench, miss: "reweight", cov: null }).score, 60);
  assert.equal(C.scoreModel(cheap, { bench, miss: "zero" }).score, 30);
  assert.equal(C.scoreModel(cheap, { bench, miss: "reweight", cov: 50 }).score, 60);
  assert.equal(C.scoreModel(cheap, { bench, miss: "reweight", cov: 51 }).score, null);
  // no data on any chosen benchmark -> never ranked, even in zero mode
  const none = { bench: [{ key: "vibe", w: 1 }], miss: "zero" };
  assert.equal(C.scoreModel(cheap, none).score, null);
});

test("pick: cheapest qualifying model under price cap and above floor", () => {
  const cat = { bench: [{ key: "eci", w: 1 }], max: 5, min: 70, miss: "exclude", cov: null, lock: null };
  const p = C.pickCategory(DATA.models, cat);
  // a/mid and c/twin-a both $1, score 80 -> tie broken by id
  assert.equal(p.winner.model.id, "a/mid");
  assert.deepEqual(p.qualifying.map((r) => r.model.id), ["a/mid", "c/twin-a"]);
  assert.equal(C.pickCategory(DATA.models, { ...cat, max: 0.5, min: 50 }).winner.model.id, "a/cheap");
  assert.equal(C.pickCategory(DATA.models, { ...cat, max: 100, min: 95 }).winner.model.id, "b/top");
});

test("pick: price cap and score floor are inclusive", () => {
  const cat = { bench: [{ key: "eci", w: 1 }], max: 10, min: 100, miss: "exclude", cov: null, lock: null };
  assert.equal(C.pickCategory(DATA.models, cat).winner.model.id, "b/top");
});

test("pick: higher score breaks equal-price ties", () => {
  const cat = { bench: [{ key: "aai", w: 1 }], max: 5, min: 0, miss: "exclude", cov: null, lock: null };
  assert.equal(C.pickCategory(DATA.models.filter((m) => m.input === 1), cat).winner.model.id, "a/mid"); // 90 > 70
});

test("pick: no model qualifies -> winner null, chart data still present", () => {
  const cat = { bench: [{ key: "eci", w: 1 }], max: 0.5, min: 99, miss: "exclude", cov: null, lock: null };
  const p = C.pickCategory(DATA.models, cat);
  assert.equal(p.winner, null);
  assert.equal(p.qualifying.length, 0);
  assert.equal(p.scored.length, 4);
});

test("locked models: shown exactly, even if not qualifying or not in data", () => {
  const cat = { bench: [{ key: "eci", w: 1 }], max: 0.5, min: 99, miss: "exclude", cov: null, lock: "b/top" };
  const p = C.pickCategory(DATA.models, cat);
  assert.equal(p.locked, true); assert.equal(p.winner.model.id, "b/top");
  const gone = C.pickCategory(DATA.models, { ...cat, lock: "x/retired" });
  assert.equal(gone.lockedMissing, true); assert.equal(gone.winner.model.id, "x/retired");
});

test("picksResponse: statuses and output price metadata", () => {
  const s = Q({ ...BASE, code_min: "100", code_max: "1", crazy_lock: "x/retired" }).settings;
  const r = C.picksResponse(DATA, s);
  assert.equal(r.v, 1);
  assert.equal(r.categories.chat.status, "ok");
  assert.equal(r.categories.chat.model.id, "a/mid");
  assert.equal(r.categories.chat.model.output_usd_per_1m, 5);
  assert.equal(r.categories.code.status, "no-model-qualifies");
  assert.equal(r.categories.code.model, null);
  assert.equal(r.categories.crazy.status, "locked-model-not-in-data");
  assert.ok(r.url.startsWith(C.SITE_URL + "/?chat=eci"));
});

test("bot endpoint: 400 with named errors + docs link for no/invalid params", () => {
  const none = handle("https://x.test/api/picks", DATA);
  assert.equal(none.status, 400);
  assert.equal(none.body.docs, C.DOCS_URL);
  assert.ok(none.body.example.includes("/api/picks?chat=eci"));
  const bad = handle("https://x.test/api/picks?chat=eci&chat_max=1", DATA);
  assert.equal(bad.status, 400);
  assert.ok(bad.body.errors.some((e) => e.param === "chat_min"));
  assert.ok(bad.body.errors.some((e) => e.param === "code"));
  const unk = handle("https://x.test/api/picks?" + new URLSearchParams({ ...BASE, zz: "1" }), DATA);
  assert.equal(unk.status, 400);
  assert.deepEqual(unk.body.errors, [{ param: "zz", problem: "unknown parameter" }]);
});

test("bot endpoint: 200 matches the shared module exactly", () => {
  const qs = new URLSearchParams(BASE).toString();
  const out = handle("https://x.test/api/picks?" + qs, DATA);
  assert.equal(out.status, 200);
  assert.deepEqual(out.body, C.picksResponse(DATA, C.parseSettings(qs).settings, "https://x.test/"));
});
