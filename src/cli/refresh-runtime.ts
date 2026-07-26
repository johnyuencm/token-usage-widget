/**
 * After provider config changes, free the usage-server port and relaunch the widget
 * so the UI picks up the new provider set without a manual restart.
 */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { loadExisting, serverEndpointFromConfig } from "./provider-config.js";
import { packageRoot } from "../config.js";

export type FreePortFn = (port: number) => void;
export type LaunchWidgetFn = () => Promise<unknown>;

export interface RefreshRuntimeDeps {
  platform?: NodeJS.Platform;
  freePort?: FreePortFn;
  launchWidget?: LaunchWidgetFn;
  loadConfig?: () => Record<string, unknown>;
  log?: (msg: string) => void;
}

/** Best-effort: stop whatever is listening so we can restart (Windows). */
export function freePortWin32(port: number): void {
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
        execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
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
  const { port } = serverEndpointFromConfig(cfg);

  if (platform !== "win32" && platform !== "darwin") {
    log(`Provider config updated. Restart the widget with: tuw`);
    return;
  }

  const free = deps.freePort ?? (platform === "win32" ? freePortWin32 : () => {});
  free(port);

  const launch = deps.launchWidget ?? defaultLaunchWidget;
  try {
    await launch();
    log("Widget refreshed.");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to refresh widget: ${reason}. Retry with: tuw`);
  }
}
