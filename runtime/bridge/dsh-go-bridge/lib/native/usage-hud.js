// The bridge's own 「用量与费用」 HUD: a composer strip, its panel, a per-turn
// note and the copy action. One package with the cost card in cost-banner.js.
//
// A phone engine keeps no live Session, so the log is replayed through
// sessionQuery when the host has nothing attached; live events are folded as
// they arrive. Every sample keeps its own timestamp and model, so a turn that
// straddled the peak boundary, or a session that switched from flash to pro, is
// priced at the rate that actually applied.
import { DEFAULT_HOLIDAYS, priceAt } from "./cost-banner.js";

const TICK_MS = 3000;
const BALANCE_TTL_MS = 5 * 60 * 1000;
const STRIP_MAX = 24;
const MODEL_ROWS = 8;
const NOTE_TURNS = 32;

const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

const totalOf = (b) => b.uncachedInput + b.cacheRead + b.cacheWrite + b.output;

function service(ctx, name) {
  try {
    const value = ctx[name];
    if (value !== undefined && value !== null) return value;
  } catch {
    // Not injected on this context: fall through to get().
  }
  try {
    return ctx.get?.(name);
  } catch {
    return undefined;
  }
}

function streamUsage(stream) {
  if (!Array.isArray(stream)) return undefined;
  for (let i = stream.length - 1; i >= 0; i -= 1) {
    const record = stream[i];
    if (record?.type === "chunk" && record.chunk?.type === "usage" && record.chunk.usage) return record.chunk.usage;
  }
  return undefined;
}

/** One usage sample, carrying the turn and step it belongs to. */
function sampleOf(event) {
  if (event === null || typeof event !== "object") return undefined;
  const data = event.data ?? {};
  if (event.type === "assistant/chunk") {
    const chunk = data.chunk;
    if (!chunk || chunk.type !== "usage" || !chunk.usage) return undefined;
    return { turn: data.turn, step: data.step, time: event.time, usage: chunk.usage, model: data.model };
  }
  if (event.type !== "assistant/message" && event.type !== "assistant/attempt") return undefined;
  const usage = data.usage ?? streamUsage(data.stream);
  if (!usage) return undefined;
  const model = data.message?.source?.model ?? data.model;
  return { turn: data.turn, step: data.step, time: event.time, usage, model };
}

const bucketsOf = (usage) => ({
  uncachedInput: num(usage.inputTokens ?? usage.uncachedInputTokens),
  cacheRead: num(usage.cacheReadTokens),
  cacheWrite: num(usage.cacheWriteTokens),
  output: num(usage.outputTokens),
});

/**
 * Fold a session log into exact totals, per-model rows and per-turn costs.
 *
 * An attempt that reports usage twice (a retried step re-sends the same
 * turn/step) supersedes its earlier sample instead of being billed twice.
 */
