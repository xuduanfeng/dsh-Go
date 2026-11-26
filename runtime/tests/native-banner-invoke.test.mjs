// composer.banner over the real bridge HTTP routes: the row the app draws, and its buttons.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { NativeCore } from "../bridge/dsh-go-bridge/lib/native/core.js";
import { createNativeRoutes } from "../bridge/dsh-go-bridge/lib/native/routes.js";
import { effectiveLimits } from "../bridge/dsh-go-bridge/lib/native/limits.js";

const PKG = "banner-test";

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "native-banner-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: PKG, version: "1.0.0",
    dshGo: { v: 1, title: "B", contributes: { "composer.banner": [{ id: "cost", icon: "sparkles" }] } },
  }));
  writeFileSync(join(dir, "index.js"), "");
  const entry = { options: { id: "e0", name: pathToFileURL(join(dir, "index.js")).href }, parent: { tree: { ctx: { baseUrl: pathToFileURL(`${dir}/`).href } } }, dispose() {} };
  entry.fiber = { uid: 7, entry, parent: { fiber: null } };
  const caller = { ctx: { fiber: { parent: { fiber: entry.fiber } }, effect: (fn) => fn() } };
  const entries = [entry];
  const core = new NativeCore({ get: (n) => (n === "loader" ? { entries: () => entries } : undefined), logger: { warn() {} } }, effectiveLimits({}), "test");
  const routes = createNativeRoutes(core);
  const service = Object.assign(Object.create(core.service), { ctx: { fiber: { entry }, effect: (fn) => fn() } });
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://local");
    return routes.handle(req, res, url.pathname, url);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  const post = async (body) => {
    const r = await fetch(`http://127.0.0.1:${port}/dsh-go/v1/invoke`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, ...(await r.json()) };
  };
  const contributions = async () => {
    const r = await fetch(`http://127.0.0.1:${port}/dsh-go/v1/contributions?v=1&app=1.0.0&locale=zh-CN&surfaces=composer.actions,message.actions,composer.strip,panels,composer.banner`);
    return { status: r.status, ...(await r.json()) };
  };
  t.after(async () => {
    routes.dispose();
    core.dispose();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  });
  return { core, service, caller, post, contributions };
}

test("banner buttons invoke their action, and nothing else", async (t) => {
  const f = await fixture(t);
  f.service.banner.call(f.caller, "cost", {
    data: (_s, emit) => { emit({ text: "本会话上下文 ≈ 105k token", note: "若缓存失效约 0.11 元", tone: "warn", actions: [{ id: "open", label: "新开会话" }, { id: "dismiss", label: "知道了" }] }); return () => {}; },
    actions: { open: () => [{ type: "command", name: "new" }] },
  });
  const all = await f.contributions();
  const row = all.plugins.find((p) => p.pkg === PKG || p.id === PKG);
  assert.ok(row, `no row: ${JSON.stringify(all.plugins.map((p) => p.pkg ?? p.id))}`);
  assert.deepEqual(row.contributes["composer.banner"], [{ id: "cost", icon: "sparkles", ready: true, live: true }]);

  const ok = await f.post({ v: 1, pkg: PKG, id: "cost", surface: "composer.banner", action: "open", scope: { sessionId: "s" } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.effects, [{ type: "command", name: "new" }]);

  const wrong = await f.post({ v: 1, pkg: PKG, id: "cost", surface: "composer.banner", action: "nope", scope: { sessionId: "s" } });
  assert.equal(wrong.status, 409);
  assert.equal(wrong.error.code, "no-handler");

  const noAction = await f.post({ v: 1, pkg: PKG, id: "cost", surface: "composer.banner", scope: { sessionId: "s" } });
  assert.equal(noAction.status, 409, "no on(cost) either");
});
