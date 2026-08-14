"use strict";

/**
 * Shared usage-server launch helpers for the Electron widget.
 * Kept free of Electron imports so Node tests can require this file.
 */

const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4321;
const SERVER_LOG = path.join(os.tmpdir(), "token-usage-dashboard-server.log");

function buildEndpoint(host, port) {
  const normalizedHost = String(host);
  const normalizedPort = Number(port);
  return {
    host: normalizedHost,
    port: normalizedPort,
    baseUrl: `http://${normalizedHost}:${normalizedPort}`,
  };
}

function allocateFreeLoopbackPort(host = DEFAULT_HOST, network = net) {
  return new Promise((resolve, reject) => {
    const server = network.createServer();
    const onError = (err) => reject(err);
    server.once("error", onError);
    server.unref();
    server.listen(0, host, () => {
      server.removeListener("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error(`Unable to allocate a free loopback port on ${host}`));
        return;
      }
      server.close((err) => {
        if (err) reject(err);
        else resolve(address.port);
      });
    });
  });
}

function isLoopbackPortAvailable(host, port, network = net) {
  return new Promise((resolve, reject) => {
    const server = network.createServer();
    const onError = (err) => {
      // EACCES/EPERM: Windows Hyper-V/WSL/Docker excluded port ranges. Treat as
      // unavailable so callers can bind a different loopback port.
      if (err?.code === "EADDRINUSE" || err?.code === "EACCES" || err?.code === "EPERM") {
        resolve(false);
      } else reject(err);
    };
    server.once("error", onError);
    server.unref();
    server.listen(port, host, () => {
      server.removeListener("error", onError);
      server.close((err) => {
        if (err) reject(err);
        else resolve(true);
      });
    });
  });
}

function healthCheck(host = DEFAULT_HOST, port = DEFAULT_PORT, timeoutMs = 2000) {
  return fetchHealth(host, port, timeoutMs).then((h) => Boolean(h?.ok));
}

/**
 * @returns {Promise<{ ok: boolean, fixture: boolean } | null>}
 */
function fetchHealth(host = DEFAULT_HOST, port = DEFAULT_PORT, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: "/api/health", timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        if (res.statusCode !== 200) {
          resolve(null);
          return;
        }
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          resolve({ ok: body.status === "ok", fixture: Boolean(body.fixture) });
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}

/** Best-effort: stop whatever is listening so we can restart in the right mode. */
function freePort(port) {
  if (process.platform !== "win32") return;
  try {
    const out = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `Get-NetTCPConnection -LocalPort ${Number(port)} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique`,
      ],
      { encoding: "utf8", windowsHide: true },
    );
    for (const tok of out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
      const pid = Number(tok);
      if (!Number.isFinite(pid) || pid <= 0) continue;
      try {
        execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
}

/** Electron's process.execPath is electron.exe — never use it to run the API server. */
function resolveNodeBinary(env = process.env, options = {}) {
  const platform = options.platform || process.platform;
  const fileSystem = options.fs || fs;
  const execFile = options.execFileSync || execFileSync;
  const processExecPath = options.execPath || process.execPath;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const candidates = [env.npm_node_execpath, env.NODE_BINARY];

  if (platform === "win32") {
    candidates.push(
      env.NVM_SYMLINK && pathApi.join(env.NVM_SYMLINK, "node.exe"),
      env.NVM_HOME && pathApi.join(env.NVM_HOME, "nodejs", "node.exe"),
      "C:\\nvm4w\\nodejs\\node.exe",
    );
  } else if (["node", "node.exe"].includes(pathApi.basename(processExecPath).toLowerCase())) {
    candidates.push(processExecPath);
  }

  for (const candidate of candidates.filter(Boolean)) {
    try {
      if (fileSystem.existsSync(candidate)) return candidate;
    } catch {
      // continue
    }
  }

  if (platform === "win32") {
    try {
      const out = execFile("where.exe", ["node"], { encoding: "utf8", windowsHide: true });
      const first = out
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.toLowerCase().endsWith("node.exe"));
      if (first && fileSystem.existsSync(first)) return first;
    } catch {
      // fall through
    }
  }

  return "node";
}

function assertNotElectronBinary(nodeBin) {
  const base = String(nodeBin).split(/[\\/]/).pop().toLowerCase();
  if (base === "electron.exe" || base === "electron") {
    throw new Error(`Refusing to launch usage server with Electron binary: ${nodeBin}`);
  }
}

function terminateChildAndWait(proc, timeoutMs = 3000) {
  if (proc.exitCode !== null && proc.exitCode !== undefined) return Promise.resolve();
  if (proc.signalCode !== null && proc.signalCode !== undefined) return Promise.resolve();

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.removeListener("exit", onExit);
      proc.removeListener("close", onExit);
      if (err) reject(err);
      else resolve();
    };
    const onExit = () => finish();
    const timer = setTimeout(() => {
      finish(new Error(`Child process did not exit within ${timeoutMs}ms after termination`));
    }, timeoutMs);
    proc.once("exit", onExit);
    proc.once("close", onExit);

    try {
      proc.kill();
    } catch (err) {
      finish(err);
    }
  });
}

/**
 * @returns {Promise<{
 *   proc: import('node:child_process').ChildProcess | null,
 *   nodeBin: string | null,
 *   logPath: string | null,
 *   reused: boolean,
 *   owned: boolean,
 *   endpoint: { host: string, port: number, baseUrl: string }
 * }>}
 */
