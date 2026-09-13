"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  getPlatformPolicy,
  selectDisplay,
} = require("./platform-policy.cjs");
const {
  loadBounds,
  saveBounds,
  cornerPlacement,
  resizeBottomRight,
  clampBoundsToWorkArea,
  restorePlacement,
} = require("./widget-bounds.cjs");

const ICON_DIR = path.join(__dirname, "icons");
const LEGACY_TRAY_ICON =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAALElEQVQ4T2NkYGD4z0ABYBzVMKoBBgYGRvL8P6oBMjIy/xkZGBhHNWBUA0Y1AABeJQMR9ZyeRgAAAABJRU5ErkJggg==";

function runWidgetMain({
  electron = require("electron"),
  serverLaunch = require("./server-launch.cjs"),
  platform = process.platform,
  env = process.env,
  argv = process.argv,
} = {}) {
  const { app, BrowserWindow, Tray, Menu, nativeImage, screen, shell, ipcMain, dialog } = electron;
  const { fetchHealth, ensureUsageServer, DEFAULT_HOST, DEFAULT_PORT, SERVER_LOG } = serverLaunch;
  const policy = getPlatformPolicy(platform);
  const root = path.join(__dirname, "..");
  const host = env.USAGE_HOST || DEFAULT_HOST;
  const port = Number(env.PORT || DEFAULT_PORT);
  /** Fixture is test-only. Widget product path never inherits USAGE_FIXTURE from the shell. */
  const allowFixture = argv.includes("--fixture");

  /** @type {BrowserWindow | null} */
  let win = null;
  /** @type {Tray | null} */
  let tray = null;
  /** @type {import('node:child_process').ChildProcess | null} */
  let serverProc = null;
  let ownsServer = false;
  /** @type {{ host: string, port: number, baseUrl: string } | null} */
  let serverEndpoint = null;
  /** @type {Promise<unknown> | null} */
  let ensurePromise = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let reviveTimer = null;
  /** @type {ReturnType<typeof setInterval> | null} */
  let healthTimer = null;
  let reviveFailures = 0;
  const HEALTH_POLL_MS = 15_000;
  const MAX_REVIVE_FAILURES = 12;
  /** Skip persisting while applying programmatic content-fit. */
  let applyingFit = false;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let persistTimer = null;

  function widgetServerEnv() {
    const serverEnv = { ...env };
    if (!allowFixture) {
      delete serverEnv.USAGE_FIXTURE;
    } else {
      serverEnv.USAGE_FIXTURE = "1";
    }
    return serverEnv;
  }

  function userDataDir() {
    try {
      return typeof app.getPath === "function" ? app.getPath("userData") : null;
    } catch {
      return null;
    }
  }

  function bindOwnedServer(proc) {
    if (!proc) return;
    serverProc = proc;
    ownsServer = true;
    proc.once("exit", (code, signal) => {
      if (serverProc === proc) {
        serverProc = null;
        ownsServer = false;
      }
      if (app.isQuitting) return;
      console.error(`[widget] usage server exited code=${code} signal=${signal}; scheduling revive`);
      scheduleRevive(400);
    });
  }

  async function ensureServer() {
    if (ensurePromise) return ensurePromise;
    ensurePromise = (async () => {
      const result = await ensureUsageServer({
        host,
        port,
        root,
        env: widgetServerEnv(),
      });
      serverEndpoint = result.endpoint;
      if (result.owned && result.proc) {
        bindOwnedServer(result.proc);
      }
      reviveFailures = 0;
      return result.endpoint;
    })().finally(() => {
      ensurePromise = null;
    });
    return ensurePromise;
  }

  function currentServerEndpoint() {
    if (!serverEndpoint) {
      throw new Error("Usage server endpoint is unavailable before startup completes");
    }
    return serverEndpoint;
  }

  function scheduleRevive(delayMs) {
    if (app.isQuitting) return;
    if (reviveTimer) clearTimeout(reviveTimer);
    reviveTimer = setTimeout(() => {
      reviveTimer = null;
      void reviveIfNeeded();
    }, delayMs);
    // Keep product revive alive without pinning the Node test runner open.
    reviveTimer.unref?.();
  }

  /**
   * Root-cause fix from master: usage server used to start once; if it died, the
   * renderer kept showing "fail" forever. Revive whenever health is down.
   */
  async function reviveIfNeeded() {
    if (app.isQuitting) return { ok: false, reason: "quitting" };
    const endpoint = serverEndpoint || { host, port, baseUrl: `http://${host}:${port}` };
    const health = await fetchHealth(endpoint.host, endpoint.port);
    if (health?.ok) {
      if (health.fixture && !allowFixture) {
        return { ok: false, reason: "fixture_mismatch" };
      }
      reviveFailures = 0;
      return { ok: true, reason: "healthy" };
    }
    if (reviveFailures >= MAX_REVIVE_FAILURES) {
      return { ok: false, reason: "give_up" };
    }
    try {
      const next = await ensureServer();
      const again = await fetchHealth(next.host, next.port);
      if (again?.ok && !(again.fixture && !allowFixture)) {
        reviveFailures = 0;
        return { ok: true, reason: "restarted" };
      }
      reviveFailures += 1;
      scheduleRevive(Math.min(30_000, 1000 * reviveFailures));
      return { ok: false, reason: "not_ready" };
    } catch (err) {
      reviveFailures += 1;
      console.error("[widget] revive failed:", err instanceof Error ? err.message : err);
      scheduleRevive(Math.min(30_000, 1000 * reviveFailures));
      return { ok: false, reason: "error", error: err instanceof Error ? err.message : String(err) };
    }
  }

  function startHealthWatchdog() {
    if (healthTimer) return;
    healthTimer = setInterval(() => {
      void reviveIfNeeded();
    }, HEALTH_POLL_MS);
    healthTimer.unref?.();
  }

  function workAreaFor(bounds) {
    if (bounds && typeof screen.getDisplayMatching === "function") {
      try {
        const display = screen.getDisplayMatching(bounds);
        if (display?.workArea) return display.workArea;
      } catch {
        // Fall through to the platform default display.
      }
    }
    return selectDisplay(policy, screen).workArea;
  }

  function windowPlacement() {
    const dir = userDataDir();
    const saved = dir ? loadBounds(dir) : null;
    const fallback = { width: policy.width, height: policy.height };
    if (platform === "darwin") {
      const size = saved || fallback;
      return cornerPlacement(size, selectDisplay(policy, screen).workArea, policy.margin);
    }
    return restorePlacement(saved, workAreaFor(saved), policy.margin, fallback);
  }

  function persistWindowBounds() {
    if (!win || applyingFit) return;
    if (typeof win.isDestroyed === "function" && win.isDestroyed()) return;
    if (typeof win.getBounds !== "function") return;
    const dir = userDataDir();
    if (!dir) return;
    try {
      const b = win.getBounds();
      saveBounds(dir, { x: b.x, y: b.y, width: b.width, height: b.height });
    } catch {
      // Missing userData dir or a locked file must not take the widget down.
    }
  }

  function schedulePersistWindowBounds() {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      persistWindowBounds();
    }, 250);
    persistTimer.unref?.();
  }

  function persistSize(next) {
    const dir = userDataDir();
    if (!dir) return;
    try {
      saveBounds(dir, next);
    } catch {
      // ignore
    }
  }

  function fitWindowToContent(contentHeight) {
    if (!win) return;
    if (typeof win.isDestroyed === "function" && win.isDestroyed()) return;
    if (typeof win.getBounds !== "function") return;
    const h = Number(contentHeight);
    if (!Number.isFinite(h) || h <= 0) return;
    const b = win.getBounds();
    const next =
      platform === "darwin"
        ? resizeBottomRight(b, b.width, Math.ceil(h))
        : clampBoundsToWorkArea(
            { x: b.x, y: b.y, width: b.width, height: Math.ceil(h) },
            workAreaFor(b),
          );
    if (next.width === b.width && next.height === b.height && next.x === b.x && next.y === b.y) {
      persistSize(next);
      return;
    }
    applyingFit = true;
    try {
      win.setBounds(next);
      persistSize(next);
    } finally {
      const release = setTimeout(() => {
        applyingFit = false;
      }, 0);
      release.unref?.();
    }
  }

  function iconPath(name) {
    return path.join(ICON_DIR, name);
  }

  function loadNativeIcon(name) {
    if (typeof nativeImage.createFromPath !== "function") return null;
    const img = nativeImage.createFromPath(iconPath(name));
    return img.isEmpty() ? null : img;
  }

  function windowIconPath() {
    for (const name of ["icon.ico", "icon.png", "icon-256.png", "icon-64.png", "icon-32.png"]) {
      const p = iconPath(name);
      if (fs.existsSync(p)) return p;
    }
    return undefined;
  }

  function ensureStartMenuShortcut() {
    if (platform !== "win32") return;
    if (typeof shell.writeShortcutLink !== "function") return;
    let appData;
    try {
      appData = typeof app.getPath === "function" ? app.getPath("appData") : null;
    } catch {
      return;
    }
    if (!appData) return;
    const shortcutPath = path.join(
      appData,
      "Microsoft",
      "Windows",
      "Start Menu",
      "Programs",
      "Token Usage Widget.lnk",
    );
    const cmd = path.join(root, "scripts", "start-widget.cmd");
    const ico = iconPath("icon.ico");
    try {
      shell.writeShortcutLink(shortcutPath, {
        target: cmd,
        cwd: root,
        description: "Token Usage always-on-top corner widget",
        icon: fs.existsSync(ico) ? ico : undefined,
        iconIndex: 0,
        appUserModelId: "com.token-usage.widget",
      });
    } catch {
      // Best-effort; missing Start Menu entry must not block the widget.
    }
  }

  function trayIcon() {
    if (policy.trayIcon === "template") {
      const image = nativeImage.createEmpty();
      for (const representation of [
        { scaleFactor: 1, file: "trayTemplate.png" },
        { scaleFactor: 2, file: "trayTemplate@2x.png" },
      ]) {
        const imageBytes = fs.readFileSync(path.join(__dirname, "assets", representation.file));
        image.addRepresentation({
          scaleFactor: representation.scaleFactor,
          dataURL: `data:image/png;base64,${imageBytes.toString("base64")}`,
        });
      }
      image.setTemplateImage(true);
      return image;
    }
    return (
      loadNativeIcon("icon-16.png") ||
      loadNativeIcon("icon-32.png") ||
      loadNativeIcon("icon.png") ||
      nativeImage.createFromDataURL(LEGACY_TRAY_ICON)
    );
  }

  function reanchorWindow() {
    if (!win) return;
    if (platform === "darwin") {
      win.setBounds(windowPlacement());
      return;
    }
    if (typeof win.getBounds !== "function") return;
    const b = win.getBounds();
    const next = clampBoundsToWorkArea(b, workAreaFor(b));
    if (next.x !== b.x || next.y !== b.y || next.width !== b.width || next.height !== b.height) {
      win.setBounds(next);
    }
  }

  function showWindow({ focus = false, inactive = false } = {}) {
    if (!win) createWindow();
    if (!win) return;
    // Darwin keeps the menu-bar utility pinned to the pointer display corner.
    // Windows restores the last size/position and must not snap back to bottom-right.
    if (platform === "darwin") reanchorWindow();
    if (inactive) win.showInactive();
    else win.show();
    if (focus) win.focus();
  }

  function requestQuit() {
    if (app.isQuitting) return;
    app.isQuitting = true;
    persistWindowBounds();
    app.quit();
  }

  function createWindow() {
    // Windows taskbar/window chrome uses the PNG set; Darwin menu-bar utility does not.
    const icon = platform === "win32" ? windowIconPath() : undefined;
    win = new BrowserWindow({
      ...windowPlacement(),
      frame: false,
      transparent: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      backgroundColor: "#04141c",
      show: false,
      ...(icon ? { icon } : {}),
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    win.setAlwaysOnTop(true, policy.windowLevel);
    win.setVisibleOnAllWorkspaces(policy.visibleOnAllWorkspaces, {
      visibleOnFullScreen: policy.visibleOnFullScreen,
    });
    win.loadURL(`${currentServerEndpoint().baseUrl}/widget.html`);

    win.once("ready-to-show", () => {
      showWindow({ inactive: true });
    });

    win.on("resize", () => {
      if (applyingFit) return;
      schedulePersistWindowBounds();
    });
    win.on("move", () => {
      if (applyingFit) return;
      schedulePersistWindowBounds();
    });
    win.on("moved", () => {
      if (applyingFit) return;
      schedulePersistWindowBounds();
    });

    win.on("close", (event) => {
      if (app.isQuitting) return;
      persistWindowBounds();
      if (policy.nativeClose === "hide") {
        event.preventDefault();
        win?.hide();
        return;
      }
      requestQuit();
    });

    win.on("closed", () => {
      win = null;
    });
  }

  function installApplicationMenu() {
    if (platform !== "darwin") return;
    const applicationMenu = Menu.buildFromTemplate([
      {
        label: app.name || "Token Usage",
        submenu: [{ role: "quit", accelerator: "Command+Q" }],
      },
    ]);
    Menu.setApplicationMenu(applicationMenu);
  }

  function buildTray() {
    tray = new Tray(trayIcon());
    tray.setToolTip("Token Usage");
    const menu = Menu.buildFromTemplate([
      {
        label: "Show widget",
        click: () => showWindow({ focus: true }),
      },
      {
        label: "Hide widget",
        click: () => {
          persistWindowBounds();
          win?.hide();
        },
      },
      {
        label: "Open full dashboard",
        click: () => shell.openExternal(`${currentServerEndpoint().baseUrl}/`),
      },
      {
        label: "Settings…",
        click: () => shell.openExternal(`${currentServerEndpoint().baseUrl}/#settings`),
      },
      { type: "separator" },
      {
        label: "Quit",
        click: requestQuit,
      },
    ]);
    tray.setContextMenu(menu);
    tray.on("click", () => {
      if (win?.isVisible()) {
        persistWindowBounds();
        win.hide();
      } else showWindow();
    });
  }

  function stopServer() {
    if (reviveTimer) {
      clearTimeout(reviveTimer);
      reviveTimer = null;
    }
    if (healthTimer) {
      clearInterval(healthTimer);
      healthTimer = null;
    }
    const child = serverProc;
    const shouldStop = ownsServer && child && !child.killed;
    serverProc = null;
    ownsServer = false;
    if (shouldStop) {
      try {
        child.kill();
      } catch {
        // ignore
      }
    }
  }

  ipcMain.handle("widget:close", () => {
    persistWindowBounds();
    win?.hide();
  });

  ipcMain.handle("widget:open-dashboard", () => {
    shell.openExternal(`${currentServerEndpoint().baseUrl}/`);
  });

  ipcMain.handle("widget:ensure-server", async () => reviveIfNeeded());

  ipcMain.handle("widget:fit-content", (_evt, payload) => {
    const height = payload && typeof payload === "object" ? payload.height : payload;
    fitWindowToContent(height);
  });

  ipcMain.handle("widget:quit", requestQuit);

  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    requestQuit();
    return;
  }

  app.on("second-instance", () => {
    if (!serverEndpoint) return;
    showWindow({ focus: true });
  });

  app.on("before-quit", () => {
    app.isQuitting = true;
    persistWindowBounds();
    stopServer();
  });

  app.whenReady().then(async () => {
    if (platform === "win32" && typeof app.setAppUserModelId === "function") {
      app.setAppUserModelId("com.token-usage.widget");
    }
    ensureStartMenuShortcut();
    if (policy.activationPolicy && typeof app.setActivationPolicy === "function") {
      app.setActivationPolicy(policy.activationPolicy);
    }
    if (policy.hideDock && app.dock) {
      app.dock.hide();
    }
    installApplicationMenu();

    for (const eventName of ["display-added", "display-removed", "display-metrics-changed"]) {
      screen.on(eventName, reanchorWindow);
    }

    try {
      const endpoint = await ensureServer();
      const health = await fetchHealth(endpoint.host, endpoint.port);
      if (!health?.ok) {
        throw new Error(`Server health check failed after ensureServer. See ${SERVER_LOG}`);
      }
      if (health.fixture && !allowFixture) {
        throw new Error(
          `Usage server at ${endpoint.baseUrl} is in FIXTURE mode but this widget was not started with --fixture. Refusing to show fake data. Stop that server and relaunch.`,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(message);
      dialog.showErrorBox("Token Usage Widget", message);
      requestQuit();
      return;
    }
    startHealthWatchdog();
    createWindow();
    buildTray();
  });
}

module.exports = { runWidgetMain };

// Electron 35+ does not set require.main for the app entry (require.main === module
// is false), so gating on that alone leaves a headless Electron process with no
// window/tray. Tests require this module (module.parent set) and call runWidgetMain.
if (require.main === module || (process.versions.electron && !module.parent)) {
  runWidgetMain();
}
