import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, resolveServerAuth, isFixtureMode, type ProviderFlags } from "./config.js";
import { authorizeApiRequest, isLoopbackHost } from "./server-auth.js";
import { buildFixtureResponse } from "./fixtures.js";
import { fetchEnabledProvidersThrottled } from "./providers/poll-cache.js";
import { getPublicSettings, saveUiSettingsPatch } from "./settings-api.js";
import type { UsageResponse } from "./types.js";
import { ALL_PROVIDER_IDS } from "./types.js";

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(payload);
}

async function gatherUsage(): Promise<UsageResponse> {
  const cfg = await loadConfig();
  if (isFixtureMode()) {
    // Demo all providers only when explicitly requested (CI / screenshots).
    const allOn =
      process.env.USAGE_FIXTURE_ALL === "1" || process.env.USAGE_FIXTURE_ALL === "true";
    const flags: ProviderFlags = allOn
      ? (Object.fromEntries(ALL_PROVIDER_IDS.map((id) => [id, true])) as ProviderFlags)
      : cfg.providers;
    return buildFixtureResponse(flags);
  }
  const providers = await fetchEnabledProvidersThrottled(cfg);
  return {
    fetchedAt: new Date().toISOString(),
    fixture: false,
    providers,
    ui: cfg.ui,
  };
}

async function handleApiSettings(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  includeConfigPath: boolean,
): Promise<void> {
  if (req.method === "GET") {
    try {
      const body = await getPublicSettings({ includeConfigPath });
      sendJson(res, 200, body);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      sendJson(res, 500, { error: msg });
    }
    return;
  }
  if (req.method === "PUT") {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks).toString("utf8");
      const parsed = raw.trim() ? JSON.parse(raw) : {};
      const ui = await saveUiSettingsPatch(parsed.ui ?? parsed);
      sendJson(res, 200, { ok: true, ui });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      sendJson(res, 400, { ok: false, error: msg });
    }
    return;
  }
  sendJson(res, 405, { error: "Method not allowed" });
}

async function handleApiUsage(res: http.ServerResponse): Promise<void> {
  try {
    const body = await gatherUsage();
    sendJson(res, 200, body);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    sendJson(res, 500, {
      fetchedAt: new Date().toISOString(),
      fixture: false,
      providers: [],
      error: msg,
    });
  }
}

function handleHealth(res: http.ServerResponse): void {
  sendJson(res, 200, {
    status: "ok",
    fixture: isFixtureMode(),
    time: new Date().toISOString(),
  });
}

async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/" || pathname === "") pathname = "/index.html";

  // prevent path traversal
  const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, safePath);
  const base = path.resolve(PUBLIC_DIR);
  if (!filePath.startsWith(base)) {
    res.writeHead(403, { "content-type": "text/plain" });
    res.end("Forbidden");
    return;
  }
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
    return;
  }
  try {
    const data = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("Internal error");
  }
}

export interface ServerAuthContext {
  lanToken: string | null;
  loopbackBind: boolean;
}

/** Exported for tests: the request handler without binding a socket. */
export function createRequestHandler(auth: ServerAuthContext) {
  return async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;
    if (pathname.startsWith("/api/") && !authorizeApiRequest(req, auth.lanToken)) {
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }
    if (pathname === "/api/settings") {
      await handleApiSettings(req, res, auth.loopbackBind);
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "text/plain" });
      res.end("Method not allowed");
      return;
    }
    if (pathname === "/api/usage") {
      await handleApiUsage(res);
      return;
    }
    if (pathname === "/api/health") {
      handleHealth(res);
      return;
    }
    await serveStatic(req, res);
  };
}

async function main(): Promise<void> {
  const cfg = await loadConfig();
  const lanToken = await resolveServerAuth(cfg);
  const server = http.createServer(
    createRequestHandler({ lanToken, loopbackBind: isLoopbackHost(cfg.server.host) }),
  );

  server.on("error", (err) => {
    // eslint-disable-next-line no-console
    console.error("fatal:", err);
    process.exit(1);
  });
  server.listen(cfg.server.port, cfg.server.host, () => {
    const addr = `http://${cfg.server.host}:${cfg.server.port}`;
    // eslint-disable-next-line no-console
    console.log(`token-usage-dashboard listening on ${addr} (fixture=${isFixtureMode()})`);
    if (!isLoopbackHost(cfg.server.host)) {
      // eslint-disable-next-line no-console
      console.warn(
        `WARNING: server.host=${cfg.server.host} is not loopback. The API (quota percentages, ` +
          `balances) is reachable from your LAN. Requests must send ` +
          `Authorization: Bearer <server.lanToken> (stored in config.json, mode 0600). ` +
          `Remove the token header requirement by binding 127.0.0.1 instead.`,
      );
    }
  });

  const shutdown = (): void => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("fatal:", err);
    process.exit(1);
  });
}
