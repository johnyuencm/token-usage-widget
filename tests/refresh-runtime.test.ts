import { test } from "node:test";
import assert from "node:assert/strict";
import { freePortWin32, refreshRuntime } from "../src/cli/refresh-runtime.js";

const healthResponse = (body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

test("freePortWin32 kills the pid from our own health body", async () => {
  const kills: string[][] = [];
  const freed = await freePortWin32(4321, "127.0.0.1", () => {}, {
    fetchImpl: healthResponse({ status: "ok", app: "token-usage-widget", pid: 4242 }),
    exec: (cmd, args) => kills.push([cmd, ...args]),
  });
  assert.equal(freed, true);
  assert.deepEqual(kills, [["taskkill", "/PID", "4242", "/T", "/F"]]);
});

test("freePortWin32 leaves another app on the port alone and reports it", async () => {
  const kills: string[][] = [];
  const logs: string[] = [];
  const freed = await freePortWin32(4321, "127.0.0.1", (m) => logs.push(m), {
    fetchImpl: healthResponse({ status: "ok", pid: 999 }),
    exec: (cmd, args) => kills.push([cmd, ...args]),
  });
  assert.equal(freed, false);
  assert.deepEqual(kills, []);
  assert.match(logs.join("\n"), /Port 4321 is used by another app; not stopping it/);
});

test("freePortWin32 does nothing when no server answers", async () => {
  const kills: string[][] = [];
  const freed = await freePortWin32(4321, "127.0.0.1", () => {}, {
    fetchImpl: (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch,
    exec: (cmd, args) => kills.push([cmd, ...args]),
  });
  assert.equal(freed, false);
  assert.deepEqual(kills, []);
});

test("refreshRuntime awaits freePort with the configured host and port before relaunch", async () => {
  const calls: string[] = [];
  await refreshRuntime({
    platform: "win32",
    loadConfig: () => ({ server: { host: "127.0.0.1", port: 5555 } }),
    freePort: async (port, host) => {
      await new Promise((r) => setImmediate(r));
      calls.push(`free ${host}:${port}`);
    },
    launchWidget: async () => {
      calls.push("launch");
    },
    log: () => {},
  });
  assert.deepEqual(calls, ["free 127.0.0.1:5555", "launch"]);
});
