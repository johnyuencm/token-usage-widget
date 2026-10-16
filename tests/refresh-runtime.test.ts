import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { freePortWin32, refreshRuntime } from "../src/cli/refresh-runtime.js";

const healthResponse = (body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

test("freePortWin32 kills the pid from our own health body", async () => {
  const kills: string[][] = [];
  const freed = await freePortWin32(4321, "127.0.0.1", () => {}, {
    fetchImpl: healthResponse({ status: "ok", app: "token-usage-widget", pid: 4242 }),
    exec: (cmd, args) => kills.push([cmd, ...args]),
  });
  assert.equal(freed, true);
  assert.deepEqual(kills, [["taskkill", "/PID", "4242", "/T", "/F"]]);
});

test("freePortWin32 leaves another app on the port alone and reports it", async () => {
  const kills: string[][] = [];
  const logs: string[] = [];
  const freed = await freePortWin32(4321, "127.0.0.1", (m) => logs.push(m), {
    fetchImpl: healthResponse({ status: "ok", pid: 999 }),
    exec: (cmd, args) => kills.push([cmd, ...args]),
  });
  assert.equal(freed, false);
  assert.deepEqual(kills, []);
  assert.match(logs.join("\n"), /Port 4321 is used by another app; not stopping it/);
});

test("freePortWin32 does nothing when no server answers", async () => {
  const kills: string[][] = [];
  const freed = await freePortWin32(4321, "127.0.0.1", () => {}, {
    fetchImpl: (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch,
    exec: (cmd, args) => kills.push([cmd, ...args]),
  });
  assert.equal(freed, false);
  assert.deepEqual(kills, []);
});

test("refreshRuntime awaits freePort with the configured host and port before relaunch", async () => {
  const calls: string[] = [];
  await refreshRuntime({
    platform: "win32",
    loadConfig: () => ({ server: { host: "127.0.0.1", port: 5555 } }),
    freePort: async (port, host) => {
      await new Promise((r) => setImmediate(r));
      calls.push(`free ${host}:${port}`);
    },
    launchWidget: async () => {
      calls.push("launch");
    },
    log: () => {},
  });
  assert.deepEqual(calls, ["free 127.0.0.1:5555", "launch"]);
});

test("freePortWin32 probes 127.0.0.1 for a wildcard bind and sends the LAN token (CLI-6)", async () => {
  const seen: Array<{ url: string; auth: string | null }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    seen.push({ url, auth: new Headers(init?.headers).get("authorization") });
    return new Response(JSON.stringify({ app: "token-usage-widget", pid: 4242 }), { status: 200 });
  }) as unknown as typeof fetch;
  const exec = () => {};
  assert.equal(await freePortWin32(4321, "::", () => {}, { fetchImpl, exec }), true);
  assert.equal(await freePortWin32(4321, "0.0.0.0", () => {}, { fetchImpl, exec }), true);
  assert.equal(
    await freePortWin32(4321, "192.168.1.5", () => {}, { fetchImpl, exec, lanToken: "tok" }),
    true,
  );
  assert.deepEqual(seen, [
    { url: "http://127.0.0.1:4321/api/health", auth: null },
    { url: "http://127.0.0.1:4321/api/health", auth: null },
    { url: "http://192.168.1.5:4321/api/health", auth: "Bearer tok" },
  ]);
});

test("refreshRuntime passes the config LAN token and does not claim a refresh when nothing restarted (CLI-6)", async () => {
  const logs: string[] = [];
  let token: unknown;
  const prevEnv = process.env.TUW_LAN_TOKEN;
  delete process.env.TUW_LAN_TOKEN;
  await refreshRuntime({
    platform: "win32",
    loadConfig: () => ({ server: { host: "192.168.1.5", port: 4321, lanToken: "tok" } }),
    freePort: async (_port, _host, _log, deps) => {
      token = deps?.lanToken;
      return false;
    },
    launchWidget: async () => {},
    log: (m) => logs.push(m),
  }).finally(() => {
    if (prevEnv !== undefined) process.env.TUW_LAN_TOKEN = prevEnv;
  });
  assert.equal(token, "tok");
  assert.doesNotMatch(logs.join("\n"), /Widget refreshed/);
});

// Dashboard refresh (public/app.js), run in a vm with a permissive DOM stub.

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Any property is another stub; querySelector and cloneNode keep track of what they return. */
function stub(): any {
  const store = new Map<PropertyKey, unknown>();
  const kids = new Map<string, any>();
  const listeners: Record<string, (ev?: unknown) => unknown> = {};
  const clones: any[] = [];
  return new Proxy(function el() {}, {
    get(_t, key) {
      if (store.has(key)) return store.get(key);
      if (key === "then") return undefined;
      if (key === Symbol.iterator) return function* none() {};
      if (key === Symbol.toPrimitive) return () => "";
      if (key === "hidden") return false;
      if (key === "listeners") return listeners;
      if (key === "clones") return clones;
      if (key === "addEventListener") return (type: string, fn: (ev?: unknown) => unknown) => { listeners[type] = fn; };
      if (key === "cloneNode") return () => { const c = stub(); clones.push(c); return c; };
      if (key === "querySelector") {
        return (sel: string) => {
          if (!kids.has(sel)) kids.set(sel, stub());
          return kids.get(sel);
        };
      }
      const child = stub();
      store.set(key, child);
      return child;
    },
    set(_t, key, value) {
      store.set(key, value);
      return true;
    },
    apply: () => stub(),
  });
}

