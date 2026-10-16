import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ENV_KEYS = ["TOKEN_USAGE_WIDGET_CONFIG", "APPDATA"] as const;

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
  const configPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "config.ts");
  const url = `${pathToFileURL(configPath).href}?t=${Date.now()}-${Math.random()}`;
  return import(url);
}

test("configPath uses TOKEN_USAGE_WIDGET_CONFIG override", async () => {
  stashEnv();
  const override = path.join(os.tmpdir(), `tuw-cfg-${Date.now()}.json`);
  process.env.TOKEN_USAGE_WIDGET_CONFIG = override;
  const mod = await loadFreshConfigModule();
  assert.equal(mod.configPath(), path.resolve(override));
});

test("userDataDir on win32 uses APPDATA/token-usage-widget", async () => {
  stashEnv();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "tuw-appdata-"));
  tempDirs.push(base);
  process.env.APPDATA = base;
  delete process.env.TOKEN_USAGE_WIDGET_CONFIG;

  const PLATFORM = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  try {
    const mod = await loadFreshConfigModule();
    assert.equal(mod.userDataDir(), path.join(base, "token-usage-widget"));
    assert.equal(mod.configPath(), path.join(base, "token-usage-widget", "config.json"));
  } finally {
    if (PLATFORM) Object.defineProperty(process, "platform", PLATFORM);
  }
});

test("migrateCwdConfigIfNeeded copies cwd config once into user data", async () => {
  stashEnv();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tuw-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tuw-cwd-"));
  tempDirs.push(home, cwd);
  process.env.APPDATA = home;
  delete process.env.TOKEN_USAGE_WIDGET_CONFIG;

  const cwdConfig = path.join(cwd, "config.json");
  fs.writeFileSync(cwdConfig, '{"providers":{"openai":true},"opencode":{"go":{"authCookie":"old"}}}\n', "utf8");

  const prevCwd = process.cwd();
  const PLATFORM = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  process.chdir(cwd);
  try {
    const mod = await loadFreshConfigModule();
    const dest = mod.configPath();
    assert.equal(fs.existsSync(dest), false);
    mod.migrateCwdConfigIfNeeded();
    assert.deepEqual(JSON.parse(fs.readFileSync(dest, "utf8")), { providers: { openai: true } }, "B6: no opencode cookie");
    fs.writeFileSync(cwdConfig, '{"providers":{"openai":false}}\n', "utf8");
    mod.migrateCwdConfigIfNeeded();
    assert.deepEqual(JSON.parse(fs.readFileSync(dest, "utf8")), { providers: { openai: true } });
    // B6: a config that the user deletes must not come back from the checkout.
    fs.rmSync(dest);
    mod.migrateCwdConfigIfNeeded();
    assert.equal(fs.existsSync(dest), false);
  } finally {
    process.chdir(prevCwd);
    if (PLATFORM) Object.defineProperty(process, "platform", PLATFORM);
  }
});

test("exampleConfigPath resolves to package root config.example.json", async () => {
  stashEnv();
  const mod = await loadFreshConfigModule();
  const example = mod.exampleConfigPath();
  assert.ok(example.endsWith(`${path.sep}config.example.json`));
  assert.equal(fs.existsSync(example), true);
  assert.equal(path.dirname(example), mod.packageRoot());
});
