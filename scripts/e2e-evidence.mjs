#!/usr/bin/env node
/**
 * Full e2e evidence runner for token-usage-dashboard + Windows corner widget.
 * Writes artifacts/e2e-evidence.md with command results and exit codes.
 */
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { resolveNodeBinary, healthCheck, ensureUsageServer } = require("../desktop/server-launch.cjs");

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACTS = path.join(ROOT, "artifacts");
const EVIDENCE = path.join(ARTIFACTS, "e2e-evidence.md");
const PORT = 18767;

/**
 * Run an executable via execFileSync (no shell).
 * On Windows, never pass *.cmd/*.bat here — Node returns EINVAL.
 * Prefer `node <tool>` paths under node_modules.
 */
function run(cmd, args, opts = {}) {
  const started = Date.now();
  const { env: extraEnv, ...rest } = opts;
  try {
    const out = execFileSync(cmd, args, {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      ...rest,
    });
    return {
      ok: true,
      code: 0,
      ms: Date.now() - started,
      stdout: String(out).trim(),
      stderr: "",
    };
  } catch (err) {
    return {
      ok: false,
      code: err.status ?? 1,
      ms: Date.now() - started,
      stdout: String(err.stdout || "").trim(),
      stderr: String(err.stderr || err.message || "").trim(),
    };
  }
}

function nodeBin() {
  return resolveNodeBinary(process.env) || process.execPath;
}

export function evidenceTarget(endpoint) {
  return {
    host: endpoint.host,
    port: endpoint.port,
    healthUrl: `${endpoint.baseUrl}/api/health`,
    usageUrl: `${endpoint.baseUrl}/api/usage`,
    widgetUrl: `${endpoint.baseUrl}/widget.html`,
  };
}

export function evidenceElectronEnv(endpoint, baseEnv = process.env) {
  return {
    ...baseEnv,
    USAGE_HOST: endpoint.host,
    PORT: String(endpoint.port),
  };
}

export function resolveInstalledElectron(options = {}) {
  const root = options.root || ROOT;
  const platform = options.platform || process.platform;
  const existsSync = options.existsSync || fs.existsSync;
  const loadElectron = options.loadElectron || (() => require("electron"));
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  let packageError = null;

  try {
    const installedPath = loadElectron();
    if (typeof installedPath === "string" && existsSync(installedPath)) return installedPath;
  } catch (err) {
    packageError = err;
  }

  const relativePath =
    platform === "win32"
      ? pathApi.join("dist", "electron.exe")
      : platform === "darwin"
        ? pathApi.join("dist", "Electron.app", "Contents", "MacOS", "Electron")
        : pathApi.join("dist", "electron");
  const fallbackPath = pathApi.join(root, "node_modules", "electron", relativePath);
  if (existsSync(fallbackPath)) return fallbackPath;

  const detail = packageError instanceof Error ? ` (${packageError.message})` : "";
  throw new Error(`Electron executable is not installed for ${platform}: ${fallbackPath}${detail}`);
}

function section(lines, title) {
  lines.push("", `## ${title}`, "");
}

