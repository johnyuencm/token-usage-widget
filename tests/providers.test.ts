import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { __test as claudeTest, fetchClaudeUsage } from "../src/adapters/claude.js";
import { __test as pollTest, fetchProviderThrottled } from "../src/providers/poll-cache.js";
import {
  __test as cursorTest,
  fetchCursorUsage,
  readCursorAccessToken,
  resolveCursorStateDbPath,
} from "../src/adapters/cursor.js";
import { copySqliteSidecars, sqliteScalar } from "../src/sqlite-scalar.js";
import { __test as kimiTest } from "../src/adapters/kimi.js";
import { __test as zaiTest } from "../src/adapters/zai.js";
import { fetchOpenRouterUsage } from "../src/adapters/openrouter.js";
import type { Config } from "../src/config.js";
import { DEFAULT_ENABLED } from "../src/config.js";
import { DEFAULT_UI } from "../src/ui-settings.js";
import { unavailableAll } from "../src/types.js";

const require = createRequire(import.meta.url);
const { providerLine } = require("../public/widget-compact.js");

function bareConfig(overrides: Partial<Config> = {}): Config {
  return {
    providers: { ...DEFAULT_ENABLED },
    openrouter: { apiKey: null },
    kimi: { apiKey: null },
    zai: { apiKey: null },
    grok: { oauthToken: null },
    claude: { accessToken: null },
    server: { port: 4321, host: "127.0.0.1", lanToken: null },
    ui: structuredClone(DEFAULT_UI),
    ...overrides,
  };
}

