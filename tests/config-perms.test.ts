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

posixTest("a Claude token refresh keeps .credentials.json at 0600", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tuw-perms-"));
  tempDirs.push(dir);
  const cred = path.join(dir, ".credentials.json");
  fs.writeFileSync(cred, JSON.stringify({ claudeAiOauth: { accessToken: "old" } }), { mode: 0o600 });
  const oldUmask = process.umask(0o022);
  try {
    const { __test } = await import("../src/adapters/claude.js");
    __test.writeClaudeOAuthFile(cred, { accessToken: "new", refreshToken: "r", expiresAt: 1 });
  } finally {
    process.umask(oldUmask);
  }

  assert.equal(fs.statSync(cred).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(cred, "utf8")).claudeAiOauth.accessToken, "new");
});

posixTest("a Claude token refresh keeps 0600 even over a stale world-readable .tmp", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tuw-perms-"));
  tempDirs.push(dir);
  const cred = path.join(dir, ".credentials.json");
  fs.writeFileSync(cred, JSON.stringify({ claudeAiOauth: { accessToken: "old" } }), { mode: 0o600 });
  fs.writeFileSync(`${cred}.tmp`, "stale", { mode: 0o644 });
  const oldUmask = process.umask(0o022);
  try {
    const { __test } = await import("../src/adapters/claude.js");
    __test.writeClaudeOAuthFile(cred, { accessToken: "new", refreshToken: "r", expiresAt: 1 });
  } finally {
    process.umask(oldUmask);
  }

  assert.equal(fs.statSync(cred).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(cred, "utf8")).claudeAiOauth.accessToken, "new");
});