async function main() {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const lines = [];
  const failures = [];
  lines.push("# Token Usage Dashboard — E2E Evidence");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Root: \`${ROOT}\``);
  lines.push(`Node: \`${resolveNodeBinary(process.env)}\``);

  const node = nodeBin();
  const tscJs = path.join(ROOT, "node_modules", "typescript", "bin", "tsc");
  const testArgs = [
    "--import",
    "tsx",
    "--test",
    "tests/usage.test.ts",
    "tests/e2e-smoke.test.ts",
    "tests/server-launch.test.cjs",
    "tests/format-reset.test.cjs",
    "tests/widget-compact.test.cjs",
  ];

  section(lines, "1. Typecheck");
  {
    const r = run(node, [tscJs, "--noEmit"]);
    lines.push(`- command: \`node node_modules/typescript/bin/tsc --noEmit\``);
    lines.push(`- exit: **${r.code}** (${r.ms}ms)`);
    if (!r.ok) {
      failures.push("typecheck");
      lines.push("```");
      lines.push(r.stderr || r.stdout);
      lines.push("```");
    } else {
      lines.push("- result: PASS");
    }
  }

  section(lines, "2. Unit tests (`npm test`)");
  {
    const r = run(node, testArgs, { env: { USAGE_FIXTURE: "1", USAGE_FIXTURE_ALL: "1" } });
    lines.push(`- command: \`node --import tsx --test tests/*.test.{ts,cjs}\``);
    lines.push(`- exit: **${r.code}** (${r.ms}ms)`);
    const passLine = (r.stdout + "\n" + r.stderr).split(/\r?\n/).find((l) => /tests \d+/.test(l) || /pass \d+/.test(l));
    if (passLine) lines.push(`- summary: \`${passLine.trim()}\``);
    // Capture last 40 lines
    const tail = (r.stdout || r.stderr).split(/\r?\n/).slice(-40).join("\n");
    lines.push("```");
    lines.push(tail);
    lines.push("```");
    if (!r.ok) failures.push("unit-tests");
    else lines.push("- result: PASS");
  }

  section(lines, "3. Server-launch + e2e HTTP smoke (included in npm test above)");
  lines.push("- covered by `tests/server-launch.test.cjs` and `tests/e2e-smoke.test.ts` in section 2.");
  lines.push("- additional isolated checks below.");

  section(lines, "4. Detached widget launch (server spawn via Node, not Electron)");
  let widgetProc = null;
  let serverHandle = null;
  try {
    // Ensure port free for isolated evidence run
    if (await healthCheck("127.0.0.1", PORT, 400)) {
      lines.push(`- note: port ${PORT} already healthy before widget spawn (unexpected for isolated run)`);
    }

    // Simulate what the widget does: ensureUsageServer on a dedicated port, then hit widget.html
    serverHandle = await ensureUsageServer({
      host: "127.0.0.1",
      port: PORT,
      env: { ...process.env, USAGE_FIXTURE: "1", USAGE_FIXTURE_ALL: "1", PORT: String(PORT), NODE_BINARY: resolveNodeBinary(process.env) },
    });
    lines.push(`- ensureUsageServer nodeBin: \`${serverHandle.nodeBin}\``);
    lines.push(`- reused existing: **${serverHandle.reused}**`);
    lines.push(`- runtime endpoint: \`${serverHandle.endpoint.baseUrl}\``);
    assertNotElectron(serverHandle.nodeBin);
    const target = evidenceTarget(serverHandle.endpoint);

    const health = await (await fetch(target.healthUrl)).json();
    const usage = await (await fetch(target.usageUrl)).json();
    const widget = await fetch(target.widgetUrl);
    lines.push(`- health.status: **${health.status}**, fixture: **${health.fixture}**`);
    lines.push(`- usage.providers: **${usage.providers.map((p) => p.provider).join(", ")}**`);
    lines.push(`- widget.html HTTP: **${widget.status}**`);

    // Launch Electron against this already-running server (widget will reuse health)
    const electron = resolveInstalledElectron();
    lines.push(`- electron executable: \`${electron}\``);
    // Isolate userData so a live product widget's single-instance lock cannot kill this check.
    const evidenceUserData = fs.mkdtempSync(path.join(os.tmpdir(), "tuw-e2e-"));
    lines.push(`- electron userData: \`${evidenceUserData}\``);
    // Electron main strips USAGE_FIXTURE unless argv includes --fixture (product path stays live).
    widgetProc = spawn(electron, [`--user-data-dir=${evidenceUserData}`, ROOT, "--fixture"], {
      cwd: ROOT,
      env: {
        ...evidenceElectronEnv(serverHandle.endpoint),
        USAGE_FIXTURE: "1",
        USAGE_FIXTURE_ALL: "1",
        NODE_BINARY: resolveNodeBinary(process.env),
      },
      stdio: "ignore",
      windowsHide: false,
      detached: true,
    });
    widgetProc.unref();
    await new Promise((r) => setTimeout(r, 8000));

    const stillHealthy = await healthCheck(target.host, target.port);
    // On Windows detached Electron may report exitCode early for the launcher; treat pid alive as success.
    let electronAlive = widgetProc.exitCode === null && !widgetProc.killed;
    if (!electronAlive && widgetProc.pid) {
      try {
        process.kill(widgetProc.pid, 0);
        electronAlive = true;
      } catch {
        electronAlive = false;
      }
    }
    lines.push(`- electron pid: **${widgetProc.pid}**`);
    lines.push(`- electron still running after 8s: **${electronAlive}**`);
    lines.push(`- API still healthy under widget: **${stillHealthy}**`);

    if (!stillHealthy || !electronAlive) {
      failures.push("widget-launch");
      lines.push("- result: FAIL");
    } else {
      lines.push("- result: PASS");
    }
  } catch (err) {
    failures.push("widget-launch");
    lines.push(`- result: FAIL`);
    lines.push(`- error: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    try {
      if (widgetProc && widgetProc.pid) {
        try {
          process.kill(widgetProc.pid);
        } catch {
          // Windows may need taskkill for process tree
          try {
            execFileSync("taskkill", ["/PID", String(widgetProc.pid), "/T", "/F"], { stdio: "ignore" });
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // ignore
    }
    try {
      if (serverHandle?.proc && !serverHandle.proc.killed) serverHandle.proc.kill();
    } catch {
      // ignore
    }
  }

  section(lines, "Verdict");
  if (failures.length === 0) {
    lines.push("**PASS** — typecheck, unit tests, e2e smoke, and detached widget launch all succeeded.");
  } else {
    lines.push(`**FAIL** — failed stages: ${failures.join(", ")}`);
  }

  fs.writeFileSync(EVIDENCE, lines.join("\n") + "\n", "utf8");
  console.log(EVIDENCE);
  console.log(failures.length === 0 ? "E2E PASS" : `E2E FAIL: ${failures.join(", ")}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

function assertNotElectron(bin) {
  if (!bin) return;
  const base = path.basename(bin).toLowerCase();
  if (base === "electron.exe" || base === "electron") {
    throw new Error(`nodeBin unexpectedly electron: ${bin}`);
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
