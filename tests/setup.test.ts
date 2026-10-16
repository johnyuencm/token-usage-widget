import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runDefaults, runInteractive, runSetup, type SetupDeps } from "../src/cli/setup.js";
import { PROVIDER_META } from "../src/providers/registry.js";
import {
  ensureClaudeCredentials,
  secretDetectNote,
  SECRET_BY_PROVIDER,
  setProviderEnabled,
  UNVALIDATED_SECRET_NOTE,
} from "../src/cli/provider-config.js";
import {
  enableProvider,
  disableProvider,
  listProviders,
  runProviderCommand,
  type ProviderCliDeps,
} from "../src/cli/providers.js";

/**
 * Behavior tests for the macOS login-launch integration in setup,
 * Claude credential remediation, runtime refresh, and single-provider toggles.
 */

let savedPlatform: string | undefined;
const PLATFORM_BACKUP = Object.getOwnPropertyDescriptor(process, "platform");

function setPlatform(p: string): void {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}
function restorePlatform(): void {
  if (PLATFORM_BACKUP) Object.defineProperty(process, "platform", PLATFORM_BACKUP);
  else if (savedPlatform) Object.defineProperty(process, "platform", { value: savedPlatform, configurable: true });
}

function makeDeps(overrides: Partial<SetupDeps> = {}): SetupDeps {
  return {
    runInteractive: async () => {},
    runDefaults: async () => {},
    installLoginLaunch: async () => ({ kind: "installed" as const }),
    buildSeams: () => ({
      platform: "darwin",
      homeDir: "/tmp/fake-home",
      checkout: "/tmp/fake-checkout",
      nodeBin: "/usr/bin/node",
      launcher: "/tmp/fake-checkout/scripts/start-widget.cjs",
      logDir: "/tmp/fake-home/Library/Logs/token-usage-dashboard",
      uid: 501,
      fs: {
        existsSync: () => false,
        mkdirSync: () => {},
        readFileSync: () => Buffer.from(""),
        writeFileSync: () => {},
        renameSync: () => {},
        unlinkSync: () => {},
        rmSync: () => {},
      },
      execFile: (_cmd, _args, cb) => cb(null, "", ""),
    }),
    ensureClaude: () => {},
    refreshRuntime: async () => {},
    // No saved config: a first setup.
    loadExisting: () => ({}),
    ...overrides,
  };
}

const ALL_OFF = {
  openai: false,
  cursor: false,
  claude: false,
  openrouter: false,
  kimi: false,
  zai: false,
  grok: false,
};

