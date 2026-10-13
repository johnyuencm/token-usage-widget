/**
 * After provider config changes, free the usage-server port and relaunch the widget
 * so the UI picks up the new provider set without a manual restart.
 */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { loadExisting, serverEndpointFromConfig } from "./provider-config.js";
import { packageRoot } from "../config.js";

export type FreePortFn = (port: number, host: string, log: (msg: string) => void) => unknown;
export type LaunchWidgetFn = () => Promise<unknown>;

export interface RefreshRuntimeDeps {
  platform?: NodeJS.Platform;
  freePort?: FreePortFn;
  launchWidget?: LaunchWidgetFn;
  loadConfig?: () => Record<string, unknown>;
  log?: (msg: string) => void;
}

export interface FreePortDeps {
  fetchImpl?: typeof fetch;
  exec?: (cmd: string, args: string[]) => unknown;
}

const SERVER_APP = "token-usage-widget";

/**
 * Best-effort (Windows): stop our usage server so we can restart it.
 * Kills only the pid that our /api/health reports. Another app on the port is left alone.
 * @returns true when a kill was sent
 */
export async function freePortWin32(
  port: number,
  host = "127.0.0.1",
  log: (msg: string) => void = () => {},
  deps: FreePortDeps = {},
): Promise<boolean> {
  const probeHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  let body: { app?: unknown; pid?: unknown } | null = null;
  try {
    const res = await (deps.fetchImpl ?? fetch)(`http://${probeHost}:${Number(port)}/api/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) body = (await res.json()) as { app?: unknown; pid?: unknown };
  } catch {
    return false; // nothing listening (or not HTTP): nothing to stop
  }
  const pid = body?.pid;
  if (body?.app !== SERVER_APP || typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    log(`Port ${port} is used by another app; not stopping it.`);
    return false;
  }
  try {
    (deps.exec ?? ((cmd, args) => execFileSync(cmd, args, { stdio: "ignore", windowsHide: true })))(
      "taskkill",
      ["/PID", String(pid), "/T", "/F"],
    );
    return true;
  } catch {
    return false;
  }
}

function defaultLaunchWidget(): Promise<unknown> {
  const require = createRequire(import.meta.url);
  const root = packageRoot();
  const launcher = path.join(root, "scripts", "start-widget.cjs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require(launcher) as {
    launchWidget: (opts?: { checkout?: string }) => Promise<unknown>;
  };
  return mod.launchWidget({ checkout: root });
}

/**
 * Refresh running widget/server after config mutation.
 * win32/darwin: free preferred port + relaunch widget.
 * other platforms: print a restart hint.
 */
export async function refreshRuntime(deps: RefreshRuntimeDeps = {}): Promise<void> {
  const platform = deps.platform ?? process.platform;
  const log = deps.log ?? ((msg: string) => {
    // eslint-disable-next-line no-console
    console.log(msg);
  });
  const cfg = (deps.loadConfig ?? loadExisting)();
  const { host, port } = serverEndpointFromConfig(cfg);

  if (platform !== "win32" && platform !== "darwin") {
    log(`Provider config updated. Restart the widget with: tuw`);
    return;
  }

  const free = deps.freePort ?? (platform === "win32" ? freePortWin32 : () => {});
  await free(port, host, log);

  const launch = deps.launchWidget ?? defaultLaunchWidget;
  try {
    await launch();
    log("Widget refreshed.");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to refresh widget: ${reason}. Retry with: tuw`);
  }
}