async function ensureUsageServer(options = {}) {
  const host = options.host || DEFAULT_HOST;
  const port = Number(options.port || process.env.PORT || DEFAULT_PORT);
  const root = options.root || ROOT;
  const envExtra = options.env || {};
  const logPath = options.logPath || SERVER_LOG;
  const maxAttempts = options.maxAttempts || 80;
  const platform = options.platform || process.platform;
  const fileSystem = options.fs || fs;
  const fetchHealthFn = options.fetchHealth || fetchHealth;
  const isPortAvailableFn = options.isPortAvailable || isLoopbackPortAvailable;
  const allocateFreePortFn = options.allocateFreeLoopbackPort || allocateFreeLoopbackPort;
  const freePortFn = options.freePort || freePort;
  const resolveNodeBinaryFn = options.resolveNodeBinary || resolveNodeBinary;
  const spawnFn = options.spawn || spawn;
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const mergedEnv = { ...process.env, ...envExtra };
  const wantFixture =
    mergedEnv.USAGE_FIXTURE === "1" || String(mergedEnv.USAGE_FIXTURE).toLowerCase() === "true";

  const existing = await fetchHealthFn(host, port);
  if (existing?.ok && existing.fixture === wantFixture) {
    return {
      proc: null,
      nodeBin: null,
      logPath,
      reused: true,
      owned: false,
      endpoint: buildEndpoint(host, port),
    };
  }

  let launchPort = port;
  if (existing?.ok && existing.fixture !== wantFixture && platform !== "darwin") {
    fileSystem.appendFileSync(
      logPath,
      `[${new Date().toISOString()}] port ${port} fixture=${existing.fixture} but want ${wantFixture}; freeing\n`,
    );
    freePortFn(port);
    await sleep(500);
  } else if (existing?.ok || !(await isPortAvailableFn(host, port))) {
    // Occupied, healthy-but-not-ours (Darwin), or Windows excluded-port EACCES.
    launchPort = await allocateFreePortFn(host);
  }
  const endpoint = buildEndpoint(host, launchPort);

  const nodeBin = resolveNodeBinaryFn(mergedEnv, {
    platform,
    fs: fileSystem,
    execFileSync: options.execFileSync,
    execPath: options.execPath,
  });
  assertNotElectronBinary(nodeBin);

  const distEntry = path.join(root, "dist", "server.js");
  const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
  const srcEntry = path.join(root, "src", "server.ts");

  let spawnArgs;
  if (fileSystem.existsSync(distEntry)) {
    spawnArgs = [distEntry];
  } else if (fileSystem.existsSync(tsxCli) && fileSystem.existsSync(srcEntry)) {
    spawnArgs = [tsxCli, srcEntry];
  } else {
    throw new Error(
      `Usage server entry missing. Expected ${distEntry} (run npm run build) or tsx + ${srcEntry} (run npm install).`,
    );
  }

  fileSystem.writeFileSync(logPath, `[${new Date().toISOString()}] starting server with ${nodeBin}\n`, "utf8");
  const logFd = fileSystem.openSync(logPath, "a");
  const env = { ...mergedEnv, PORT: String(launchPort) };
  delete env.ELECTRON_RUN_AS_NODE;
  // Default launch is live; only keep fixture when explicitly requested.
  if (!wantFixture) delete env.USAGE_FIXTURE;

  let proc;
  try {
    proc = spawnFn(nodeBin, spawnArgs, {
      cwd: root,
      env,
      stdio: ["ignore", logFd, logFd],
      windowsHide: true,
    });
  } finally {
    fileSystem.closeSync(logFd);
  }

  let exitCode = null;
  proc.on("exit", (code) => {
    exitCode = code;
  });
  proc.on("error", (err) => {
    fileSystem.appendFileSync(logPath, `spawn error: ${err.message}\n`);
  });

  try {
    for (let i = 0; i < maxAttempts; i++) {
      await sleep(250);
      const h = await fetchHealthFn(host, launchPort);
      if (h?.ok && h.fixture === wantFixture) {
        return { proc, nodeBin, logPath, reused: false, owned: true, endpoint };
      }
      if (exitCode !== null) break;
    }

    const tail = fileSystem.existsSync(logPath)
      ? fileSystem.readFileSync(logPath, "utf8").slice(-800)
      : "(no log)";
    throw new Error(
      `Usage server did not become ready on ${endpoint.baseUrl} (node=${nodeBin}, exit=${exitCode}).\nLog: ${logPath}\n${tail}`,
    );
  } catch (err) {
    if (exitCode === null) {
      try {
        await terminateChildAndWait(proc, options.terminationTimeoutMs ?? 3000);
      } catch (cleanupErr) {
        throw new Error(
          `${err instanceof Error ? err.message : String(err)}\nFailed to terminate usage server child: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
          { cause: cleanupErr },
        );
      }
    }
    throw err;
  }
}

module.exports = {
  ROOT,
  DEFAULT_HOST,
  DEFAULT_PORT,
  SERVER_LOG,
  buildEndpoint,
  allocateFreeLoopbackPort,
  isLoopbackPortAvailable,
  healthCheck,
  fetchHealth,
  freePort,
  resolveNodeBinary,
  assertNotElectronBinary,
  ensureUsageServer,
};
