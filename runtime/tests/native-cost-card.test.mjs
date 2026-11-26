// The built-in cost card: peak/off-peak pricing, the card's gates, and the row
// the app draws (composer.banner from the bridge itself, no installed plugin).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { NativeCore } from "../bridge/dsh-go-bridge/lib/native/core.js";
import { createNativeRoutes } from "../bridge/dsh-go-bridge/lib/native/routes.js";
import { effectiveLimits } from "../bridge/dsh-go-bridge/lib/native/limits.js";
import { normalizeScope } from "../bridge/dsh-go-bridge/lib/native/util.js";
import {
  MANIFEST, createCostBanner, cardFor, isPeak, money, priceAt, compact,
} from "../bridge/dsh-go-bridge/lib/native/cost-banner.js";

const BEIJING = 8 * 3600_000;
const at = (y, m, d, hh, mm) => Date.UTC(y, m - 1, d, hh, mm) - BEIJING;

test("peak windows are Beijing weekdays 09:00-12:00 and 14:00-18:00", () => {
  assert.equal(isPeak(at(2026, 11, 26, 9, 0)), true, "Thursday 09:00");
  assert.equal(isPeak(at(2026, 11, 26, 11, 59)), true);
  assert.equal(isPeak(at(2026, 11, 26, 12, 0)), false, "lunch");
  assert.equal(isPeak(at(2026, 11, 26, 14, 0)), true);
  assert.equal(isPeak(at(2026, 11, 26, 18, 0)), false);
  assert.equal(isPeak(at(2026, 11, 28, 10, 0)), false, "Saturday");
  assert.equal(isPeak(at(2026, 10, 1, 10, 0)), false, "National Day, a Thursday");
});

test("off-peak is half price, and money rounds up to the fen", () => {
  const peak = priceAt("deepseek-flash", at(2026, 11, 26, 10, 0));
  const off = priceAt("deepseek-flash", at(2026, 11, 26, 20, 0));
  assert.deepEqual([peak.miss, peak.hit, peak.peak], [2, 0.04, true]);
  assert.deepEqual([off.miss, off.hit, off.peak], [1, 0.02, false]);
  assert.equal(priceAt("deepseek-v4-pro", at(2026, 11, 26, 20, 0)).miss, 4.5);
  assert.equal(money(0.105), "0.11", "0.105 must not read as 0.10");
  assert.equal(money(0.004), "<0.01");
  assert.equal(compact(105_432), "105k");
  assert.equal(compact(8_400), "8.4k");
});

test("the card only speaks above 80k tokens, or 20k after half a day", () => {
  const hot = { context: 105_000, model: "deepseek-flash", lastAt: at(2026, 11, 26, 10, 0) };
  const card = cardFor(hot, at(2026, 11, 26, 10, 1));
  assert.match(card.text, /105k token/);
  assert.match(card.text, /0\.21 元/, "peak miss price doubles");
  assert.match(card.note, /高峰价/);
  assert.deepEqual(card.actions.map((a) => a.id), ["open", "dismiss"]);

  const off = cardFor(hot, at(2026, 11, 26, 20, 0));
  assert.match(off.text, /0\.11 元/);
  assert.match(off.note, /空闲价/);

  assert.equal(cardFor({ ...hot, context: 60_000 }, at(2026, 11, 26, 10, 1)), null, "small and warm");
  assert.notEqual(cardFor({ ...hot, context: 60_000 }, at(2026, 11, 27, 10, 1)), null, "cold after 12h");
  assert.equal(cardFor({ ...hot, context: 19_999 }, at(2026, 11, 27, 10, 1)), null, "below 20k");
  assert.equal(cardFor(hot, at(2026, 11, 26, 10, 1), { dismissed: new Set([5]) }), null, "bucket 5 sent away");
});

