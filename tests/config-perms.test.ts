import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ENV_KEYS = ["TOKEN_USAGE_WIDGET_CONFIG", "APPDATA", "HOME", "USERPROFILE"] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
const tempDirs: string[] = [];

function stashEnv(): void {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
}

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const v = savedEnv[key];
    if (v === undefined) delete process.env[key];
    else process.env[key] = v;
  }
}

afterEach(() => {
  restoreEnv();
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function loadFreshConfigModule() {
  const src = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "config.ts");
  const url = `${pathToFileURL(src).href}?t=${Date.now()}-${Math.random()}`;
  return import(url);
}

const isPosix = process.platform !== "win32";
const posixTest = isPosix ? test : test.skip;

posixTest("writeConfig writes the secret-bearing config with mode 0600", async () => {
  stashEnv();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tuw-perms-"));
  tempDirs.push(dir);
  const cfg = path.join(dir, "config.json");
  process.env.TOKEN_USAGE_WIDGET_CONFIG = cfg;

  const { writeConfig } = await import("../src/cli/provider-config.js");
  writeConfig({ openrouter: { apiKey: "fixture-secret" } });

  assert.equal(fs.statSync(cfg).mode & 0o777, 0o600);
});

posixTest("loadConfig tightens a pre-existing world-readable config to 0600", async () => {
  stashEnv();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tuw-perms-"));
  tempDirs.push(dir);
  const cfg = path.join(dir, "config.json");
  fs.writeFileSync(cfg, JSON.stringify({ server: { port: 4321 } }), { mode: 0o644 });
  assert.equal(fs.statSync(cfg).mode & 0o777, 0o644);
  process.env.TOKEN_USAGE_WIDGET_CONFIG = cfg;

  const mod = await loadFreshConfigModule();
  await mod.loadConfig();

  assert.equal(fs.statSync(cfg).mode & 0o777, 0o600);
});

function tempConfig(): string {
  stashEnv();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tuw-cfg-"));
  tempDirs.push(dir);
  const cfg = path.join(dir, "config.json");
  process.env.TOKEN_USAGE_WIDGET_CONFIG = cfg;
  return cfg;
}

test("bad JSON config throws on CLI load and settings save, and the file is untouched", async () => {
  const cfg = tempConfig();
  const bad = '{"openrouter":{"apiKey":"keep-me"},';
  fs.writeFileSync(cfg, bad);
  const { loadExisting } = await import("../src/cli/provider-config.js");
  const { saveUiSettingsPatch } = await import("../src/settings-api.js");
  assert.throws(() => loadExisting(), /Config at .* is not valid JSON; fix or delete it/);
  await assert.rejects(saveUiSettingsPatch({ refreshIntervalSec: 120 }), /not valid JSON/);
  assert.equal(fs.readFileSync(cfg, "utf8"), bad);
});

test("config with a UTF-8 BOM parses in loadExisting and loadConfig", async () => {
  const cfg = tempConfig();
  fs.writeFileSync(cfg, '\uFEFF{"providers":{"kimi":true},"kimi":{"apiKey":"k1"}}');
  const { loadExisting } = await import("../src/cli/provider-config.js");
  assert.equal((loadExisting().kimi as { apiKey: string }).apiKey, "k1");
  const mod = await loadFreshConfigModule();
  const loaded = await mod.loadConfig();
  assert.equal(loaded.providers.kimi, true);
  assert.equal(loaded.kimi.apiKey, "k1");
});

test("writeConfig replaces the file atomically and leaves no .tmp", async () => {
  const cfg = tempConfig();
  fs.writeFileSync(cfg, '{"old":true}');
  const { writeConfig } = await import("../src/cli/provider-config.js");
  writeConfig({ openrouter: { apiKey: "new" } });
  assert.deepEqual(JSON.parse(fs.readFileSync(cfg, "utf8")), { openrouter: { apiKey: "new" } });
  assert.equal(fs.existsSync(`${cfg}.tmp`), false);
});

test("stale opencode block is dropped on load and not written back", async () => {
  const cfg = tempConfig();
  fs.writeFileSync(cfg, JSON.stringify({ opencode: { go: { authCookie: "old-cookie" } }, kimi: { apiKey: "k" } }));
  const { saveUiSettingsPatch } = await import("../src/settings-api.js");
  await saveUiSettingsPatch({ refreshIntervalSec: 120 });
  const saved = JSON.parse(fs.readFileSync(cfg, "utf8"));
  assert.equal("opencode" in saved, false);
  assert.equal(saved.kimi.apiKey, "k");
});

test("loadConfig keeps every provider off before setup (no config.example.json merge)", async () => {
  tempConfig();
  const mod = await loadFreshConfigModule();
  const loaded = await mod.loadConfig();
  assert.deepEqual(Object.values(loaded.providers).filter(Boolean), []);
});
