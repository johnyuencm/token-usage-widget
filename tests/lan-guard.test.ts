import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage } from "node:http";
import {
  authorizeApiRequest,
  extractRequestToken,
  generateLanToken,
  isLoopbackHost,
} from "../src/server-auth.js";
import { getPublicSettings } from "../src/settings-api.js";
import { createRequestHandler } from "../src/server.js";

const ENV_KEYS = ["TOKEN_USAGE_WIDGET_CONFIG", "TUW_LAN_TOKEN"] as const;
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
  const token = generateLanToken();
  const handler = createRequestHandler({ lanToken: token, loopbackBind: false });

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
