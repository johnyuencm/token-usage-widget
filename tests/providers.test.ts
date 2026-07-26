import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { __test as claudeTest } from "../src/adapters/claude.js";
import {
  fetchCursorUsage,
  readCursorAccessToken,
  resolveCursorStateDbPath,
} from "../src/adapters/cursor.js";
import { __test as kimiTest } from "../src/adapters/kimi.js";
import {
  fetchOpenCodeUsage,
  readFirefoxAuthCookie,
  resolveAuthCookie,
  resolveFirefoxProfilesRoot,
} from "../src/adapters/opencode.js";
import { __test as zaiTest } from "../src/adapters/zai.js";
import { fetchOpenRouterUsage } from "../src/adapters/openrouter.js";
import type { Config } from "../src/config.js";
import { DEFAULT_ENABLED } from "../src/config.js";

const require = createRequire(import.meta.url);
const { providerLine } = require("../public/widget-compact.js");

function bareConfig(overrides: Partial<Config> = {}): Config {
  return {
    providers: { ...DEFAULT_ENABLED },
    opencode: {
      dbPath: "",
      caps: { five_hour: null, week: null, month: null },
      go: { workspaceId: null, authCookie: null },
    },
    openrouter: { apiKey: null },
    kimi: { apiKey: null },
    zai: { apiKey: null },
    grok: { oauthToken: null },
    claude: { accessToken: null },
    server: { port: 4321, host: "127.0.0.1" },
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

test("OpenCode reads auth from a standard macOS Firefox profile", async (t) => {
  const homeDir = await makeTempDir(t);
  const profilesRoot = path.join(homeDir, "Library", "Application Support", "Firefox", "Profiles");
  const cookieDb = path.join(profilesRoot, "fixture.default-release", "cookies.sqlite");
  const tempDir = path.join(homeDir, "tmp");
  await mkdir(path.dirname(cookieDb), { recursive: true });
  await mkdir(tempDir, { recursive: true });
  await writeFile(cookieDb, "fixture-opencode-cookie");

  const sqlitePaths: string[] = [];
  const cookie = await resolveAuthCookie(bareConfig(), {
    platform: "darwin",
    homeDir,
    env: {},
    tempDir,
    sqliteGet: async (copiedDb) => {
      sqlitePaths.push(copiedDb);
      return readFile(copiedDb, "utf8");
    },
  });

  assert.equal(cookie, "fixture-opencode-cookie");
  assert.equal(sqlitePaths.length, 1);
  assert.ok(sqlitePaths[0].startsWith(tempDir));
});

test("OpenCode uses a standard Win32 Firefox profile through the provider seam", async (t) => {
  const homeDir = await makeTempDir(t);
  const profilesRoot = path.join(homeDir, "AppData", "Roaming", "Mozilla", "Firefox", "Profiles");
  const cookieDb = path.join(profilesRoot, "fixture.default-release", "cookies.sqlite");
  const tempDir = path.join(homeDir, "tmp");
  await mkdir(path.dirname(cookieDb), { recursive: true });
  await mkdir(tempDir, { recursive: true });
  await writeFile(cookieDb, "fixture-win32-cookie");

  const usage = await fetchOpenCodeUsage(
    bareConfig({
      opencode: {
        dbPath: "",
        caps: { five_hour: null, week: null, month: null },
        go: { workspaceId: "wrk_FIXTURE", authCookie: null },
      },
    }),
    {
      platform: "win32",
      homeDir,
      env: {},
      tempDir,
      sqliteGet: async (copiedDb) => readFile(copiedDb, "utf8"),
      fetchImpl: async (input, init) => {
        assert.match(String(input), /\/workspace\/wrk_FIXTURE\/go$/);
        assert.equal(new Headers(init?.headers).get("Cookie"), "auth=fixture-win32-cookie");
        return new Response(
          "rollingUsage:$R[0]={usagePercent:24,resetInSec:3600} " +
            "weeklyUsage:$R[1]={usagePercent:40,resetInSec:7200} " +
            "monthlyUsage:$R[2]={usagePercent:60,resetInSec:10800}",
          { status: 200, headers: { "content-type": "text/html" } },
        );
      },
    },
  );

  assert.equal(usage.windows.five_hour.status, "ok");
  assert.equal(usage.windows.five_hour.usedPercent, 24);
  assert.equal(usage.windows.week.usedPercent, 40);
  assert.equal(usage.windows.month.usedPercent, 60);
});

test("OpenCode still reads Firefox cookies when the optional WAL cannot be copied", async () => {
  const profilesRoot = path.join("fixture", "Profiles");
  const dbPath = path.join(profilesRoot, "default-release", "cookies.sqlite");
  const cookie = await readFirefoxAuthCookie({
    profilesRoot,
    tempDir: "fixture-temp",
    firefoxFs: {
      exists: (filePath) =>
        filePath === profilesRoot || filePath === dbPath || filePath === `${dbPath}-wal`,
      list: async () => ["default-release"],
      copy: async (sourcePath) => {
        if (sourcePath.endsWith("-wal")) throw new Error("Firefox WAL is locked");
      },
      remove: async () => {},
    },
    sqliteGet: async () => "cookie-without-wal-copy",
  });

  assert.equal(cookie, "cookie-without-wal-copy");
});

test("OpenCode removes Firefox temporary DB, WAL, and SHM companions", async (t) => {
  const homeDir = await makeTempDir(t);
  const profilesRoot = path.join(homeDir, "Library", "Application Support", "Firefox", "Profiles");
  const cookieDb = path.join(profilesRoot, "fixture.default-release", "cookies.sqlite");
  const tempDir = path.join(homeDir, "tmp");
  await mkdir(path.dirname(cookieDb), { recursive: true });
  await mkdir(tempDir, { recursive: true });
  await writeFile(cookieDb, "fixture-cleanup-cookie");

  const cookie = await readFirefoxAuthCookie({
    profilesRoot,
    tempDir,
    sqliteGet: async (copiedDb) => {
      await writeFile(`${copiedDb}-wal`, "sqlite-wal");
      await writeFile(`${copiedDb}-shm`, "sqlite-shm");
      return "fixture-cleanup-cookie";
    },
  });

  assert.equal(cookie, "fixture-cleanup-cookie");
  assert.deepEqual(await readdir(tempDir), []);
});

test("OpenCode surfaces cleanup failures without hiding a discovered cookie", async () => {
  const profilesRoot = path.join("fixture", "Profiles");
  const dbPath = path.join(profilesRoot, "default-release", "cookies.sqlite");
  const temporaryFiles = new Set<string>();
  const cleanupErrors: Error[] = [];

  const cookie = await readFirefoxAuthCookie({
    profilesRoot,
    tempDir: "fixture-temp",
    firefoxFs: {
      exists: (filePath) =>
        filePath === profilesRoot || filePath === dbPath || temporaryFiles.has(filePath),
      list: async () => ["default-release"],
      copy: async (_sourcePath, destinationPath) => {
        temporaryFiles.add(destinationPath);
      },
      remove: async (filePath) => {
        if (filePath.endsWith("-shm")) throw new Error("fixture remove failure");
        temporaryFiles.delete(filePath);
      },
    },
    sqliteGet: async (copiedDb) => {
      temporaryFiles.add(`${copiedDb}-wal`);
      temporaryFiles.add(`${copiedDb}-shm`);
      return "cookie-despite-cleanup-failure";
    },
    onCleanupError: (error) => cleanupErrors.push(error),
  });

  assert.equal(cookie, "cookie-despite-cleanup-failure");
  assert.equal(cleanupErrors.length, 1);
  assert.match(cleanupErrors[0].message, /Firefox credential temporary file cleanup failed/);
  assert.equal(temporaryFiles.size, 1);
});

test("OpenCode explicit cookies stay ahead of Firefox discovery", async (t) => {
  const homeDir = await makeTempDir(t);
  const cookieFile = path.join(homeDir, "explicit-cookie.txt");
  await writeFile(cookieFile, "cookie-from-file\n");
  const noFirefox = async () => {
    throw new Error("Firefox discovery should not run");
  };

  assert.equal(
    await resolveAuthCookie(
      bareConfig({
        opencode: {
          dbPath: "",
          caps: { five_hour: null, week: null, month: null },
          go: { workspaceId: null, authCookie: "cookie-from-config" },
        },
      }),
      {
        platform: "darwin",
        homeDir,
        env: { OPENCODE_GO_AUTH_COOKIE: "cookie-from-env" },
        sqliteGet: noFirefox,
      },
    ),
    "cookie-from-config",
  );
  assert.equal(
    await resolveAuthCookie(bareConfig(), {
      platform: "win32",
      homeDir,
      env: {
        OPENCODE_GO_AUTH_COOKIE: "cookie-from-env",
        OPENCODE_GO_AUTH_COOKIE_FILE: cookieFile,
      },
      sqliteGet: noFirefox,
    }),
    "cookie-from-env",
  );
  assert.equal(
    await resolveAuthCookie(bareConfig(), {
      platform: "darwin",
      homeDir,
      env: { OPENCODE_GO_AUTH_COOKIE_FILE: cookieFile },
      sqliteGet: noFirefox,
    }),
    "cookie-from-file",
  );
});

test("Firefox profile roots preserve Darwin and Win32 defaults", () => {
  assert.equal(
    resolveFirefoxProfilesRoot({ platform: "darwin", homeDir: "/Users/example" }),
    path.join("/Users/example", "Library", "Application Support", "Firefox", "Profiles"),
  );
  assert.equal(
    resolveFirefoxProfilesRoot({ platform: "win32", homeDir: "C:\\Users\\example" }),
    path.join("C:\\Users\\example", "AppData", "Roaming", "Mozilla", "Firefox", "Profiles"),
  );
});

test("OpenCode keeps unavailable honest and local estimates opt-in", async (t) => {
  const homeDir = await makeTempDir(t);
  const config = bareConfig({
    opencode: {
      dbPath: path.join(homeDir, "missing-opencode.db"),
      caps: { five_hour: null, week: null, month: null },
      go: { workspaceId: null, authCookie: null },
    },
  });

  const unavailable = await fetchOpenCodeUsage(config, {
    platform: "darwin",
    homeDir,
    env: {},
  });
  assert.equal(unavailable.windows.five_hour.status, "unavailable");
  assert.match(unavailable.error ?? "", /Set workspace id and browser auth cookie/);
  assert.doesNotMatch(unavailable.error ?? "", /local DB estimate/i);

  const optedIn = await fetchOpenCodeUsage(config, {
    platform: "darwin",
    homeDir,
    env: { OPENCODE_ALLOW_LOCAL_ESTIMATE: "1" },
  });
  assert.equal(optedIn.windows.five_hour.status, "unavailable");
  assert.match(optedIn.error ?? "", /OpenCode database not found/);
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