/** Point TOKEN_USAGE_WIDGET_CONFIG at a temp config.json for the run of `fn`. */
async function withTempConfig(
  initial: Record<string, unknown>,
  fn: (cfgPath: string) => Promise<void>,
): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tuw-cfg-"));
  const cfg = path.join(dir, "config.json");
  fs.writeFileSync(cfg, JSON.stringify(initial));
  const prev = process.env.TOKEN_USAGE_WIDGET_CONFIG;
  process.env.TOKEN_USAGE_WIDGET_CONFIG = cfg;
  try {
    await fn(cfg);
  } finally {
    if (prev === undefined) delete process.env.TOKEN_USAGE_WIDGET_CONFIG;
    else process.env.TOKEN_USAGE_WIDGET_CONFIG = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const readJson = (p: string) => JSON.parse(fs.readFileSync(p, "utf8"));

test("darwin interactive setup calls installLoginLaunch then refresh after setup resolves", async () => {
  setPlatform("darwin");
  try {
    const calls: string[] = [];
    const deps = makeDeps({
      runInteractive: async () => { calls.push("setup"); },
      runDefaults: async () => { calls.push("setup"); },
      installLoginLaunch: async () => { calls.push("register"); return { kind: "installed" }; },
      refreshRuntime: async () => { calls.push("refresh"); },
    });
    await runSetup([], deps);
    assert.deepEqual(calls, ["setup", "register", "refresh"]);
  } finally {
    restorePlatform();
  }
});

test("darwin --defaults calls runDefaults (not all) then registers once then refresh", async () => {
  setPlatform("darwin");
  try {
    const calls: string[] = [];
    const deps = makeDeps({
      runInteractive: async () => { calls.push("interactive"); },
      runDefaults: async () => { calls.push("defaults"); },
      installLoginLaunch: async () => { calls.push("register"); return { kind: "installed" }; },
      refreshRuntime: async () => { calls.push("refresh"); },
    });
    await runSetup(["--defaults"], deps);
    assert.deepEqual(calls, ["defaults", "register", "refresh"]);
  } finally {
    restorePlatform();
  }
});

test("darwin --defaults --all calls runDefaults(true) then registers once", async () => {
  setPlatform("darwin");
  try {
    const seen: { all: boolean | undefined } = { all: undefined };
    const deps = makeDeps({
      runDefaults: async (all) => { seen.all = all; },
      installLoginLaunch: async () => ({ kind: "installed" }),
    });
    await runSetup(["--defaults", "--all"], deps);
    assert.equal(seen.all, true);
  } finally {
    restorePlatform();
  }
});

test("repeated setup refreshes an installed LaunchAgent each time", async () => {
  setPlatform("darwin");
  try {
    let count = 0;
    const base = makeDeps().buildSeams();
    const deps = makeDeps({
      loadExisting: () => ({ providers: { openai: true } }),
      buildSeams: () => ({ ...base, fs: { ...base.fs, existsSync: () => true } }),
      installLoginLaunch: async () => { count++; return { kind: count === 1 ? "installed" : "refreshed" }; },
    });
    await runSetup(["--defaults"], deps);
    await runSetup(["--defaults"], deps);
    await runSetup(["--defaults"], deps);
    assert.equal(count, 3);
  } finally {
    restorePlatform();
  }
});

test("darwin setup does not reinstall a LaunchAgent that the user removed (CLI-7)", async () => {
  setPlatform("darwin");
  try {
    let registered = false;
    const deps = makeDeps({
      // Config from an earlier setup; the fake fs has no plist (startup:disable removed it).
      loadExisting: () => ({ providers: { openai: true } }),
      installLoginLaunch: async () => { registered = true; return { kind: "installed" }; },
    });
    await runSetup(["--defaults"], deps);
    assert.equal(registered, false);
  } finally {
    restorePlatform();
  }
});

test("pre-save setup rejection propagates and registration is never called", async () => {
  setPlatform("darwin");
  try {
    let registered = false;
    let refreshed = false;
    const deps = makeDeps({
      runInteractive: async () => { throw new Error("config save failed"); },
      installLoginLaunch: async () => { registered = true; return { kind: "installed" }; },
      refreshRuntime: async () => { refreshed = true; },
    });
    await assert.rejects(() => runSetup([], deps), /config save failed/);
    assert.equal(registered, false);
    assert.equal(refreshed, false);
  } finally {
    restorePlatform();
  }
});

test("post-save registration rejection throws actionable error with retry command and preserves config", async () => {
  setPlatform("darwin");
  try {
    let configWrites = 0;
    const deps = makeDeps({
      runInteractive: async () => { configWrites++; },
      installLoginLaunch: async () => { throw new Error("launchctl failed"); },
    });
    await assert.rejects(
      () => runSetup([], deps),
      (e: Error) => /startup was not enabled/.test(e.message) && /npm run widget:startup/.test(e.message),
    );
    assert.equal(configWrites, 1);
  } finally {
    restorePlatform();
  }
});

test("invalid --all without --defaults exits nonzero without registering", async () => {
  setPlatform("darwin");
  try {
    let registered = false;
    const deps = makeDeps({
      installLoginLaunch: async () => { registered = true; return { kind: "installed" }; },
    });
    await assert.rejects(() => runSetup(["--all"], deps), /--all is only valid with --defaults/);
    assert.equal(registered, false);
  } finally {
    restorePlatform();
  }
});

test("win32 skips automatic login registration but still runs setup and refresh", async () => {
  setPlatform("win32");
  try {
    const calls: string[] = [];
    const deps = makeDeps({
      runInteractive: async () => { calls.push("interactive"); },
      installLoginLaunch: async () => { calls.push("register"); return { kind: "installed" }; },
      refreshRuntime: async () => { calls.push("refresh"); },
    });
    await runSetup([], deps);
    assert.deepEqual(calls, ["interactive", "refresh"]);
  } finally {
    restorePlatform();
  }
});

test("win32 --defaults --all still works without registration", async () => {
  setPlatform("win32");
  try {
    const calls: string[] = [];
    const deps = makeDeps({
      runDefaults: async () => { calls.push("defaults"); },
      installLoginLaunch: async () => { calls.push("register"); return { kind: "installed" }; },
      refreshRuntime: async () => { calls.push("refresh"); },
    });
    await runSetup(["--defaults", "--all"], deps);
    assert.deepEqual(calls, ["defaults", "refresh"]);
  } finally {
    restorePlatform();
  }
});

test("registration uses seams from the injected buildSeams (current checkout)", async () => {
  setPlatform("darwin");
  try {
    let seenSeamsCheckout: string | undefined;
    const deps = makeDeps({
      buildSeams: () => ({
        platform: "darwin",
        homeDir: "/tmp/fake-home",
        checkout: "/tmp/specific-checkout",
        nodeBin: "/usr/bin/node",
        launcher: "/tmp/specific-checkout/scripts/start-widget.cjs",
        logDir: "/tmp/fake-home/Library/Logs/token-usage-dashboard",
        uid: 501,
        fs: {
          existsSync: () => false,
          mkdirSync: () => {},
          readFileSync: () => Buffer.from(""),
          writeFileSync: () => {},
          renameSync: () => {},
          unlinkSync: () => {},
          rmSync: () => {},
        },
        execFile: (_cmd, _args, cb) => cb(null, "", ""),
      }),
      installLoginLaunch: async (seams) => {
        seenSeamsCheckout = seams.checkout;
        return { kind: "installed" };
      },
    });
    await runSetup(["--defaults"], deps);
    assert.equal(seenSeamsCheckout, "/tmp/specific-checkout");
  } finally {
    restorePlatform();
  }
});

test("secretDetectNote is honest when nothing is detected", () => {
  const secret = SECRET_BY_PROVIDER.claude!;
  assert.match(secretDetectNote(secret, null), /none detected/);
  assert.match(secretDetectNote(secret, "tok"), /detected env\/file/);
  // Setup persists pasted secrets without validating them; the note says so.
  assert.match(UNVALIDATED_SECRET_NOTE, /unvalidated/);
});

test("ensureClaudeCredentials runs auth login then succeeds when detect finds token", () => {
  let loginCalls = 0;
  ensureClaudeCredentials(
    { providers: { ...Object.fromEntries(["openai", "cursor", "claude", "openrouter", "kimi", "zai", "grok"].map((id) => [id, id === "claude"])) } },
    {
      resolveToken: () => null,
      authLogin: () => {
        loginCalls++;
        return { status: 0 };
      },
      detect: () => "token-after-login",
    },
  );
  assert.equal(loginCalls, 1);
});

test("ensureClaudeCredentials throws actionable error when still missing after login", () => {
  assert.throws(
    () =>
      ensureClaudeCredentials(
        { providers: { openai: false, cursor: false, claude: true, openrouter: false, kimi: false, zai: false, grok: false } },
        {
          resolveToken: () => null,
          authLogin: () => ({ status: 0 }),
          detect: () => null,
        },
      ),
    /claude auth login/,
  );
});

test("setup calls ensureClaude then refresh when Claude enabled without token", async () => {
  setPlatform("win32");
  try {
    const calls: string[] = [];
    const deps = makeDeps({
      runInteractive: async () => { calls.push("setup"); },
      loadExisting: () => ({
        providers: {
          openai: false,
          cursor: false,
          claude: true,
          openrouter: false,
          kimi: false,
          zai: false,
          grok: false,
        },
      }),
      ensureClaude: () => { calls.push("ensureClaude"); },
      refreshRuntime: async () => { calls.push("refresh"); },
    });
    await runSetup([], deps);
    assert.deepEqual(calls, ["setup", "ensureClaude", "refresh"]);
  } finally {
    restorePlatform();
  }
});

test("setup ensureClaude failure propagates and skips refresh", async () => {
  setPlatform("win32");
  try {
    let refreshed = false;
    const deps = makeDeps({
      loadExisting: () => ({
        providers: {
          openai: false,
          cursor: false,
          claude: true,
          openrouter: false,
          kimi: false,
          zai: false,
          grok: false,
        },
      }),
      ensureClaude: () => {
        throw new Error("Claude enabled but not logged in. Run: claude auth login");
      },
      refreshRuntime: async () => { refreshed = true; },
    });
    await assert.rejects(() => runSetup([], deps), /claude auth login/);
    assert.equal(refreshed, false);
  } finally {
    restorePlatform();
  }
});

function providerDeps(overrides: Partial<ProviderCliDeps> = {}): ProviderCliDeps {
  let store: Record<string, unknown> = {
    providers: {
      openai: true,
      cursor: true,
      claude: false,
      openrouter: false,
      kimi: false,
      zai: false,
      grok: false,
    },
  };
  return {
    loadExisting: () => structuredClone(store),
    writeConfig: (merged) => { store = merged; },
    askLine: async () => "",
    ensureClaude: () => {},
    refreshRuntime: async () => {},
    log: () => {},
    ...overrides,
    // keep store accessible for assertions via closure when not overridden
    ...(overrides.loadExisting || overrides.writeConfig
      ? {}
      : {
          loadExisting: () => structuredClone(store),
          writeConfig: (merged) => { store = merged; },
        }),
  };
}

test("enable claude writes flag, runs ensureClaude, refreshes", async () => {
  let store: Record<string, unknown> = {
    providers: {
      openai: true,
      cursor: true,
      claude: false,
      openrouter: false,
      kimi: false,
      zai: false,
      grok: false,
    },
  };
  const calls: string[] = [];
  await enableProvider("claude", {
    loadExisting: () => structuredClone(store),
    writeConfig: (merged) => { store = merged; calls.push("write"); },
    askLine: async () => "",
    ensureClaude: () => { calls.push("ensureClaude"); },
    refreshRuntime: async () => { calls.push("refresh"); },
    log: () => {},
  });
  assert.equal((store.providers as { claude: boolean }).claude, true);
  assert.deepEqual(calls, ["write", "ensureClaude", "refresh"]);
});

test("disable claude writes false and refreshes without auth", async () => {
  let store: Record<string, unknown> = {
    providers: {
      openai: true,
      cursor: true,
      claude: true,
      openrouter: false,
      kimi: false,
      zai: false,
      grok: false,
    },
  };
  const calls: string[] = [];
  await disableProvider("claude", {
    loadExisting: () => structuredClone(store),
    writeConfig: (merged) => { store = merged; calls.push("write"); },
    ensureClaude: () => { calls.push("ensureClaude"); },
    refreshRuntime: async () => { calls.push("refresh"); },
    log: () => {},
  });
  assert.equal((store.providers as { claude: boolean }).claude, false);
  assert.deepEqual(calls, ["write", "refresh"]);
});

test("enable unknown provider rejects with known ids", async () => {
  await assert.rejects(() => enableProvider("nope", providerDeps()), /Unknown provider.*claude/);
});

test("runProviderCommand providers lists flags", () => {
  const lines: string[] = [];
  listProviders({
    loadExisting: () => ({
      providers: {
        openai: true,
        cursor: true,
        claude: false,
        openrouter: false,
        kimi: false,
        zai: false,
        grok: false,
      },
    }),
    log: (msg) => lines.push(msg),
  });
  assert.ok(lines.some((l) => /\bopenai\b.*\bon\b/.test(l)));
  assert.ok(lines.some((l) => /\bclaude\b.*\boff\b/.test(l)));
});

test("runProviderCommand enable routes to enableProvider", async () => {
  let store: Record<string, unknown> = {
    providers: {
      openai: false,
      cursor: false,
      claude: false,
      openrouter: false,
      kimi: false,
      zai: false,
      grok: false,
    },
  };
  await runProviderCommand(["enable", "cursor"], {
    loadExisting: () => structuredClone(store),
    writeConfig: (merged) => { store = merged; },
    askLine: async () => "",
    ensureClaude: () => {},
    refreshRuntime: async () => {},
    log: () => {},
  });
  assert.equal((store.providers as { cursor: boolean }).cursor, true);
});

test("setProviderEnabled preserves other flags", () => {
  const merged = setProviderEnabled(
    {
      providers: {
        openai: true,
        cursor: true,
        claude: false,
        openrouter: false,
        kimi: false,
        zai: false,
        grok: false,
      },
    },
    "kimi",
    true,
  );
  const p = merged.providers as Record<string, boolean>;
  assert.equal(p.openai, true);
  assert.equal(p.cursor, true);
  assert.equal(p.kimi, true);
  assert.equal(p.claude, false);
});

test("askQuestion rejects when input closes before an answer (EOF)", async () => {
  const { PassThrough } = await import("node:stream");
  const readline = await import("node:readline");
  const { askQuestion } = await import("../src/cli/provider-config.js");
  const input = new PassThrough();
  const rl = readline.createInterface({ input, output: new PassThrough() });
  const pending = askQuestion(rl, "Enable? ");
  input.end();
  await assert.rejects(pending, /Input closed before setup finished/);
});

test("tuw setup with stdin closed exits 1 and writes no config", async () => {
  const { spawnSync } = await import("node:child_process");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tuw-eof-"));
  const cfg = path.join(dir, "config.json");
  try {
    const res = spawnSync(process.execPath, ["--import", "tsx", "src/cli/setup.ts"], {
      input: "",
      env: { ...process.env, TOKEN_USAGE_WIDGET_CONFIG: cfg },
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(res.status, 1, res.stderr);
    assert.match(res.stderr, /Input closed before setup finished/);
    assert.equal(fs.existsSync(cfg), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("setup --defaults keeps a provider that the user turned on (CLI-1)", async () => {
  await withTempConfig({ providers: { ...ALL_OFF, openrouter: true } }, async (cfg) => {
    await runDefaults(false);
    assert.equal(readJson(cfg).providers.openrouter, true);
  });
});

test("interactive setup keeps a dashboard save made while the prompts wait (CLI-2)", async () => {
  await withTempConfig({ providers: ALL_OFF, ui: { refreshIntervalSec: 900 } }, async (cfg) => {
    const input = new PassThrough();
    const run = runInteractive(input);
    // Setup has read config.json; the dashboard now saves a new interval.
    fs.writeFileSync(cfg, JSON.stringify({ providers: ALL_OFF, ui: { refreshIntervalSec: 60 } }));
    const answers = PROVIDER_META.flatMap((m) => (m.id === "openrouter" ? ["y", "sk-or-test"] : ["n"]));
    for (const answer of answers) {
      await new Promise((r) => setImmediate(r));
      input.write(`${answer}\n`);
    }
    await run;
    const saved = readJson(cfg);
    assert.equal(saved.ui.refreshIntervalSec, 60, "the dashboard save is kept");
    assert.equal(saved.providers.openrouter, true, "the prompt answer is merged");
    assert.equal(saved.openrouter.apiKey, "sk-or-test", "the pasted key is merged");
  });
});

test("enable does not ask again for a key that config.json already has (CLI-5)", async () => {
  const prevKey = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  try {
    let asked = "";
    let store: Record<string, unknown> = { providers: ALL_OFF, openrouter: { apiKey: "sk-saved" } };
    await enableProvider("openrouter", {
      loadExisting: () => structuredClone(store),
      writeConfig: (merged) => { store = merged; },
      askLine: async (q) => { asked = q; return ""; },
      ensureClaude: () => {},
      refreshRuntime: async () => {},
      log: () => {},
    });
    assert.equal(asked, "", `no key prompt expected, got: ${asked}`);
    assert.equal((store.openrouter as { apiKey: string }).apiKey, "sk-saved");
  } finally {
    if (prevKey !== undefined) process.env.OPENROUTER_API_KEY = prevKey;
  }
});

test("a CLI entry reached through a junction or symlink still runs (CLI-4)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tuw-link-"));
  const link = path.join(dir, "src");
  fs.symlinkSync(fileURLToPath(new URL("../src", import.meta.url)), link, "junction");
  const cfg = path.join(dir, "config.json");
  fs.writeFileSync(cfg, JSON.stringify({ providers: { ...ALL_OFF, openai: true } }));
  try {
    const res = spawnSync(
      process.execPath,
      ["--import", "tsx", path.join(link, "cli", "providers.ts"), "providers"],
      { env: { ...process.env, TOKEN_USAGE_WIDGET_CONFIG: cfg }, encoding: "utf8", timeout: 30_000 },
    );
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /openai\s+on/);
  } finally {
    // unlink removes only the link, never the linked folder.
    fs.unlinkSync(link);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