async function fixture() {
  const handlers = [];
  const sessions = new Map();
  const ctx = {
    get: (n) => (n === "loader" ? { entries: () => [] } : n === "sessions" ? { get: (id) => sessions.get(id) } : undefined),
    on: (name, fn) => { if (name === "session/event") handlers.push(fn); },
    logger: { warn() {} },
  };
  const banner = createCostBanner(ctx, { now: () => at(2026, 11, 26, 10, 30) });
  const core = new NativeCore(ctx, effectiveLimits({}), "test", [{ pkgJson: MANIFEST, banner }]);
  const routes = createNativeRoutes(core);
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://local");
    return routes.handle(req, res, url.pathname, url);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  const get = async (path) => (await fetch(`http://127.0.0.1:${port}${path}`)).json();
  const post = async (body) => {
    const r = await fetch(`http://127.0.0.1:${port}/dsh-go/v1/invoke`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, ...(await r.json()) };
  };
  return {
    banner, core, handlers, sessions, get, post,
    close: async () => {
      routes.dispose(); core.dispose(); server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}

test("the bridge ships the card as its own contribution", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const all = await f.get("/dsh-go/v1/contributions?v=1&app=1.3.0&locale=zh-CN&surfaces=composer.actions,message.actions,composer.strip,panels,composer.banner");
  const row = all.plugins.find((p) => p.pkg === "dsh-go-cost");
  assert.ok(row, `no built-in row: ${JSON.stringify(all.plugins.map((p) => p.pkg))}`);
  assert.equal(row.title, "费用提示");
  assert.deepEqual(row.contributes["composer.banner"], [{ id: "cost", icon: "wallet", ready: true, live: true }]);
  assert.equal(row.state, "ok");
});

test("a chat's card follows its usage, and its buttons work", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  f.handlers[0]({ id: "s1" }, {
    type: "assistant/message", time: at(2026, 11, 26, 10, 29),
    data: { usage: { inputTokens: 40_000, cacheReadTokens: 60_000, cacheWriteTokens: 0, outputTokens: 5_000 }, message: { source: { model: "deepseek-flash" } } },
  });
  const seen = [];
  const scope = normalizeScope({ sessionId: "s1" });
  const cancel = f.banner.data(scope.scope, (d) => seen.push(d));
  assert.equal(seen.length, 1);
  assert.match(seen[0].text, /105k token/);
  assert.match(seen[0].note, /高峰价/);
  cancel();

  const open = await f.post({ v: 1, pkg: "dsh-go-cost", id: "cost", surface: "composer.banner", action: "open", scope: { sessionId: "s1" } });
  assert.equal(open.status, 200);
  assert.deepEqual(open.effects, [{ type: "command", name: "new" }]);

  const dismiss = await f.post({ v: 1, pkg: "dsh-go-cost", id: "cost", surface: "composer.banner", action: "dismiss", scope: { sessionId: "s1" } });
  assert.equal(dismiss.status, 200);
  const after = [];
  const cancel2 = f.banner.data(scope.scope, (d) => after.push(d));
  assert.deepEqual(after, [null], "the same bucket stays dismissed");
  cancel2();
});

test('a session opened cold is priced from the token meter before any turn', () => {
  const pressure = { pressureTokens: 105_000, contextWindow: 1_000_000 };
  const session = {
    id: 's-cold',
    snapshotEvents: () => [],
  };
  const ctx = {
    get: (name) => (name === 'sessions'
      ? { get: (id) => (id === 's-cold' ? session : undefined) }
      : name === 'tokenMeter' ? { contextPressure: () => pressure } : undefined),
    on: () => {},
  };
  const banner = createCostBanner(ctx, { now: () => Date.parse('2026-11-28T02:00:00Z') });
  const out = [];
  const cancel = banner.data({ sessionId: 's-cold' }, (d) => out.push(d));
  assert.equal(out.length, 1);
  assert.match(out[0].text, /105k token/);
  assert.match(out[0].text, /0\.11 元/, 'the meter value is priced at the off-peak miss rate');
  cancel();
});
