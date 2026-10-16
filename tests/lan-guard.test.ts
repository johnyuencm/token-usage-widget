import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http, { type IncomingMessage } from "node:http";
import net from "node:net";
import {
  authorizeApiRequest,
  extractRequestToken,
  generateLanToken,
  isLoopbackHost,
} from "../src/server-auth.js";
import { getPublicSettings } from "../src/settings-api.js";
import { createRequestHandler } from "../src/server.js";
import { __test as pollTest } from "../src/providers/poll-cache.js";
import { unavailableAll } from "../src/types.js";

const ENV_KEYS = ["TOKEN_USAGE_WIDGET_CONFIG", "TUW_LAN_TOKEN", "USAGE_FIXTURE", "USAGE_FIXTURE_ALL"] as const;
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

function fakeRequest(
  headers: Record<string, string>,
  remoteAddress: string,
  url = "/api/usage",
  method = "GET",
): IncomingMessage {
  return { headers, url, method, socket: { remoteAddress } } as unknown as IncomingMessage;
}

test("isLoopbackHost covers localhost, IPv6 loopback, and 127/8 only", () => {
  for (const h of ["127.0.0.1", "127.1.2.3", "localhost", "LOCALHOST", "::1", "[::1]"]) {
    assert.equal(isLoopbackHost(h), true, h);
  }
  for (const h of ["0.0.0.0", "192.168.1.10", "10.0.0.5", "::", "example.com", "128.0.0.1"]) {
    assert.equal(isLoopbackHost(h), false, h);
  }
});

test("generateLanToken is long, hex, and unique per call", () => {
  const a = generateLanToken();
  const b = generateLanToken();
  assert.equal(a.length, 64);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, b);
});

test("extractRequestToken reads Bearer and X-TUW-Token", () => {
  assert.equal(extractRequestToken(fakeRequest({ authorization: "Bearer abc" }, "10.0.0.2")), "abc");
  assert.equal(extractRequestToken(fakeRequest({ "x-tuw-token": "xyz" }, "10.0.0.2")), "xyz");
  assert.equal(extractRequestToken(fakeRequest({}, "10.0.0.2")), null);
});

test("loopback bind (no token) authorizes every request", () => {
  assert.equal(authorizeApiRequest(fakeRequest({}, "10.0.0.9"), null), true);
});

test("LAN bind requires the token from non-loopback sources", () => {
  const token = generateLanToken();
  const lan = fakeRequest({ authorization: `Bearer ${token}` }, "192.168.1.50");
  assert.equal(authorizeApiRequest(lan, token), true);

  assert.equal(authorizeApiRequest(fakeRequest({}, "192.168.1.50"), token), false);
  assert.equal(
    authorizeApiRequest(fakeRequest({ authorization: "Bearer wrong" }, "192.168.1.50"), token),
    false,
  );
  // Same token length but different bytes must not pass.
  assert.equal(
    authorizeApiRequest(fakeRequest({ "x-tuw-token": "0".repeat(64) }, "192.168.1.50"), token),
    false,
  );
});

test("LAN bind keeps loopback callers (the local widget) working without a token", () => {
  const token = generateLanToken();
  assert.equal(authorizeApiRequest(fakeRequest({}, "127.0.0.1"), token), true);
  assert.equal(authorizeApiRequest(fakeRequest({}, "::1"), token), true);
  assert.equal(authorizeApiRequest(fakeRequest({}, "::ffff:127.0.0.1"), token), true);
});

test("handler returns 401 for a tokenless LAN request and 200 for loopback", async () => {
  tempConfigFile({}); // never read or write the real user-data config
  const token = generateLanToken();
  const handler = createRequestHandler({ lanToken: token, loopbackBind: false, bindHost: "0.0.0.0" });

  const run = async (req: IncomingMessage) => {
    let status = 0;
    let body = "";
    const res = {
      writeHead(s: number) {
        status = s;
        return this;
      },
      end(chunk?: string) {
        body = chunk ?? "";
      },
    } as unknown as import("node:http").ServerResponse;
    await handler(req, res);
    return { status, body };
  };

  const denied = await run(fakeRequest({ host: "192.168.1.50:4321" }, "192.168.1.50"));
  assert.equal(denied.status, 401);

  const allowed = await run(fakeRequest({ host: "127.0.0.1:4321" }, "127.0.0.1"));
  assert.equal(allowed.status, 200);
  assert.equal("configPath" in JSON.parse(allowed.body), false);
});