export function foldLog(events, options = {}) {
  const at = options.now ?? (() => Date.now());
  const holidays = options.holidays ?? DEFAULT_HOLIDAYS;
  const samples = new Map();
  let origin;
  let contextWindow;
  let lastPrompt;
  let generation = 0;

  for (const event of events) {
    if (event === null || typeof event !== "object") continue;
    try {
      if (event.type === "request/header") {
        const config = event.data?.header?.config;
        if (typeof config?.model === "string" && config.model !== "") {
          origin = { provider: config.provider ?? null, model: config.model };
        }
        continue;
      }
      if (event.type === "request/context") {
        const data = event.data ?? {};
        if (typeof data.contextWindow === "number" && data.contextWindow > 0) contextWindow = data.contextWindow;
        if (typeof data.model === "string" && data.model !== "") {
          origin = { provider: data.provider ?? null, model: data.model };
        }
        continue;
      }
      if (event.type === "llm/retry-started") {
        generation += 1;
        continue;
      }
      const sample = sampleOf(event);
      if (sample === undefined) continue;
      if (!Number.isInteger(sample.turn) || !Number.isInteger(sample.step)) continue;
      const buckets = bucketsOf(sample.usage);
      if (totalOf(buckets) === 0) continue;
      const model = typeof sample.model === "string" && sample.model !== "" ? sample.model : origin?.model;
      const time = Number.isFinite(sample.time) ? sample.time : at();
      const rates = priceAt(model, time, holidays);
      const cost =
        ((buckets.uncachedInput + buckets.cacheWrite) * rates.miss + buckets.cacheRead * rates.hit + buckets.output * rates.output) / 1e6;
      const saved = (buckets.cacheRead * (rates.miss - rates.hit)) / 1e6;
      samples.set(`${sample.turn}\u0000${sample.step}\u0000${generation}`, { turn: sample.turn, model, time, peak: rates.peak, cost, saved, ...buckets });
      lastPrompt = buckets.uncachedInput + buckets.cacheRead + buckets.cacheWrite;
    } catch {
      // A malformed event must never take the HUD down.
    }
  }

  const totals = { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  const byModel = new Map();
  const byTurn = new Map();
  let cost = 0;
  let saved = 0;
  let peakTokens = 0;
  let offTokens = 0;
  let requests = 0;

  for (const sample of samples.values()) {
    const tokens = totalOf(sample);
    requests += 1;
    cost += sample.cost;
    saved += sample.saved;
    if (sample.peak) peakTokens += tokens;
    else offTokens += tokens;
    totals.uncachedInput += sample.uncachedInput;
    totals.cacheRead += sample.cacheRead;
    totals.cacheWrite += sample.cacheWrite;
    totals.output += sample.output;

    const name = sample.model ?? "未知模型";
    const model = byModel.get(name) ?? { name, tokens: 0, cost: 0 };
    model.tokens += tokens;
    model.cost += sample.cost;
    byModel.set(name, model);

    const turn = byTurn.get(sample.turn) ?? { cost: 0, tokens: 0 };
    turn.cost += sample.cost;
    turn.tokens += tokens;
    byTurn.set(sample.turn, turn);
  }

  const inputBase = totals.uncachedInput + totals.cacheRead + totals.cacheWrite;
  const seen = totals.uncachedInput + totals.cacheRead + totals.cacheWrite + totals.output;
  return {
    tokens: seen,
    cost,
    saved,
    requests,
    ...totals,
    cacheHit: inputBase > 0 ? (totals.cacheRead / inputBase) * 100 : undefined,
    contextWindow,
    lastPrompt,
    contextPct: lastPrompt !== undefined && contextWindow !== undefined ? Math.min(100, (lastPrompt / contextWindow) * 100) : undefined,
    peakTokens,
    offTokens,
    models: [...byModel.values()].sort((a, b) => b.cost - a.cost),
    turns: new Map([...byTurn.entries()].sort((a, b) => a[0] - b[0])),
  };
}

const fmtTokens = (value) => {
  const n = Math.round(Number(value) || 0);
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, "")}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1).replace(/\.0$/, "")}K`;
  return String(n);
};

const fmtMoney = (value) => {
  const n = Number(value) || 0;
  if (n === 0) return "¥0.00";
  if (n < 0.01) return `¥${n.toFixed(4)}`;
  if (n < 1) return `¥${n.toFixed(3)}`;
  return `¥${n.toFixed(2)}`;
};

const fmtShort = (value) => {
  const n = Number(value) || 0;
  if (n === 0) return "¥0";
  if (n < 0.01) return `¥${n.toFixed(3)}`;
  return `¥${n.toFixed(2)}`;
};

const fmtExact = (value) => Math.round(Number(value) || 0).toLocaleString("en-US");

const fmtPct = (value) => (value === undefined ? "—" : `${value >= 10 ? value.toFixed(0) : value.toFixed(1)}%`);

const fmtBalanceShort = (amount, currency) => {
  const symbol = currency === "USD" ? "$" : "¥";
  const n = Math.abs(Number(amount) || 0);
  if (n >= 10) return `${symbol}${n.toFixed(0)}`;
  if (n >= 1) return `${symbol}${n.toFixed(1)}`;
  return `${symbol}${n.toFixed(2)}`;
};

const fmtBalance = (amount, currency) => {
  const symbol = currency === "USD" ? "$" : currency === "CNY" || !currency ? "¥" : `${currency} `;
  const n = Math.abs(Number(amount) || 0);
  const text = n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${Number(amount) < 0 ? "-" : ""}${symbol}${text}`;
};

/** A turn's own cost, in the few characters a footnote allows. */
export function turnText(turn) {
  const cost = turn?.cost ?? 0;
  if (cost === 0) return "本轮 无计费";
  if (cost < 0.005) return "本轮 <¥0.01";
  return `本轮 ¥${cost.toFixed(2)}`;
}

function pickWallet(value) {
  if (!value || value.status !== "ready" || !Array.isArray(value.value)) return undefined;
  const wallets = value.value
    .map((wallet) => ({ currency: wallet?.currency, amount: Number(wallet?.balance) }))
    .filter((wallet) => Number.isFinite(wallet.amount));
  if (wallets.length === 0) return undefined;
  const chosen = wallets.find((wallet) => wallet.currency === "CNY") ?? wallets[0];
  const gift = (Array.isArray(value.bonusWallets) ? value.bonusWallets : [])
    .filter((wallet) => wallet?.currency === chosen.currency)
    .reduce((sum, wallet) => sum + (Number(wallet?.balance) || 0), 0);
  return { amount: chosen.amount + gift, currency: chosen.currency };
}