/** A <select>: setting a value with no matching <option> leaves it blank, as in a browser. */
function fakeSelect(values: number[]) {
  const options: Array<{ value: string }> = values.map((v) => ({ value: String(v) }));
  let value = "";
  return {
    options,
    appendChild(opt: { value: string }) { options.push(opt); },
    get value() { return value; },
    set value(v: string) { value = options.some((o) => o.value === String(v)) ? String(v) : ""; },
  };
}

function runDashboard(fetchImpl: (url: string, init?: any) => Promise<any>, seed: Record<string, any> = {}) {
  const elements = new Map<string, any>(Object.entries(seed));
  const intervals: Array<() => unknown> = [];
  const document = stub();
  document.getElementById = (id: string) => {
    if (!elements.has(id)) elements.set(id, stub());
    return elements.get(id);
  };
  const context: Record<string, unknown> = {
    document,
    window: { addEventListener: () => {} },
    location: { hash: "" },
    fetch: fetchImpl,
    structuredClone,
    setInterval: (fn: () => unknown) => intervals.push(fn),
    clearInterval: () => {},
    TokenUsageFmt: { formatReset: () => "" },
  };
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8"), context);
  return {
    elements,
    /** Run the latest auto-refresh timer once, as a poll does. */
    poll: async () => {
      await intervals.filter((fn) => fn.name === "refresh").at(-1)!();
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const json = (body: unknown) => ({ ok: true, json: async () => body });
const fetchedAt = new Date().toISOString();

test("dashboard keeps a saved interval that the select does not list, and never sends 0 (UI-1)", async () => {
  const form = stub();
  form.refreshIntervalSec = fakeSelect([30, 60, 120]);
  form.pollClaudeSec = fakeSelect([60, 300, 1800]);
  const ui = { refreshIntervalSec: 60, pollIntervalSec: { claude: 3600 } };
  const puts: any[] = [];
  runDashboard(async (url, init) => {
    if (init?.method === "PUT") {
      puts.push(JSON.parse(init.body).ui);
      return json({ ui });
    }
    return json(url === "/api/settings" ? { ui } : { providers: [], fetchedAt, ui });
  }, { "settings-form": form });
  await settle();
  assert.equal(form.pollClaudeSec.value, "3600", "the select shows the saved 3600 s");

  await form.listeners.submit({ preventDefault() {} });
  assert.equal(puts[0].pollIntervalSec.claude, 3600, "a save keeps 3600 s");

  form.refreshIntervalSec.value = "";
  await form.listeners.submit({ preventDefault() {} });
  assert.equal("refreshIntervalSec" in puts[1], false, "a blank select sends no interval");
});

test("a dashboard poll keeps a collapsed Cursor card collapsed (UI-4)", async () => {
  const ui = { refreshIntervalSec: 60 };
  const usage = {
    providers: [
      { provider: "cursor", label: "Cursor", billing: { totalPercentUsed: 10, autoPercentUsed: 5, apiPercentUsed: 1 } },
    ],
    fetchedAt,
    ui,
  };
  const run = runDashboard(async (url) => json(url === "/api/settings" ? { ui } : usage));
  await settle();
  const clones = run.elements.get("cursor-bill-template").content.clones;
  const first = clones.at(-1);
  first.querySelector(".bill-summary").listeners.click();
  assert.equal(first.querySelector(".bill-details").hidden, true, "the click collapses the card");

  await run.poll();
  const next = clones.at(-1);
  assert.notEqual(next, first, "the poll draws a new card");
  assert.equal(next.querySelector(".bill-details").hidden, true, "the new card stays collapsed");
});

test("a dashboard poll applies new display settings before it draws (UI-5)", async () => {
  const before = { refreshIntervalSec: 60, display: { claude: { fiveHour: true, week: true, spend: true } } };
  const after = { refreshIntervalSec: 60, display: { claude: { fiveHour: true, week: false, spend: true } } };
  const ok = { status: "ok", usedPercent: 10, remainingPercent: 90, resetsAtIso: null };
  const usage = { providers: [{ provider: "claude", label: "Claude", windows: { five_hour: ok, week: ok } }], fetchedAt, ui: after };
  const run = runDashboard(async (url) => json(url === "/api/settings" ? { ui: before } : usage));
  await settle();
  const drawn = run.elements
    .get("window-template")
    .content.clones.map((c: any) => c.querySelector(".window").dataset.window);
  assert.deepEqual(drawn, ["five_hour"], "the week meter that the new settings hide is not drawn");
});
test("the dashboard Cursor card says a hit limit first and never shows full or empty early (A4, A7)", async () => {
  const ui = { refreshIntervalSec: 60 };
  const billing = {
    totalPercentUsed: 99.6,
    autoPercentUsed: 45,
    apiPercentUsed: 6,
    remainingPercent: 0.4,
    limitHit: true,
    displayMessage: "You've hit your usage limit",
  };
  const usage = { providers: [{ provider: "cursor", label: "Cursor", billing }], fetchedAt, ui };
  const run = runDashboard(async (url) => json(url === "/api/settings" ? { ui } : usage));
  await settle();
  const card = run.elements.get("cursor-bill-template").content.clones.at(-1);
  assert.equal(
    card.querySelector(".bill-summary-text").textContent,
    "You've hit your usage limit. 45% First-party models and 6% API used",
  );
  assert.equal(card.querySelector(".bill-total-pct").textContent, "99%");
  assert.equal(card.querySelector(".bill-remaining").textContent, "1% remaining this cycle");
});
/* eslint-enable @typescript-eslint/no-explicit-any */
