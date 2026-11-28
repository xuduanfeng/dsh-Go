// The built-in usage HUD: each turn priced where it happened, per-model rows,
// the strip line the composer shows, and the notes under each turn.
import { test } from "node:test";
import assert from "node:assert/strict";
import { foldLog, createUsageHud, turnText } from "../bridge/dsh-go-bridge/lib/native/usage-hud.js";

const BEIJING = 8 * 3600_000;
const at = (y, m, d, hh, mm) => Date.UTC(y, m - 1, d, hh, mm) - BEIJING;

const message = (turn, step, time, model, usage) => ({
  type: "assistant/message",
  time,
  data: { turn, step, usage, message: { source: { model } } },
});

test("every sample is priced at its own time and model", () => {
  const events = [
    message(1, 1, at(2026, 11, 26, 20, 0), "deepseek-flash", { inputTokens: 100_000, outputTokens: 10_000 }),
    message(2, 1, at(2026, 11, 26, 10, 0), "deepseek-v4-pro", { inputTokens: 10_000, outputTokens: 1_000 }),
  ];
  const log = foldLog(events, { now: () => at(2026, 11, 26, 21, 0) });
  assert.equal(log.tokens, 121_000);
  // Turn 1 off-peak flash: 100k x 1 + 10k x 4 = 0.14. Turn 2 peak pro: 10k x 9 + 1k x 27 = 0.117.
  assert.equal(turnText(log.turns.get(1)), "本轮 ¥0.14");
  assert.equal(turnText(log.turns.get(2)), "本轮 ¥0.12");
  assert.equal(Math.round(log.cost * 1000) / 1000, 0.257);
  assert.deepEqual(log.models.map((m) => m.name).sort(), ["deepseek-flash", "deepseek-v4-pro"]);
  assert.equal(log.peakTokens, 11_000, "only the pro turn ran in the peak window");
  assert.equal(log.offTokens, 110_000);
});

test("a retried step is not billed twice, a cache hit is priced at the hit rate", () => {
  const events = [
    message(1, 1, at(2026, 11, 27, 20, 0), "deepseek-flash", { inputTokens: 1_000, outputTokens: 0 }),
    message(1, 1, at(2026, 11, 27, 20, 0), "deepseek-flash", { inputTokens: 1_000, outputTokens: 0 }),
  ];
  const once = foldLog(events, { now: () => at(2026, 11, 27, 20, 1) });
  assert.equal(once.tokens, 1_000, "the second sample of the same attempt replaces the first");

  const cached = foldLog([message(1, 1, at(2026, 11, 27, 20, 0), "deepseek-flash", { cacheReadTokens: 1_000_000 })], { now: () => at(2026, 11, 27, 20, 1) });
  assert.equal(Math.round(cached.cost * 1000) / 1000, 0.02);
  assert.equal(cached.cacheHit, 100);
  assert.equal(Math.round(cached.saved * 1000) / 1000, 0.98, "a hit saves the miss minus hit difference");
});

test("a retry start lets the same attempt be billed again", () => {
  const retry = { type: "llm/retry-started", time: at(2026, 11, 27, 20, 0), data: { turn: 1, step: 1 } };
  const events = [
    message(1, 1, at(2026, 11, 27, 20, 0), "deepseek-flash", { inputTokens: 1_000 }),
    retry,
    message(1, 1, at(2026, 11, 27, 20, 0), "deepseek-flash", { inputTokens: 1_000 }),
  ];
  const log = foldLog(events, { now: () => at(2026, 11, 27, 20, 1) });
  assert.equal(log.tokens, 2_000, "the retried attempt is a second billed request");
  assert.equal(log.requests, 2);
});

function hudFixture(log) {
  const seen = [];
  const listeners = new Map();
  const ctx = {
    on: (name, fn) => {
      if (name === "session/event") listeners.set("event", fn);
    },
    get: (name) => (name === "sessionQuery" ? { readSession: async () => ({ session: { id: "s1" }, events: log }) } : undefined),
  };
  const hud = createUsageHud(ctx, { now: () => at(2026, 11, 26, 21, 0) });
  return { hud, seen, emit: (event, sessionId = "s1") => listeners.get("event")?.({ id: sessionId }, event) };
}

test("the strip and the panel read the session log the host never attached", async () => {
  const { hud, emit } = hudFixture([]);
  const strip = [];
  const cancel = hud.strip.data({ sessionId: "s1" }, (d) => strip.push(d));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(strip.at(-1).text, "暂无用量");
  cancel();

  emit(message(1, 1, at(2026, 11, 26, 20, 0), "deepseek-flash", { inputTokens: 500_000, cacheReadTokens: 400_000, outputTokens: 10_000 }));
  const strip2 = [];
  const cancel2 = hud.strip.data({ sessionId: "s1" }, (d) => strip2.push(d));
  await new Promise((r) => setTimeout(r, 20));
  assert.match(strip2.at(-1).text, /^¥[\d.]+ · 910K$/, strip2.at(-1).text);
  cancel2();

  const panel = [];
  const cancel3 = hud.panel.data({ sessionId: "s1" }, (d) => panel.push(d));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(panel.at(-1).tokens, "910K");
  assert.equal(panel.at(-1).cacheHit, "44%", "400k of 900k input came from cache");
  assert.equal(panel.at(-1).turn, "¥0.55", "500k x 1 + 400k x 0.02 + 10k x 4 = 0.548");
  cancel3();
});

test("every finished turn leaves its own note", async () => {
  const { hud, emit } = hudFixture([]);
  emit(message(1, 1, at(2026, 11, 26, 20, 0), "deepseek-flash", { inputTokens: 100_000, outputTokens: 10_000 }));
  emit(message(2, 1, at(2026, 11, 26, 20, 30), "deepseek-flash", { inputTokens: 20_000, outputTokens: 2_000 }));
  const notes = [];
  const cancel = hud.note.data({ sessionId: "s1" }, (d) => notes.push(d));
  const last = notes.at(-1);
  assert.deepEqual(Object.keys(last), ["1", "2"]);
  assert.equal(last["1"].text, "本轮 ¥0.14");
  assert.equal(last["2"].text, "本轮 ¥0.03", "20k x 1 + 2k x 4 = 0.028 -> 0.03");
  cancel();
});

test("copy hands back a summary the user can paste", async () => {
  const { hud, emit } = hudFixture([]);
  emit(message(1, 1, at(2026, 11, 26, 20, 0), "deepseek-flash", { inputTokens: 100_000, outputTokens: 10_000 }));
  const out = hud.copy({ sessionId: "s1" });
  assert.equal(out.toast, "已复制");
  assert.match(out.copy, /用量与费用/);
  assert.match(out.copy, /0\.14/);
  assert.match(out.copy, /本轮（第 1 轮）/);
});
