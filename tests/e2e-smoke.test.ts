import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { resolveNodeBinary, healthCheck } = require("../desktop/server-launch.cjs");

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 18766;

async function waitForHealth(port: number, attempts = 60): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (await healthCheck("127.0.0.1", port, 500)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Server on ${port} did not become healthy`);
}

test("e2e fixture: dashboard + widget assets + usage shape", async () => {
  const nodeBin = resolveNodeBinary(process.env);
  const tsxCli = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const entry = path.join(ROOT, "src", "server.ts");
  const proc = spawn(nodeBin, [tsxCli, entry], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), USAGE_FIXTURE: "1", USAGE_FIXTURE_ALL: "1" },
    stdio: "ignore",
    windowsHide: true,
  });

  try {
    await waitForHealth(PORT);

    const health = await fetch(`http://127.0.0.1:${PORT}/api/health`);
    assert.equal(health.status, 200);
    const healthJson = await health.json();
    assert.equal(healthJson.status, "ok");
    assert.equal(healthJson.fixture, true);

    for (const asset of [
      "/widget.html",
      "/widget.css",
      "/widget.js",
      "/widget-compact.js",
      "/fmt.js",
      "/",
      "/app.js",
      "/styles.css",
    ]) {
      const res = await fetch(`http://127.0.0.1:${PORT}${asset}`);
      assert.equal(res.status, 200, `${asset} should be 200`);
    }

    const usageRes = await fetch(`http://127.0.0.1:${PORT}/api/usage`);
    assert.equal(usageRes.status, 200);
    const usage = await usageRes.json();
    assert.equal(usage.fixture, true);
    assert.equal(usage.providers.length, 7);

    const openai = usage.providers.find((p: { provider: string }) => p.provider === "openai");
    const cursor = usage.providers.find((p: { provider: string }) => p.provider === "cursor");
    const openrouter = usage.providers.find((p: { provider: string }) => p.provider === "openrouter");
    assert.ok(openai && cursor && openrouter);
    assert.ok(openrouter.balance);
    assert.equal(openrouter.balance.remaining, 12.34);

    // Cursor billing breakdown
    assert.ok(cursor.billing);
    assert.equal(cursor.billing.planLabel, "Included in Pro+");
    assert.equal(cursor.billing.totalPercentUsed, 23);
    assert.equal(cursor.billing.autoPercentUsed, 13);
    assert.equal(cursor.billing.apiPercentUsed, 99);

    // Widget page references its assets + compact renderer
    const widgetHtml = await (await fetch(`http://127.0.0.1:${PORT}/widget.html`)).text();
    assert.match(widgetHtml, /widget\.css/);
    assert.match(widgetHtml, /widget\.js/);
    assert.match(widgetHtml, /widget-compact\.js/);
    assert.match(widgetHtml, /Token Usage/);

    const widgetJs = await (await fetch(`http://127.0.0.1:${PORT}/widget.js`)).text();
    assert.match(widgetJs, /providerLine/);
    assert.doesNotMatch(widgetJs, /meter-fill/);

    // Fixture windows expose resetsAtIso for dashboard / tooltips
    assert.ok(openai.windows.week.resetsAtIso);
    assert.ok(cursor.billing.resetsAtIso);
  } finally {
    proc.kill();
  }
});
