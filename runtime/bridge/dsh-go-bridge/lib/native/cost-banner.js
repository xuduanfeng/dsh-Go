// The cold-session cost card, built into the bridge.
//
// The phone's own engine refuses plugin installation (the HAP ships the
// profile; there is no writable place to add one), so the card a separately
// installed plugin would draw ships inside the bridge itself: one built-in
// contribution (composer.banner, id "cost") fed from the engine's own session
// events. The numbers and the clock are the same as the desktop hint: how big
// this chat's context is, how long since the last call, what the next call
// costs if the prompt cache has gone cold, and what starting over would cost.
//
// DeepSeek charges half price off-peak: Beijing time, weekdays 09:00-12:00 and
// 14:00-18:00 are peak; weekends and Chinese public holidays are off-peak all
// day. The price table is the one DeepSeek publishes; a holiday list that grows
// stale can only make the card cheaper than the bill, never dearer.

const MIN_CONTEXT = 20_000;
const BIG_CONTEXT = 80_000;
const COLD_AFTER_MS = 12 * 60 * 60 * 1000;
/** One short handoff turn: 3k prompt tokens over 3 messages, as the desktop hint counts it. */
const ESTIMATE_TOKENS = 3072 / 3;

/** CNY per 1M tokens, off-peak; peak is double. Same table as dsh-cost-meter. */
const PRICES = {
  flash: { miss: 1, hit: 0.02, output: 4 },
  pro: { miss: 4.5, hit: 0.15, output: 13.5 },
};

/** Chinese public holidays that fall on a weekday (all-day off-peak). */
export const DEFAULT_HOLIDAYS = Object.freeze([
  '2026-09-25', '2026-09-26', '2026-09-27',
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07',
]);

const num = (v) => (Number.isFinite(v) && v > 0 ? v : 0);

