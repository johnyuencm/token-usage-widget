import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  detectLocalAgentFlags,
  resolveSetupDefaultFlags,
  formatDefaultsLog,
} from "../src/cli/detect-local.js";
import { SETUP_DEFAULTS_ENABLED } from "../src/config.js";

test("detectLocalAgentFlags stays off when no CLIs or credential files exist", () => {
  const flags = detectLocalAgentFlags({
    platform: "win32",
    homeDir: "C:\\Users\\nobody",
    env: { APPDATA: "C:\\Users\\nobody\\AppData\\Roaming" },
    existsSync: () => false,
    commandExists: () => false,
  });
  assert.equal(flags.openai, false);
  assert.equal(flags.cursor, false);
  assert.equal(flags.claude, false);
  assert.equal(flags.openrouter, false);
});

test("detectLocalAgentFlags enables Codex, Cursor, and Claude from local signals", () => {
  const home = "C:\\Users\\dev";
  const appData = path.join(home, "AppData", "Roaming");
  const present = new Set([
    path.join(home, ".codex"),
    path.join(appData, "Cursor", "User", "globalStorage", "state.vscdb"),
    path.join(home, ".claude", ".credentials.json"),
  ]);
  const flags = detectLocalAgentFlags({
    platform: "win32",
    homeDir: home,
    env: { APPDATA: appData },
    existsSync: (p) => present.has(p),
    commandExists: (cmd) => ["codex", "cursor", "claude"].includes(cmd),
  });
  assert.equal(flags.openai, true);
  assert.equal(flags.cursor, true);
  assert.equal(flags.claude, true);
  assert.equal(flags.kimi, false);
});

test("detectLocalAgentFlags treats CLI presence as enough even without credential files", () => {
  const flags = detectLocalAgentFlags({
    platform: "win32",
    homeDir: "C:\\Users\\cli-only",
    env: {},
    existsSync: () => false,
    commandExists: (cmd) => cmd === "claude",
  });
  assert.equal(flags.claude, true);
  assert.equal(flags.openai, false);
  assert.equal(flags.cursor, false);
});

test("resolveSetupDefaultFlags enables detected local agents instead of a hardcoded pair", () => {
  const providers = resolveSetupDefaultFlags(false, {
    openai: true,
    cursor: true,
    claude: true,
    openrouter: false,
    kimi: false,
    zai: false,
    grok: false,
  });
  assert.deepEqual(
    ["openai", "cursor", "claude"].filter((id) => providers[id as keyof typeof providers]),
    ["openai", "cursor", "claude"],
  );
  assert.equal(providers.openrouter, false);
});

test("resolveSetupDefaultFlags falls back to openai+cursor when nothing is detected", () => {
  const none = detectLocalAgentFlags({
    homeDir: "/tmp/empty",
    env: {},
    existsSync: () => false,
    commandExists: () => false,
  });
  assert.deepEqual(resolveSetupDefaultFlags(false, none), SETUP_DEFAULTS_ENABLED);
});

test("resolveSetupDefaultFlags keeps saved flags and only turns on detected agents", () => {
  const saved = {
    openai: false,
    cursor: false,
    claude: false,
    openrouter: true,
    kimi: false,
    zai: false,
    grok: false,
  };
  const providers = resolveSetupDefaultFlags(false, { ...saved, openrouter: false, openai: true }, saved);
  assert.equal(providers.openrouter, true, "a provider the user turned on stays on");
  assert.equal(providers.openai, true, "a detected local agent turns on");
  assert.equal(providers.cursor, false);
  const none = { ...saved, openrouter: false };
  assert.deepEqual(resolveSetupDefaultFlags(false, none, saved), saved, "no fallback pair over saved flags");
});

test("resolveSetupDefaultFlags --all still enables every provider", () => {
  const providers = resolveSetupDefaultFlags(true);
  assert.equal(providers.openai, true);
  assert.equal(providers.grok, true);
  assert.equal(providers.kimi, true);
});

test("formatDefaultsLog names the detected providers", () => {
  assert.match(
    formatDefaultsLog(false, {
      openai: true,
      cursor: true,
      claude: true,
      openrouter: false,
      kimi: false,
      zai: false,
      grok: false,
    }, false),
    /openai, cursor, claude/,
  );
  assert.match(formatDefaultsLog(true, SETUP_DEFAULTS_ENABLED, false), /all providers enabled/);
  assert.match(
    formatDefaultsLog(false, SETUP_DEFAULTS_ENABLED, true),
    /no local agents detected/,
  );
});