test("resolveServerAuth generates and persists a token only for a non-loopback host", async () => {
  stashEnv();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tuw-lan-"));
  tempDirs.push(dir);
  const cfgPath = path.join(dir, "config.json");
  process.env.TOKEN_USAGE_WIDGET_CONFIG = cfgPath;
  delete process.env.TUW_LAN_TOKEN;

  const { loadConfig, resolveServerAuth } = await import("../src/config.js");

  const loopback = await loadConfig();
  loopback.server.host = "127.0.0.1";
  assert.equal(await resolveServerAuth(loopback), null);
  assert.equal(fs.existsSync(cfgPath), false, "loopback bind must not write a token");

  const lan = await loadConfig();
  lan.server.host = "0.0.0.0";
  const token = await resolveServerAuth(lan);
  assert.ok(token && token.length === 64);
  const onDisk = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as {
    server?: { lanToken?: string };
  };
  assert.equal(onDisk.server?.lanToken, token);

  // Second load reads the persisted token back, so it survives a restart.
  const reloaded = await loadConfig();
  assert.equal(reloaded.server.lanToken, token);
});

test("getPublicSettings omits configPath when asked (non-loopback bind)", async () => {
  stashEnv();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tuw-lan-"));
  tempDirs.push(dir);
  process.env.TOKEN_USAGE_WIDGET_CONFIG = path.join(dir, "config.json");
  delete process.env.TUW_LAN_TOKEN;

  const withPath = await getPublicSettings();
  assert.equal(typeof withPath.configPath, "string");
  assert.ok(withPath.configPath);

  const withoutPath = await getPublicSettings({ includeConfigPath: false });
  assert.equal("configPath" in withoutPath, false);
  assert.deepEqual(withoutPath.providers, withPath.providers);
  assert.deepEqual(withoutPath.ui, withPath.ui);
});