/** `YYYY-MM-DD` in Beijing time. */
export function dayInBeijing(at) {
  const d = new Date(at + 8 * 3600_000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** True inside a peak window (Beijing time, weekdays that are not holidays). */
export function isPeak(at, holidays = DEFAULT_HOLIDAYS) {
  const d = new Date(at + 8 * 3600_000);
  const weekday = d.getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  if (holidays.includes(dayInBeijing(at))) return false;
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes();
  return (minutes >= 9 * 60 && minutes < 12 * 60) || (minutes >= 14 * 60 && minutes < 18 * 60);
}

/** The model family a name belongs to. */
export function familyOf(model) {
  return typeof model === 'string' && /pro/i.test(model) ? 'pro' : 'flash';
}

/** CNY per 1M tokens of the model's family at [at]. */
export function priceAt(model, at, holidays) {
  const base = PRICES[familyOf(model)];
  const peak = isPeak(at, holidays);
  const factor = peak ? 2 : 1;
  return { miss: base.miss * factor, hit: base.hit * factor, output: base.output * factor, peak };
}

/** `105k`, `8.4k`, `512`. */
export function compact(tokens) {
  if (tokens < 1000) return String(Math.round(tokens));
  if (tokens < 100_000) {
    const k = tokens / 1000;
    return `${k < 10 ? k.toFixed(1).replace(/\.0$/, '') : Math.round(k)}k`;
  }
  return `${Math.round(tokens / 1000)}k`;
}

/** `0.11`, `<0.01`: rounded up to the fen, because a warning must not understate a bill. */
export function money(amount) {
  if (!(amount >= 0.01)) return '<0.01';
  if (amount >= 10) return (Math.ceil(amount * 10 - 1e-9) / 10).toFixed(1);
  return (Math.ceil(amount * 100 - 1e-9) / 100).toFixed(2);
}

/** 「刚刚还在用」/「14 分钟前」/「3 小时前」. */
export function sinceText(ms) {
  if (!(ms >= 0)) return '刚刚还在用';
  const min = Math.floor(ms / 60_000);
  if (min < 3) return '刚刚还在用';
  if (min < 60) return `${min} 分钟前`;
  const hours = Math.floor(min / 60);
  if (hours < 48) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

/** The card for one chat, or null when there is nothing worth saying. */
export function cardFor(chat, at, { holidays = DEFAULT_HOLIDAYS, dismissed } = {}) {
  if (chat === null || chat === undefined) return null;
  const { context, model, lastAt } = chat;
  if (!(context >= MIN_CONTEXT)) return null;
  const idle = at - lastAt;
  if (context < BIG_CONTEXT && idle < COLD_AFTER_MS) return null;
  const bucket = Math.round(context / 20_000);
  if (dismissed?.has(bucket)) return null;
  const price = priceAt(model, at, holidays);
  const missCost = (context * price.miss) / 1e6;
  const handoff = (ESTIMATE_TOKENS * price.miss) / 1e6;
  const fresh = handoff + (ESTIMATE_TOKENS * price.hit) / 1e6;
  return {
    text: `本会话上下文 ≈ ${compact(context)} token · ${sinceText(idle)} · 若缓存失效约 ${money(missCost)} 元`,
    note: `新开约 ${money(fresh)} 元 · ${price.peak ? '高峰价' : '空闲价'}`,
    icon: 'wallet',
    tone: price.peak ? 'warn' : 'muted',
    actions: [
      { id: 'open', label: '新开会话' },
      { id: 'dismiss', label: '知道了' },
    ],
  };
}

export const PKG = 'dsh-go-cost';
export const BANNER_ID = 'cost';
export const STRIP_ID = 'strip';
export const PANEL_ID = 'hud';
export const NOTE_ID = 'turn';
export const COPY_ID = 'copy';

/** The package.json shape parseManifest sees for the built-in card. */
export const MANIFEST = Object.freeze({
  name: PKG,
  version: '1.1.0',
  dshGo: {
    v: 1,
    title: { zh: '用量与费用', en: 'Usage & cost' },
    icon: 'coin',
    wants: [],
    contributes: {
      'composer.banner': [{ id: BANNER_ID, icon: 'coin' }],
      'composer.strip': [{ id: STRIP_ID, icon: 'coin', panel: PANEL_ID }],
      panels: [{ id: PANEL_ID, title: '用量与费用', icon: 'coin', placement: ['session.tab', 'features', 'chat.panel'] }],
      'turn.note': [{ id: NOTE_ID }],
      'composer.actions': [{ id: COPY_ID, label: { zh: '复制用量', en: 'Copy usage' }, icon: 'copy' }],
    },
  },
});

/** The card alone, for a host that switches the HUD off. */
export const BANNER_ONLY_MANIFEST = Object.freeze({
  name: PKG,
  version: '1.1.0',
  dshGo: {
    v: 1,
    title: { zh: '费用提示', en: 'Cost hint' },
    icon: 'coin',
    wants: [],
    contributes: { 'composer.banner': [{ id: BANNER_ID, icon: 'coin' }] },
  },
});

/**
 * The built-in banner definition. `ctx` is the bridge's own context, which
 * sees the same session events a plugin would.
 *
 * @returns {{ id: string, data: Function, actions: Record<string, Function> }}
 */
export function createCostBanner(ctx, options = {}) {
  const now = options.now ?? (() => Date.now());
  const holidays = options.holidays ?? DEFAULT_HOLIDAYS;
  /** sessionId -> { context, model, lastAt } */
  const chats = new Map();
  /** sessionId -> buckets the user sent away. */
  const dismissed = new Map();
  const listeners = new Set();

  const set = (sessionId, value) => {
    chats.set(sessionId, value);
    for (const notify of listeners) notify(sessionId);
  };

  const absorb = (sessionId, event) => {
    if (typeof sessionId !== 'string') return false;
    if (event?.type !== 'assistant/message') return false;
    const u = event.data?.usage;
    if (typeof u !== 'object' || u === null) return false;
    const context = num(u.inputTokens) + num(u.cacheReadTokens) + num(u.cacheWriteTokens) + num(u.outputTokens);
    if (!(context > 0)) return false;
    const model = event.data?.message?.source?.model;
    set(sessionId, {
      context,
      model: typeof model === 'string' && model !== '' ? model : chats.get(sessionId)?.model,
      lastAt: Number.isFinite(event.time) ? event.time : now(),
    });
    return true;
  };

  const look = (session) => {
    if (typeof session?.snapshotEvents !== 'function') return undefined;
    try {
      let lastEventAt;
      for (const event of session.snapshotEvents()) {
        if (Number.isFinite(event?.time)) lastEventAt = event.time;
        absorb(session.id, event);
      }
      return lastEventAt;
    } catch {
      // A host without the snapshot API: the card fills in from live events.
      return undefined;
    }
  };

  /**
   * A session opened from the sidebar owes its card immediately, before the
   * next assistant message. The token meter already knows the context the
   * host is carrying, so a cold session needs no live event to be priced.
   */
  // Cordis hands a service both as a property and through get(); a bridge-scoped
  // context can have one and not the other, so read whichever answers.
  const service = (name) => {
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
  };

  /** Sessions whose log we already replayed, so a cold read happens once. */
  const coldTried = new Set();

  /**
   * A session opened from the sidebar owes its card before the next assistant
   * message. Attached sessions answer through the meter; a session the host has
   * not attached (the phone engine keeps none) is replayed from its log.
   */
  const rememberCold = async (sessionId) => {
    if (coldTried.has(sessionId)) return;
    coldTried.add(sessionId);
    const query = service('sessionQuery');
    if (query?.readSession === undefined) return;
    try {
      const read = await query.readSession(sessionId);
      const events = Array.isArray(read?.events) ? read.events : [];
      for (const event of events) absorb(sessionId, event);
    } catch {
      // A log that cannot be replayed keeps the card dark until a turn lands.
    }
    for (const notify of listeners) notify(sessionId);
  };

  const remember = (session) => {
    if (session === undefined) return;
    const lastEventAt = look(session);
    if (chats.has(session.id)) return;
    let pressureTokens;
    try {
      pressureTokens = service('tokenMeter')?.contextPressure?.(session)?.pressureTokens;
    } catch {
      return;
    }
    if (typeof pressureTokens !== 'number' || !(pressureTokens > 0)) return;
    set(session.id, { context: pressureTokens, lastAt: lastEventAt ?? now() });
  };

  /** Sessions the event stream has shown us: the host may not answer get() cold. */
  const seenSessions = new Map();
  ctx.on('session/event', (session, event) => {
    if (typeof session?.id === 'string') seenSessions.set(session.id, session);
    absorb(session?.id, event);
  });

  const sessionOf = (sessionId) => {
    const seen = seenSessions.get(sessionId);
    if (seen !== undefined) return seen;
    const sessions = service('sessions');
    if (sessions === undefined) return undefined;
    try {
      const found = sessions.get?.(sessionId);
      if (found !== undefined) return found;
    } catch {
      // Fall through to the list: an id the store no longer keys still exists live.
    }
    try {
      const live = sessions.list?.() ?? [];
      return live.find((candidate) => candidate?.id === sessionId);
    } catch {
      return undefined;
    }
  };

  return {
    id: BANNER_ID,
    data: (scope, emit) => {
      const sessionId = scope?.sessionId;
      const push = () => {
        if (typeof sessionId !== 'string') return emit(null);
        if (!chats.has(sessionId)) {
          const session = sessionOf(sessionId);
          if (session === undefined) void rememberCold(sessionId);
          else remember(session);
        }
        // A session with nothing priced yet (or one the user sent away) shows no card.
        return emit(cardFor(chats.get(sessionId), now(), { holidays, dismissed: dismissed.get(sessionId) }));
      };
      push();
      listeners.add(push);
      return () => listeners.delete(push);
    },
    actions: {
      open: () => [{ type: 'command', name: 'new' }],
      dismiss: (scope) => {
        const sessionId = scope?.sessionId;
        const chat = typeof sessionId === 'string' ? chats.get(sessionId) : undefined;
        if (chat !== undefined) {
          const bucket = Math.round(chat.context / 20_000);
          const seen = dismissed.get(sessionId) ?? new Set();
          seen.add(bucket);
          dismissed.set(sessionId, seen);
        }
        for (const notify of listeners) notify(sessionId);
        return [];
      },
    },
  };
}