/**
 * The HUD behind the built-in package: strip text, panel data, one note per
 * turn, and the copy action.
 */
export function createUsageHud(ctx, options = {}) {
  const now = options.now ?? (() => Date.now());
  const holidays = options.holidays ?? DEFAULT_HOLIDAYS;
  /** sessionId -> { events, summary, read } */
  const logs = new Map();
  const listeners = new Set();
  let balance = { at: 0, amount: undefined, currency: "CNY", text: "—" };
  let inflight;

  const remember = (sessionId, events) => {
    if (typeof sessionId !== "string") return;
    const entry = logs.get(sessionId) ?? { events: [], summary: undefined, read: false };
    entry.events.push(...events);
    entry.summary = foldLog(entry.events, { now, holidays });
    logs.set(sessionId, entry);
    for (const notify of listeners) notify(sessionId);
  };

  ctx.on("session/event", (session, event) => {
    if (typeof session?.id !== "string") return;
    if (event?.type === "assistant/message" || event?.type === "assistant/step") remember(session.id, [event]);
  });

  const replay = (sessionId) => {
    const entry = logs.get(sessionId);
    if (entry?.read === true) return;
    if (entry === undefined) logs.set(sessionId, { events: [], summary: undefined, read: true });
    else entry.read = true;
    const query = service(ctx, "sessionQuery");
    if (typeof query?.readSession !== "function") return;
    Promise.resolve(query.readSession(sessionId))
      .then((read) => {
        const events = Array.isArray(read?.events) ? read.events : [];
        const fresh = logs.get(sessionId)?.events.length ?? 0;
        if (events.length > fresh) {
          const kept = logs.get(sessionId);
          kept.events = events;
          kept.summary = foldLog(events, { now, holidays });
          for (const notify of listeners) notify(sessionId);
        }
      })
      .catch(() => {
        // A log that cannot be replayed keeps the HUD empty until a turn lands.
      });
  };

  const summaryOf = (sessionId) => {
    if (typeof sessionId !== "string") return undefined;
    replay(sessionId);
    return logs.get(sessionId)?.summary;
  };

  const refreshBalance = (caps) => {
    const account = service(ctx, "deepseekAccount");
    if (typeof account?.getBalance !== "function") return Promise.resolve();
    if (now() - balance.at < BALANCE_TTL_MS) return Promise.resolve();
    if (inflight !== undefined) return inflight;
    const client = {
      version: "0.2.1",
      locale: caps?.locale ?? "zh-CN",
      timezoneOffsetSeconds: -new Date(now()).getTimezoneOffset() * 60,
    };
    inflight = Promise.resolve(account.getBalance(client))
      .then((value) => {
        const picked = pickWallet(value);
        balance = { at: now(), amount: picked?.amount, currency: picked?.currency ?? "CNY", text: "—" };
        if (picked !== undefined) balance.text = fmtBalance(picked.amount, picked.currency);
      })
      .catch(() => {
        balance = { ...balance, at: now() };
      })
      .finally(() => {
        inflight = undefined;
      });
    return inflight;
  };

  const stripText = (summary) => {
    if (summary === undefined || summary.tokens === 0) return "暂无用量";
    const base = `${fmtShort(summary.cost)} · ${fmtTokens(summary.tokens)}`;
    if (balance.amount !== undefined) {
      const withBalance = `${base} · 余${fmtBalanceShort(balance.amount, balance.currency)}`;
      if ([...withBalance].length <= STRIP_MAX) return withBalance;
    }
    return base;
  };

  const panelData = (summary) => {
    const pct = summary?.contextPct;
    const last = summary?.turns === undefined ? undefined : [...summary.turns.entries()].at(-1);
    return {
      cost: fmtMoney(summary?.cost ?? 0),
      tokens: fmtTokens(summary?.tokens ?? 0),
      cacheHit: fmtPct(summary?.cacheHit),
      balance: balance.text,
      turn: last === undefined ? "—" : turnText(last[1]).replace("本轮 ", ""),
      turnTokens: last === undefined ? "—" : fmtTokens(last[1].tokens),
      contextPct: pct === undefined ? 0 : Math.round(pct),
      contextText:
        summary?.lastPrompt !== undefined && summary?.contextWindow !== undefined
          ? `${fmtTokens(summary.lastPrompt)} / ${fmtTokens(summary.contextWindow)}`
          : "等待请求",
      contextTone: pct === undefined ? "info" : pct >= 85 ? "bad" : pct >= 60 ? "warn" : "good",
      breakdown: [
        ["未缓存输入", fmtExact(summary?.uncachedInput)],
        ["缓存读取", fmtExact(summary?.cacheRead)],
        ["缓存写入", fmtExact(summary?.cacheWrite)],
        ["输出", fmtExact(summary?.output)],
      ],
      modelRows:
        (summary?.models.length ?? 0) === 0
          ? [["暂无模型", "—", "—"]]
          : summary.models.slice(0, MODEL_ROWS).map((model) => [model.name, fmtTokens(model.tokens), fmtMoney(model.cost)]),
      tiers: [
        ["高峰 tokens", fmtTokens(summary?.peakTokens ?? 0)],
        ["空闲 tokens", fmtTokens(summary?.offTokens ?? 0)],
        ["计费请求", `${summary?.requests ?? 0} 次`],
        ["缓存节省", fmtMoney(summary?.saved ?? 0)],
      ],
    };
  };

  const VIEW = {
    type: "stack",
    title: "用量与费用",
    children: [
      { type: "metric", label: "本会话估算", value: { $: "data.cost" }, caption: "CNY · 以官方账单为准" },
      {
        type: "row",
        children: [
          { type: "metric", label: "总 tokens", value: { $: "data.tokens" } },
          { type: "metric", label: "缓存命中", value: { $: "data.cacheHit" } },
          { type: "metric", label: "账户余额", value: { $: "data.balance" } },
        ],
      },
      {
        type: "row",
        children: [
          { type: "metric", label: "本轮费用", value: { $: "data.turn" } },
          { type: "metric", label: "本轮 tokens", value: { $: "data.turnTokens" } },
        ],
      },
      {
        type: "progress",
        label: "上下文占用",
        value: { $: "data.contextPct" },
        max: 100,
        caption: { $: "data.contextText" },
        tone: { $: "data.contextTone" },
      },
      { type: "keyValue", items: { $: "data.breakdown" } },
      { type: "table", columns: ["模型", "tokens", "费用"], rows: { $: "data.modelRows" } },
      { type: "keyValue", items: { $: "data.tiers" } },
      { type: "callout", text: "估算值，以官方账单为准；空闲时段按高峰价 50% 计。", tone: "info" },
    ],
  };

  const summaryText = (summary) => {
    if (summary === undefined || summary.tokens === 0) return "当前会话还没有用量。";
    const lines = [
      "用量与费用（本会话估算）",
      `费用：${fmtMoney(summary.cost)} CNY`,
      `tokens：${fmtExact(summary.tokens)}（输入 ${fmtExact(summary.uncachedInput)} / 缓存 ${fmtExact(summary.cacheRead)} / 输出 ${fmtExact(summary.output)}）`,
      `缓存命中：${fmtPct(summary.cacheHit)}`,
      `计费请求：${summary.requests} 次`,
      `账户余额：${balance.text}`,
    ];
    const last = [...summary.turns.entries()].at(-1);
    if (last !== undefined) lines.push(`本轮（第 ${last[0]} 轮）：${fmtMoney(last[1].cost)}，${fmtExact(last[1].tokens)} tokens`);
    lines.push("估算值，以官方账单为准。");
    return lines.join("\n");
  };

  return {
    strip: {
      data: (scope, emit, caps) => {
        let stopped = false;
        const push = () => {
          if (!stopped) emit({ text: stripText(summaryOf(scope?.sessionId)), icon: "coin" });
        };
        const tick = () => {
          push();
          void refreshBalance(caps).then(push);
        };
        tick();
        const timer = setInterval(tick, TICK_MS);
        // A refresh tick must never be the reason the host stays up.
        timer.unref?.();
        return () => {
          stopped = true;
          clearInterval(timer);
        };
      },
    },
    panel: {
      view: () => VIEW,
      data: (scope, emit, caps) => {
        let stopped = false;
        const push = () => {
          if (!stopped) emit(panelData(summaryOf(scope?.sessionId)));
        };
        const tick = () => {
          push();
          void refreshBalance(caps).then(push);
        };
        tick();
        const timer = setInterval(tick, TICK_MS);
        // A refresh tick must never be the reason the host stays up.
        timer.unref?.();
        return () => {
          stopped = true;
          clearInterval(timer);
        };
      },
    },
    note: {
      data: (scope, emit) => {
        const sessionId = scope?.sessionId;
        const push = () => {
          const summary = summaryOf(sessionId);
          if (summary === undefined || summary.turns.size === 0) return emit(null);
          const notes = {};
          for (const [turn, value] of [...summary.turns.entries()].slice(-NOTE_TURNS)) notes[String(turn)] = { text: turnText(value) };
          emit(notes);
        };
        push();
        const notify = (id) => {
          if (id === sessionId) push();
        };
        listeners.add(notify);
        return () => listeners.delete(notify);
      },
    },
    copy: (scope) => {
      const summary = summaryOf(scope?.sessionId);
      if (summary === undefined || summary.tokens === 0) return { toast: "当前会话还没有用量" };
      return { copy: summaryText(summary), toast: "已复制" };
    },
  };
}