/** Send one raw HTTP request, so bad paths and Host values reach the server unchanged. */
function rawRequest(port: number, requestLine: string, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1", () => {
      sock.write(`${requestLine} HTTP/1.0\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
    });
    let raw = "";
    sock.on("data", (d) => (raw += d.toString("utf8")));
    sock.on("end", () => {
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(raw)?.[1] ?? 0);
      resolve({ status, body: raw.slice(raw.indexOf("\r\n\r\n") + 4) });
    });
    sock.on("error", reject);
  });
}

async function startServer(
  t: { after(fn: () => void): void },
  ctx: Parameters<typeof createRequestHandler>[0] = { lanToken: null, loopbackBind: true },
): Promise<number> {
  const server = http.createServer(createRequestHandler(ctx));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  return (server.address() as net.AddressInfo).port;
}

test("malformed URL or Host returns 400 and the server keeps serving", async (t) => {
  const port = await startServer(t);
  const rejections: unknown[] = [];
  const onRejection = (e: unknown) => rejections.push(e);
  process.on("unhandledRejection", onRejection);
  t.after(() => process.off("unhandledRejection", onRejection));

  const badPath = await rawRequest(port, "GET /%E0%A4%A", "127.0.0.1");
  assert.equal(badPath.status, 400);
  assert.ok(JSON.parse(badPath.body).error);

  const badHost = await rawRequest(port, "GET /api/health", "a b");
  assert.equal(badHost.status, 400);

  const health = await rawRequest(port, "GET /api/health", `127.0.0.1:${port}`);
  assert.equal(health.status, 200, "server must survive malformed requests");
  assert.deepEqual(rejections, []);
});

test("health reports app name and pid next to the old fields", async (t) => {
  const port = await startServer(t);
  const res = await rawRequest(port, "GET /api/health", `localhost:${port}`);
  const body = JSON.parse(res.body);
  assert.equal(body.status, "ok");
  assert.equal(body.app, "token-usage-widget");
  assert.equal(body.pid, process.pid);
  assert.equal(typeof body.fixture, "boolean");
  assert.equal(typeof body.time, "string");
});

test("Host header must be loopback or the bind host (DNS rebinding guard)", async (t) => {
  const port = await startServer(t);
  for (const host of ["evil.example", `evil.example:${port}`, "192.168.1.50:4321"]) {
    const res = await rawRequest(port, "GET /api/usage", host);
    assert.equal(res.status, 403, host);
  }
  for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]) {
    const res = await rawRequest(port, "GET /api/health", host);
    assert.equal(res.status, 200, host);
  }

  // LAN bind: the bind host passes the Host check; the token check still applies.
  const lanPort = await startServer(t, {
    lanToken: null,
    loopbackBind: false,
    bindHost: "192.168.1.50",
  });
  assert.equal((await rawRequest(lanPort, "GET /api/health", "192.168.1.50:4321")).status, 200);
  assert.equal((await rawRequest(lanPort, "GET /api/health", "evil.example")).status, 403);
});

test("bad config JSON gives a JSON error on settings and usage, not a crash", async (t) => {
  stashEnv();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tuw-lan-"));
  tempDirs.push(dir);
  const cfgPath = path.join(dir, "config.json");
  fs.writeFileSync(cfgPath, "{ not json");
  process.env.TOKEN_USAGE_WIDGET_CONFIG = cfgPath;

  const port = await startServer(t);
  const put = await rawRequest(port, "PUT /api/settings", "127.0.0.1");
  assert.ok(put.status >= 400 && put.status < 600, String(put.status));
  assert.ok(JSON.parse(put.body).error);
  // B4: the parse error shows, not an empty "No providers" list.
  for (const route of ["GET /api/usage", "GET /api/settings"]) {
    const res = await rawRequest(port, route, "127.0.0.1");
    assert.equal(res.status, 500, route);
    assert.match(JSON.parse(res.body).error, /not valid JSON/, route);
  }
  assert.equal(fs.readFileSync(cfgPath, "utf8"), "{ not json");
  assert.equal((await rawRequest(port, "GET /api/health", "127.0.0.1")).status, 200);
});

function tempConfigFile(body: unknown): void {
  stashEnv();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tuw-lan-"));
  tempDirs.push(dir);
  const cfgPath = path.join(dir, "config.json");
  fs.writeFileSync(cfgPath, JSON.stringify(body));
  process.env.TOKEN_USAGE_WIDGET_CONFIG = cfgPath;
}

test("usage fetchedAt is the oldest provider fetchedAt, not the response time (B1)", async (t) => {
  tempConfigFile({ providers: { openrouter: true } });
  delete process.env.USAGE_FIXTURE;
  pollTest.resetPollCache();
  t.after(() => pollTest.resetPollCache());
  pollTest.cache.set("openrouter", {
    fetchedAtMs: Date.now(),
    usage: { provider: "openrouter", label: "OpenRouter", windows: unavailableAll("cached"), fetchedAt: "2026-08-06T00:00:00.000Z" },
  });
  const port = await startServer(t);
  const usage = JSON.parse((await rawRequest(port, "GET /api/usage", "127.0.0.1")).body);
  assert.equal(usage.fetchedAt, "2026-08-06T00:00:00.000Z", "cached data must not show as fresh");
});

test("fixture usage carries the ui settings (B9)", async (t) => {
  tempConfigFile({ ui: { refreshIntervalSec: 120 } });
  process.env.USAGE_FIXTURE = "1";
  const port = await startServer(t);
  const usage = JSON.parse((await rawRequest(port, "GET /api/usage", "127.0.0.1")).body);
  assert.equal(usage.fixture, true);
  assert.equal(usage.ui?.refreshIntervalSec, 120);
});