async function makeTempDir(t: { after(fn: () => Promise<void>): void }): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "token-usage-providers-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("Cursor uses the standard macOS state database for normal usage", async (t) => {
  const homeDir = await makeTempDir(t);
  const dbPath = path.join(
    homeDir,
    "Library",
    "Application Support",
    "Cursor",
    "User",
    "globalStorage",
    "state.vscdb",
  );
  await mkdir(path.dirname(dbPath), { recursive: true });
  await writeFile(
    dbPath,
    JSON.stringify({
      "cursorAuth/accessToken": "fixture-cursor-token",
      "cursorAuth/stripeMembershipType": "pro",
    }),
  );

  const sqlitePaths: string[] = [];
  const usage = await fetchCursorUsage({
    platform: "darwin",
    homeDir,
    env: {},
    sqliteGet: async (fixturePath, sql) => {
      sqlitePaths.push(fixturePath);
      const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as Record<string, string>;
      const key = sql.includes("stripeMembershipType")
        ? "cursorAuth/stripeMembershipType"
        : "cursorAuth/accessToken";
      return fixture[key] ?? "";
    },
    fetchImpl: async (_input, init) => {
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer fixture-cursor-token");
      assert.ok(init?.signal instanceof AbortSignal, "Cursor fetch must carry a timeout signal");
      return new Response(
        JSON.stringify({
          billingCycleEnd: "1780000000000",
          planUsage: { totalPercentUsed: 37 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });

  assert.equal(usage.windows.month.status, "ok");
  assert.equal(usage.windows.month.usedPercent, 37);
  assert.equal(usage.billing?.planLabel, "Included in Pro");
  assert.deepEqual(sqlitePaths, [dbPath, dbPath]);
});

test("Cursor path and token overrides stay ahead of platform defaults", async () => {
  assert.equal(
    resolveCursorStateDbPath({
      platform: "darwin",
      homeDir: "/Users/example",
      env: { CURSOR_STATE_DB: "/override/cursor.sqlite" },
    }),
    "/override/cursor.sqlite",
  );
  assert.equal(
    resolveCursorStateDbPath({ platform: "win32", homeDir: "C:\\Users\\example", env: {} }),
    path.join("C:\\Users\\example", "AppData", "Roaming", "Cursor", "User", "globalStorage", "state.vscdb"),
  );
  assert.equal(
    await readCursorAccessToken({
      platform: "darwin",
      homeDir: "/Users/example",
      env: { CURSOR_TOKEN: "override-token" },
      sqliteGet: async () => {
        throw new Error("sqlite should not run for CURSOR_TOKEN");
      },
    }),
    "override-token",
  );
});

test("sqliteScalar reads via node:sqlite without calling sqlite3 CLI", async (t) => {
  let DatabaseSync: new (file: string) => {
    exec(sql: string): void;
    prepare(sql: string): { run(...args: unknown[]): void };
    close(): void;
  };
  try {
    ({ DatabaseSync } = require("node:sqlite") as { DatabaseSync: typeof DatabaseSync });
  } catch {
    t.skip("node:sqlite not available");
    return;
  }
  const dir = await makeTempDir(t);
  const dbPath = path.join(dir, "state.vscdb");
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE ItemTable (key TEXT, value TEXT)");
  db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run(
    "cursorAuth/accessToken",
    "tok-from-node-sqlite",
  );
  db.close();

  const cliCalls: string[] = [];
  const value = await sqliteScalar(
    dbPath,
    "SELECT value FROM ItemTable WHERE key='cursorAuth/accessToken';",
    {
      execFile: async () => {
        cliCalls.push("sqlite3");
        throw new Error("ENOENT: sqlite3 not found");
      },
    },
  );
  assert.equal(value, "tok-from-node-sqlite");
  assert.deepEqual(cliCalls, []);
});

test("sqliteScalar falls back to sqlite3 CLI when node:sqlite fails", async () => {
  const value = await sqliteScalar("missing.vscdb", "SELECT 1;", {
    nodeSqliteGet: () => {
      throw new Error("node:sqlite unavailable");
    },
    execFile: async () => ({ stdout: "from-cli\n" }),
  });
  assert.equal(value, "from-cli");
});

test("Cursor reads access token from state.vscdb without sqlite3 CLI", async (t) => {
  let DatabaseSync: new (file: string) => {
    exec(sql: string): void;
    prepare(sql: string): { run(...args: unknown[]): void };
    close(): void;
  };
  try {
    ({ DatabaseSync } = require("node:sqlite") as { DatabaseSync: typeof DatabaseSync });
  } catch {
    t.skip("node:sqlite not available");
    return;
  }
  const dir = await makeTempDir(t);
  const dbPath = path.join(dir, "state.vscdb");
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE ItemTable (key TEXT, value TEXT)");
  db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run(
    "cursorAuth/accessToken",
    "tok-from-vscdb",
  );
  db.close();

  const token = await readCursorAccessToken({
    platform: "win32",
    homeDir: dir,
    env: { CURSOR_STATE_DB: dbPath },
  });
  assert.equal(token, "tok-from-vscdb");
});

test("Cursor reader skips the copy when the read fails without a lock", async (t) => {
  const dir = await makeTempDir(t);
  const before = new Set(await readdir(os.tmpdir()));
  const reader = cursorTest.createCursorDbReader();
  try {
    await assert.rejects(
      reader.get(path.join(dir, "missing.vscdb"), "SELECT 1;"),
      /Failed to read Cursor state\.vscdb/,
    );
  } finally {
    reader.cleanup();
  }
  const leaked = (await readdir(os.tmpdir())).filter((f) => f.startsWith("tuw-cursor-") && !before.has(f));
  assert.deepEqual(leaked, [], "no tmp copy for a non-lock failure");
});

test("Cursor reader copies a locked DB once and reads both keys from that copy", async (t) => {
  let DatabaseSync: new (file: string) => {
    exec(sql: string): void;
    close(): void;
  };
  try {
    ({ DatabaseSync } = require("node:sqlite") as { DatabaseSync: typeof DatabaseSync });
  } catch {
    t.skip("node:sqlite not available");
    return;
  }
  const dir = await makeTempDir(t);
  const dbPath = path.join(dir, "state.vscdb");
  const db = new DatabaseSync(dbPath);
  db.exec(
    "CREATE TABLE ItemTable (key TEXT, value TEXT);" +
      "INSERT INTO ItemTable VALUES ('a','tok'),('b','pro');",
  );
  db.exec("BEGIN EXCLUSIVE; UPDATE ItemTable SET value=value;");

  const isCopy = (f: string) => f.startsWith("tuw-cursor-") && f.endsWith(".vscdb");
  const before = new Set((await readdir(os.tmpdir())).filter(isCopy));
  const reader = cursorTest.createCursorDbReader();
  try {
    const [a, b] = await Promise.all([
      reader.get(dbPath, "SELECT value FROM ItemTable WHERE key='a';"),
      reader.get(dbPath, "SELECT value FROM ItemTable WHERE key='b';"),
    ]);
    assert.deepEqual([a, b], ["tok", "pro"]);
    const copies = (await readdir(os.tmpdir())).filter((f) => isCopy(f) && !before.has(f));
    assert.equal(copies.length, 1, "one copy serves both reads");
  } finally {
    reader.cleanup();
    db.exec("ROLLBACK");
    db.close();
  }
  const left = (await readdir(os.tmpdir())).filter((f) => isCopy(f) && !before.has(f));
  assert.deepEqual(left, [], "cleanup removes the copy");
});

test("Cursor token copies are created with mode 0600 on POSIX", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX mode bits only");
    return;
  }
  const homeDir = await makeTempDir(t);
  const tempDir = path.join(homeDir, "tmp");
  await mkdir(tempDir, { recursive: true });

  // Cursor: copySqliteSidecars is the function that creates the tmp db copy.
  const cursorSrc = path.join(homeDir, "state.vscdb");
  await writeFile(cursorSrc, "fixture-cursor-db");
  const cursorCopy = path.join(tempDir, "cursor-copy.vscdb");
  await copySqliteSidecars(cursorSrc, cursorCopy);
  assert.equal((await stat(cursorCopy)).mode & 0o777, 0o600);
});

test("claude mapOAuthUsage maps five_hour + seven_day", () => {
  const windows = claudeTest.mapOAuthUsage({
    five_hour: { utilization: 42, resets_at: "2026-07-19T20:00:00.000Z" },
    seven_day: { utilization: 61, resets_at: "2026-07-23T00:00:00.000Z" },
  });
  assert.equal(windows.five_hour.status, "ok");
  assert.equal(windows.five_hour.usedPercent, 42);
  assert.equal(windows.five_hour.remainingPercent, 58);
  assert.equal(windows.week.status, "ok");
  assert.equal(windows.week.usedPercent, 61);
  assert.equal(windows.month.status, "unavailable");
});

test("claude mapSpendBalance maps enterprise spend dollars", () => {
  const balance = claudeTest.mapSpendBalance({
    spend: {
      enabled: true,
      percent: 40,
      used: { amount_minor: 364, currency: "USD", exponent: 2 },
      limit: { amount_minor: 900, currency: "USD", exponent: 2 },
    },
  });
  assert.ok(balance);
  assert.equal(balance!.currency, "USD");
  assert.equal(balance!.used, 3.64);
  assert.equal(balance!.total, 9);
  assert.equal(balance!.remaining, 5.36);
  assert.match(balance!.label ?? "", /40%/);
});

test("claude usageFromBody prefers spend when windows are null", () => {
  const usage = claudeTest.usageFromBody(
    {
      five_hour: null,
      seven_day: null,
      spend: {
        enabled: true,
        percent: 40,
        used: { amount_minor: 364, currency: "USD", exponent: 2 },
        limit: { amount_minor: 900, currency: "USD", exponent: 2 },
      },
    },
    "2026-07-26T00:00:00.000Z",
  );
  assert.equal(usage.error, undefined);
  assert.equal(usage.balance?.used, 3.64);
  assert.equal(usage.windows.five_hour.status, "unavailable");
});

test("claude nextClaudeBackoffMs doubles until the cap and honors Retry-After", () => {
  assert.equal(claudeTest.nextClaudeBackoffMs(1), 60_000);
  assert.equal(claudeTest.nextClaudeBackoffMs(2), 120_000);
  assert.equal(claudeTest.nextClaudeBackoffMs(3), 240_000);
  assert.equal(claudeTest.nextClaudeBackoffMs(10), claudeTest.CLAUDE_BACKOFF_MAX_MS);
  assert.equal(claudeTest.nextClaudeBackoffMs(1, 180), 180_000);
  assert.equal(claudeTest.nextClaudeBackoffMs(3, 60), 240_000);
});

test("claude fetchClaudeUsage skips API while rate-limit backoff active", async (t) => {
  claudeTest.resetCache();
  t.after(() => claudeTest.resetCache());

  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(
      JSON.stringify({ error: { type: "rate_limit_error", message: "Rate limited." } }),
      { status: 429, headers: { "retry-after": "120" } },
    );
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const cfg = bareConfig({ claude: { accessToken: "test-token" } });
  const first = await fetchClaudeUsage(cfg);
  assert.match(first.error ?? "", /rate limited \(retry in ~2m\)/i);
  assert.equal(calls, 1);

  const second = await fetchClaudeUsage(cfg);
  assert.match(second.error ?? "", /rate limited \(retry in ~/i);
  assert.equal(calls, 1, "should not call Anthropic again during backoff");
});

test("claude usage 429s use exponential backoff after Retry-After expires", async (t) => {
  claudeTest.resetCache();
  t.after(() => claudeTest.resetCache());

  let now = 1_700_000_000_000;
  claudeTest.setNow(() => now);
  t.after(() => claudeTest.setNow(null));

  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: { type: "rate_limit_error" } }), { status: 429 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const cfg = bareConfig({ claude: { accessToken: "test-token" } });
  const first = await fetchClaudeUsage(cfg);
  assert.match(first.error ?? "", /rate limited \(retry in ~1m\)/i);
  assert.equal(calls, 1);

  now += 59_000;
  await fetchClaudeUsage(cfg);
  assert.equal(calls, 1, "still inside first backoff window");

  now += 2_000;
  const third = await fetchClaudeUsage(cfg);
  assert.match(third.error ?? "", /rate limited \(retry in ~2m\)/i);
  assert.equal(calls, 2);

  now += 119_000;
  await fetchClaudeUsage(cfg);
  assert.equal(calls, 2, "still inside doubled backoff window");
});

test("claude successful usage fetch resets exponential backoff streak", async (t) => {
  claudeTest.resetCache();
  t.after(() => claudeTest.resetCache());

  let now = 1_700_000_000_000;
  claudeTest.setNow(() => now);
  t.after(() => claudeTest.setNow(null));

  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 2) {
      return new Response(
        JSON.stringify({
          five_hour: { utilization: 10, resets_at: "2026-08-06T22:00:00.000Z" },
          seven_day: { utilization: 20, resets_at: "2026-08-13T00:00:00.000Z" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ error: { type: "rate_limit_error" } }), { status: 429 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const cfg = bareConfig({ claude: { accessToken: "test-token" } });
  await fetchClaudeUsage(cfg);
  now += 61_000;
  const ok = await fetchClaudeUsage(cfg);
  assert.equal(ok.error, undefined);
  assert.equal(ok.windows.five_hour.usedPercent, 10);

  now += 1_000;
  const held = await fetchClaudeUsage(cfg);
  assert.equal(held.windows.five_hour.usedPercent, 10, "429s keep the last good payload");
  assert.equal(calls, 3);

  now += 59_000;
  await fetchClaudeUsage(cfg);
  assert.equal(calls, 3, "reset streak uses the 1m base window, not a doubled wait");

  now += 2_000;
  await fetchClaudeUsage(cfg);
  assert.equal(calls, 4, "next attempt is allowed after the base backoff");
});

async function writeClaudeCreds(
  t: { after(fn: () => Promise<void> | void): void },
  oauth: Record<string, unknown>,
): Promise<string> {
  const home = await makeTempDir(t as { after(fn: () => Promise<void>): void });
  const credPath = path.join(home, ".claude", ".credentials.json");
  await mkdir(path.dirname(credPath), { recursive: true });
  await writeFile(credPath, JSON.stringify({ claudeAiOauth: oauth }), "utf8");
  const originalHomedir = os.homedir;
  os.homedir = () => home;
  t.after(() => {
    os.homedir = originalHomedir;
  });
  return credPath;
}

test("claude expired file token: no refresh, no write, error says run claude", async (t) => {
  claudeTest.resetCache();
  t.after(() => claudeTest.resetCache());
  const credPath = await writeClaudeCreds(t, {
    accessToken: "stale-token",
    refreshToken: "refresh-me",
    expiresAt: Date.now() - 60_000,
  });
  const before = await readFile(credPath, "utf8");
  const mtimeBefore = (await stat(credPath)).mtimeMs;

  const urls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    urls.push(String(input));
    throw new Error("no network call expected for an expired token");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const usage = await fetchClaudeUsage(bareConfig());
  assert.match(usage.error ?? "", /run `claude` to refresh it/);
  assert.deepEqual(urls, [], "must not call the token endpoint or usage API");
  assert.equal(await readFile(credPath, "utf8"), before);
  assert.equal((await stat(credPath)).mtimeMs, mtimeBefore);
  const files = await readdir(path.dirname(credPath));
  assert.deepEqual(files, [".credentials.json"], "no .tmp write-back file");
});

test("claude 401 returns the run-claude error and leaves credentials untouched", async (t) => {
  claudeTest.resetCache();
  t.after(() => claudeTest.resetCache());
  const credPath = await writeClaudeCreds(t, {
    accessToken: "revoked-token",
    refreshToken: "refresh-me",
    expiresAt: Date.now() + 3_600_000,
  });
  const before = await readFile(credPath, "utf8");

  const urls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    urls.push(String(input));
    assert.ok(init?.signal instanceof AbortSignal, "usage fetch must carry a timeout signal");
    return new Response("{}", { status: 401 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const usage = await fetchClaudeUsage(bareConfig());
  assert.match(usage.error ?? "", /run `claude` to refresh it/);
  assert.deepEqual(urls, ["https://api.anthropic.com/api/oauth/usage"]);
  assert.equal(await readFile(credPath, "utf8"), before);
});

test("claude token read error is contained (resolves with error, never rejects)", async (t) => {
  claudeTest.resetCache();
  t.after(() => claudeTest.resetCache());
  const originalHomedir = os.homedir;
  os.homedir = () => {
    throw new Error("homedir boom");
  };
  t.after(() => {
    os.homedir = originalHomedir;
  });

  const usage = await fetchClaudeUsage(bareConfig());
  assert.equal(usage.provider, "claude");
  assert.match(usage.error ?? "", /homedir boom/);
});

test("claude backoff hold keeps the cached fetchedAt", async (t) => {
  claudeTest.resetCache();
  t.after(() => claudeTest.resetCache());

  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({ five_hour: { utilization: 5 } }), { status: 200 });
    }
    return new Response("{}", { status: 429 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const cfg = bareConfig({ claude: { accessToken: "test-token" } });
  const ok = await fetchClaudeUsage(cfg);
  await new Promise((r) => setTimeout(r, 5));
  const held = await fetchClaudeUsage(cfg);
  assert.equal(held.windows.five_hour.usedPercent, 5);
  assert.equal(held.fetchedAt, ok.fetchedAt, "stale data must not look fresh");
});

test("claude tokenExpired respects skew before expiresAt", () => {
  const expiresAt = Date.now() + 30_000;
  assert.equal(claudeTest.tokenExpired(expiresAt), true);
  assert.equal(claudeTest.tokenExpired(expiresAt + 120_000), false);
});

test("poll cache serves cached provider payload within interval", async (t) => {
  pollTest.resetPollCache();
  t.after(() => pollTest.resetPollCache());

  pollTest.cache.set("claude", {
    fetchedAtMs: Date.now(),
    usage: {
      provider: "claude",
      label: "Claude",
      windows: unavailableAll("cached"),
      fetchedAt: "2026-08-06T00:00:00.000Z",
    },
  });

  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    calls += 1;
    throw new Error("should not fetch while cache is warm");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const cfg = bareConfig({
    providers: { ...DEFAULT_ENABLED, claude: true },
    ui: { ...DEFAULT_UI, pollIntervalSec: { claude: 300 } },
  });
  const out = await fetchProviderThrottled("claude", cfg);
  assert.equal(out.windows.five_hour.reason, "cached");
  assert.equal(out.fetchedAt, "2026-08-06T00:00:00.000Z", "cache hit keeps the original fetchedAt");
  assert.equal(calls, 0);
});

test("kimi mapUsages maps session + week array entries", () => {
  const windows = kimiTest.mapUsages({
    data: [
      { name: "5h session", used: 18, limit: 100, resetTime: "2026-07-19T22:00:00.000Z" },
      { name: "week", used: 55, limit: 100 },
    ],
  });
  assert.equal(windows.five_hour.status, "ok");
  assert.equal(windows.five_hour.usedPercent, 18);
  assert.equal(windows.week.status, "ok");
  assert.ok(windows.week.usedPercent !== null);
  assert.ok(Math.abs(windows.week.usedPercent! - 55) < 0.01);
});

test("zai mapQuota maps session + week limits", () => {
  const windows = zaiTest.mapQuota({
    limits: [
      { type: "session", percentage: 27, nextResetTime: 1780000000000 },
      { type: "week", percentage: 70 },
    ],
  });
  assert.equal(windows.five_hour.status, "ok");
  assert.equal(windows.five_hour.usedPercent, 27);
  assert.equal(windows.week.status, "ok");
  assert.equal(windows.week.usedPercent, 70);
});

test("zai mapQuota accepts the nested {data:{limits:[...]}} shape", () => {
  const windows = zaiTest.mapQuota({
    code: 200,
    data: { limits: [{ type: "TOKENS_LIMIT", percentage: 41 }, { type: "week", percentage: 9 }] },
  });
  assert.equal(windows.five_hour.usedPercent, 41);
  assert.equal(windows.week.usedPercent, 9);
});

test("openrouter missing key returns unavailable", async () => {
  const usage = await fetchOpenRouterUsage(bareConfig());
  assert.equal(usage.provider, "openrouter");
  assert.ok(usage.error);
  assert.equal(usage.windows.five_hour.status, "unavailable");
  assert.equal(usage.balance, undefined);
});

test("widget-compact openrouter shows $ left from balance.remaining", () => {
  const line = providerLine({
    provider: "openrouter",
    balance: { currency: "USD", remaining: 12.34 },
  });
  assert.equal(line, "openrouter: $12.34 left");
});

test("widget-compact claude shows used% windows", () => {
  const line = providerLine({
    provider: "claude",
    windows: {
      five_hour: { status: "ok", usedPercent: 42 },
      week: { status: "ok", usedPercent: 61 },
      month: { status: "unavailable", usedPercent: null },
    },
  });
  assert.equal(line, "claude: 5h 42%, Week 61%");
});

test("widget-compact claude shows dollar spend and hides NA windows", () => {
  const line = providerLine({
    provider: "claude",
    windows: {
      five_hour: { status: "unavailable", usedPercent: null },
      week: { status: "unavailable", usedPercent: null },
      month: { status: "unavailable", usedPercent: null },
    },
    balance: { currency: "USD", used: 3.64, total: 9, remaining: 5.36 },
  });
  assert.equal(line, "claude: $3.64/$9.00 (40%)");
});
