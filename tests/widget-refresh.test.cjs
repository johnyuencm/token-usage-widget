"use strict";

/**
 * Renderer timer and settings-form behavior for public/widget.js and public/app.js.
 * Runs each script in a vm with a permissive DOM stub.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

/** Callable, memoized, any-property DOM stand-in. */
function fakeEl() {
  const store = new Map();
  return new Proxy(function stub() {}, {
    get(_t, key) {
      if (key === Symbol.iterator) return function* empty() {};
      if (key === Symbol.toPrimitive) return () => "";
      if (!store.has(key)) store.set(key, fakeEl());
      return store.get(key);
    },
    set(_t, key, value) {
      store.set(key, value);
      return true;
    },
    apply: () => fakeEl(),
  });
}

function runScript(file, fetchImpl, extra = {}) {
  const intervals = [];
  const elements = new Map();
  const document = fakeEl();
  document.getElementById = (id) => {
    if (!elements.has(id)) elements.set(id, fakeEl());
    return elements.get(id);
  };
  const context = {
    document,
    window: {},
    location: { hash: "" },
    fetch: fetchImpl,
    structuredClone,
    requestAnimationFrame: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: (fn, ms) => {
      intervals.push({ fn, ms, cleared: false });
      return intervals.length;
    },
    clearInterval: (id) => {
      if (intervals[id - 1]) intervals[id - 1].cleared = true;
    },
    TokenUsageCompact: {
      providerLine: () => "line",
      providerTitle: () => "",
      wrapProviderLine: (line) => [line],
      maxCharsForWidth: () => 40,
    },
    TokenUsageFmt: { formatReset: () => "" },
  };
  Object.assign(context, extra);
  context.globalThis = context;
  context.window.addEventListener = () => {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "public", file), "utf8"), context);
  return { intervals, elements, document, live: () => intervals.filter((t) => !t.cleared) };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("widget keeps one refresh timer after a failed first load", async () => {
  let ok = false;
  const usage = { providers: [], fetchedAt: new Date().toISOString(), ui: { refreshIntervalSec: 60 } };
  const run = runScript("widget.js", async () => {
    if (!ok) throw new Error("ECONNREFUSED");
    return { ok: true, json: async () => usage };
  });
  await tick();
  assert.equal(run.live().length, 1, "a timer runs although the first load failed");

  ok = true;
  run.live()[0].fn();
  await tick();
  assert.equal(run.live().length, 1, "a later render does not add a second timer");
});

test("widget sends the body height to fit, not the root scrollHeight (D1)", async () => {
  const sent = [];
  const usage = { providers: [], fetchedAt: new Date().toISOString(), ui: { refreshIntervalSec: 60 } };
  const run = runScript("widget.js", async () => ({ ok: true, json: async () => usage }), {
    requestAnimationFrame: (fn) => fn(),
    window: { widgetBridge: { fitContent: (payload) => sent.push(payload) } },
  });
  // The root scrollHeight is never below the window height, so it can not shrink the widget.
  const root = run.document.documentElement;
  root.scrollHeight = 400;
  root.getBoundingClientRect = () => ({ height: 400 });
  run.document.body.getBoundingClientRect = () => ({ height: 123 });
  run.live()[0].fn();
  await tick();
  assert.equal(sent.at(-1).height, 123);
});

test("widget shows the server error text and clears it after recovery (B4, UI-6)", async () => {
  let ok = false;
  const usage = { providers: [], fetchedAt: new Date().toISOString(), ui: { refreshIntervalSec: 60 } };
  const run = runScript("widget.js", async () =>
    ok
      ? { ok: true, json: async () => usage }
      : { ok: false, status: 500, json: async () => ({ error: "config.json cannot be read" }) },
  );
  await tick();
  const status = run.elements.get("status");
  assert.equal(status.title, "config.json cannot be read");
  ok = true;
  run.live()[0].fn();
  await tick();
  assert.equal(status.title, "");
});

test("dashboard poll does not overwrite unsaved settings edits", async () => {
  const ui = { refreshIntervalSec: 60, pollIntervalSec: { claude: 300 } };
  const run = runScript("app.js", async (url) => ({
    ok: true,
    json: async () =>
      url === "/api/settings" ? { ui } : { providers: [], fetchedAt: new Date().toISOString(), ui },
  }));
  await tick();
  const form = run.elements.get("settings-form");
  assert.equal(form.refreshIntervalSec.value, "60", "loadSettings fills the form first");

  form.refreshIntervalSec.value = "999"; // user edit, not saved yet
  run.live().at(-1).fn();
  await tick();
  assert.equal(form.refreshIntervalSec.value, "999");
});
