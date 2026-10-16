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
  boundsContainPoint,
  hoverTargetBounds,
  MIN_WIDTH,
  MIN_HEIGHT,
  DOCK_PEEK_PX,
} = require("./widget-bounds.cjs");
const { createWidgetDock } = require("./widget-dock.cjs");

const ICON_DIR = path.join(__dirname, "icons");
const SHORTCUT_NAME = "Token Usage Widget.lnk";

const LEGACY_TRAY_ICON =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAALElEQVQ4T2NkYGD4z0ABYBzVMKoBBgYGRvL8P6oBMjIy/xkZGBhHNWBUA0Y1AABeJQMR9ZyeRgAAAABJRU5ErkJggg==";

function runWidgetMain({
  electron = require("electron"),
  serverLaunch = require("./server-launch.cjs"),
  platform = process.platform,
  env = process.env,
  argv = process.argv,
  dockTiming = null,
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
  /** Revive starts since the server was last healthy for HEALTHY_RESET_MS. */
  let reviveFailures = 0;
  let healthMisses = 0;
  let lastStartAt = 0;
  const HEALTH_POLL_MS = 15_000;
  const MAX_REVIVE_FAILURES = 12;
  /** A live but slow server can miss one 2 s check; revive only after this many in a row. */
  const HEALTH_MISSES_BEFORE_REVIVE = 3;
  const HEALTHY_RESET_MS = 60_000;
  /** Skip persisting while applying programmatic content-fit. */
  let applyingFit = false;
  /**
   * Sticky once the user drags a corner. Electron emits will-resize/resized only
   * for that manual resize, never for setBounds, so content-fit cannot set it.
   */
  let userSized = false;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let persistTimer = null;
  /** True while a dock slide owns setBounds. User moves must not save the strip. */
  let applyingDock = false;
  let dockEpoch = 0;
  /** @type {ReturnType<typeof createWidgetDock> | null} */
  let dock = null;
  /** @type {ReturnType<typeof setInterval> | null} */
  let pointerPoll = null;
  const pointerPollMs = dockTiming?.pollMs ?? 40;

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
    // A revive after one missed health check can start a new server on a fallback
    // port while the old one still runs. Stop the old owned one so it never orphans.
    const previous = serverProc;
    if (ownsServer && previous && previous !== proc && !previous.killed) {
      try {
        previous.kill();
      } catch {
        // ignore
      }
    }
    serverProc = proc;
    ownsServer = true;
    proc.once("exit", (code, signal) => {
      if (serverProc === proc) {
        serverProc = null;
        ownsServer = false;
      }
      if (app.isQuitting) return;
      console.error(`[widget] usage server exited code=${code} signal=${signal}; scheduling revive`);
      // A dead server needs no more health misses before the revive.
      healthMisses = HEALTH_MISSES_BEFORE_REVIVE;
      scheduleRevive(400);
    });
  }

  function ownedServerAlive() {
    return Boolean(ownsServer && serverProc && serverProc.exitCode == null && !serverProc.killed);
  }

  /** Stop the owned server and wait (max 3 s) so its port is free for the restart. */
  function stopOwnedServer() {
    const proc = serverProc;
    if (!ownedServerAlive()) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, 3000);
      timer.unref?.();
      proc.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        proc.kill();
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }

  async function ensureServer(preferredPort = port) {
    if (ensurePromise) return ensurePromise;
    ensurePromise = (async () => {
      const result = await ensureUsageServer({
        host,
        port: preferredPort,
        root,
        env: widgetServerEnv(),
      });
      const previousUrl = serverEndpoint?.baseUrl;
      serverEndpoint = result.endpoint;
      lastStartAt = Date.now();
      if (result.owned && result.proc) {
        bindOwnedServer(result.proc);
      }
      // The renderer fetches relative /api/* URLs, so a new port needs a reload.
      if (previousUrl && previousUrl !== result.endpoint.baseUrl && win && !win.isDestroyed?.()) {
        win.loadURL(`${result.endpoint.baseUrl}/widget.html`);
      }
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
      healthMisses = 0;
      // Reset only after a stable period, so a crash loop still reaches MAX_REVIVE_FAILURES.
      if (Date.now() - lastStartAt >= HEALTHY_RESET_MS) reviveFailures = 0;
      return { ok: true, reason: "healthy" };
    }
    healthMisses += 1;
    if (healthMisses < HEALTH_MISSES_BEFORE_REVIVE) {
      return { ok: false, reason: "health_miss" };
    }
    if (reviveFailures >= MAX_REVIVE_FAILURES) {
      return { ok: false, reason: "give_up" };
    }
    reviveFailures += 1;
    try {
      // Never run two owned servers: stop a live but unhealthy one, then reuse its port.
      await stopOwnedServer();
      const next = await ensureServer(endpoint.port);
      const again = await fetchHealth(next.host, next.port);
      if (again?.ok && !(again.fixture && !allowFixture)) {
        healthMisses = 0;
        return { ok: true, reason: "restarted" };
      }
      scheduleRevive(Math.min(30_000, 1000 * reviveFailures));
      return { ok: false, reason: "not_ready" };
    } catch (err) {
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
    if (saved?.userSized) userSized = true;
    const fallback = { width: policy.width, height: policy.height };
    if (platform === "darwin") {
      const size = saved || fallback;
      return cornerPlacement(size, selectDisplay(policy, screen).workArea, policy.margin);
    }
    return restorePlacement(saved, workAreaFor(saved), policy.margin, fallback);
  }

  function persistWindowBounds() {
    if (!win || applyingFit || applyingDock) return;
    if (typeof win.isDestroyed === "function" && win.isDestroyed()) return;
    if (typeof win.getBounds !== "function") return;
    const dir = userDataDir();
    if (!dir) return;
    try {
      const b = dock?.getRest() || win.getBounds();
      const payload = { x: b.x, y: b.y, width: b.width, height: b.height };
      if (userSized) payload.userSized = true;
      saveBounds(dir, payload);
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
    if (userSized) return { locked: true };
    if (!win) return { locked: false };
    if (typeof win.isDestroyed === "function" && win.isDestroyed()) return { locked: false };
    if (typeof win.getBounds !== "function") return { locked: false };
    const h = Number(contentHeight);
    if (!Number.isFinite(h) || h <= 0) return { locked: false };
    const b = dock?.getRest() || win.getBounds();
    // Wrapped rows at the 220px floor used to report a taller scroll height
    // and bounce a minimized widget larger. Fit may shrink; it may not grow.
    const fittedHeight = Math.min(b.height, Math.ceil(h));
    const next =
      platform === "darwin"
        ? resizeBottomRight(b, b.width, fittedHeight)
        : clampBoundsToWorkArea(
            { x: b.x, y: b.y, width: b.width, height: fittedHeight },
            workAreaFor(b),
          );
    if (next.width === b.width && next.height === b.height && next.x === b.x && next.y === b.y) {
      dock?.setRest(next);
      persistSize(next);
      return { locked: false };
    }
    applyingFit = true;
    try {
      dock?.setRest(next);
      if (dock?.isHidden()) dock.retarget();
      else win.setBounds(next);
      persistSize(next);
    } finally {
      const release = setTimeout(() => {
        applyingFit = false;
      }, 0);
      release.unref?.();
    }
    return { locked: false };
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

  function startMenuProgramsDir() {
    try {
      const appData = typeof app.getPath === "function" ? app.getPath("appData") : null;
      return appData ? path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs") : null;
    } catch {
      return null;
    }
  }

  /**
   * Point the shortcut straight at electron.exe. No cmd or PowerShell window opens at
   * logon; hidden script launchers made antivirus behavior monitors flag the widget.
   */
  function writeWidgetShortcut(shortcutPath) {
    if (typeof shell.writeShortcutLink !== "function") return false;
    const ico = iconPath("icon.ico");
    try {
      return shell.writeShortcutLink(shortcutPath, {
        target: process.execPath,
        args: `"${root}"`,
        cwd: root,
        description: "Token Usage always-on-top corner widget",
        icon: fs.existsSync(ico) ? ico : undefined,
        iconIndex: 0,
        appUserModelId: "com.token-usage.widget",
      });
    } catch {
      return false;
    }
  }

  function ensureStartMenuShortcut() {
    if (platform !== "win32") return;
    const programs = startMenuProgramsDir();
    if (!programs) return;
    // Best-effort; a missing Start Menu entry must not block the widget.
    writeWidgetShortcut(path.join(programs, SHORTCUT_NAME));
    // Migrate an older Startup shortcut that still targets start-widget.cmd.
    const startup = path.join(programs, "Startup", SHORTCUT_NAME);
    if (fs.existsSync(startup)) writeWidgetShortcut(startup);
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
      const placed = windowPlacement();
      dock?.setRest(placed);
      if (dock?.isHidden()) {
        dock.retarget();
        return;
      }
      win.setBounds(placed);
      return;
    }
    if (typeof win.getBounds !== "function") return;
    const b = dock?.getRest() || win.getBounds();
    const next = clampBoundsToWorkArea(b, workAreaFor(b));
    dock?.setRest(next);
    if (dock?.isHidden()) {
      dock.retarget();
      return;
    }
    if (next.x !== b.x || next.y !== b.y || next.width !== b.width || next.height !== b.height) {
      win.setBounds(next);
    }
  }

  function readPointerInside() {
    if (!win || !dock) return null;
    if (typeof win.isDestroyed === "function" && win.isDestroyed()) return null;
    if (typeof win.isVisible === "function" && !win.isVisible()) return null;
    if (typeof screen.getCursorScreenPoint !== "function") return null;
    let point;
    try {
      point = screen.getCursorScreenPoint();
    } catch {
      return null;
    }
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
    const current = win.getBounds();
    const rest = dock.getRest();
    const target = hoverTargetBounds({
      rest,
      current,
      workArea: rest ? workAreaFor(rest) : null,
      hidden: dock.isHidden(),
      applying: dock.isApplying(),
      peek: DOCK_PEEK_PX,
    });
    if (!target) return null;
    return boundsContainPoint(target, point);
  }

  function syncPointer() {
    const inside = readPointerInside();
    if (inside === null) return;
    dock?.notePointer(inside);
  }

  function startPointerPoll() {
    if (pointerPoll || pointerPollMs <= 0) return;
    pointerPoll = setInterval(syncPointer, pointerPollMs);
    pointerPoll.unref?.();
    syncPointer();
  }

  function stopPointerPoll() {
    if (!pointerPoll) return;
    clearInterval(pointerPoll);
    pointerPoll = null;
  }

  function showWindow({ focus = false, inactive = false } = {}) {
    if (!win) createWindow();
    if (!win) return;
    // Darwin keeps the menu-bar utility pinned to the pointer display corner.
    // Windows restores the last size/position and must not snap back to bottom-right.
    if (platform === "darwin") reanchorWindow();
    dock?.reveal();
    if (inactive) win.showInactive();
    else win.show();
    if (focus) win.focus();
    startPointerPoll();
  }

  function concealWindow() {
    dock?.cancelPending();
    persistWindowBounds();
    win?.hide();
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
    const placement = windowPlacement();
    win = new BrowserWindow({
      ...placement,
      frame: false,
      transparent: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: true,
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
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
    // On Windows, the constructor scales the size by a non-primary display's
    // factor (125%: 221x141 becomes 280x178), and each start saved it bigger.
    // setBounds applies the same rectangle in DIP.
    win.setBounds(placement);

    win.setAlwaysOnTop(true, policy.windowLevel);
    win.setVisibleOnAllWorkspaces(policy.visibleOnAllWorkspaces, {
      visibleOnFullScreen: policy.visibleOnFullScreen,
    });
    win.loadURL(`${currentServerEndpoint().baseUrl}/widget.html`);

    const timing = {};
    if (dockTiming && Number.isFinite(dockTiming.hideDelayMs)) timing.hideDelayMs = dockTiming.hideDelayMs;
    if (dockTiming && Number.isFinite(dockTiming.slideMs)) timing.slideMs = dockTiming.slideMs;
    if (dockTiming && Number.isFinite(dockTiming.peek)) timing.peek = dockTiming.peek;
    dock = createWidgetDock({
      ...timing,
      getBounds: () => win.getBounds(),
      setBounds: (bounds) => {
        if (!win || (typeof win.isDestroyed === "function" && win.isDestroyed())) return;
        win.setBounds(bounds);
      },
      workAreaFor: (bounds) => workAreaFor(bounds),
      onSlideStart: () => {
        dockEpoch += 1;
        applyingDock = true;
      },
      onSlideEnd: () => {
        const epoch = dockEpoch;
        const release = setTimeout(() => {
          if (epoch !== dockEpoch) return;
          applyingDock = false;
        }, 0);
        release.unref?.();
      },
    });
    dock.setRest(placement);

    win.once("ready-to-show", () => {
      showWindow({ inactive: true });
    });

    const onUserGeometry = () => {
      if (applyingFit || applyingDock || !dock || !win) return;
      const b = win.getBounds();
      if (dock.isHidden()) {
        const rest = dock.getRest();
        if (rest) dock.setRest({ ...rest, width: b.width, height: b.height });
        dock.retarget();
        schedulePersistWindowBounds();
        return;
      }
      if (dock.noteUserBounds(b)) schedulePersistWindowBounds();
    };
    win.on("resize", onUserGeometry);
    win.on("move", onUserGeometry);
    win.on("moved", onUserGeometry);
    const noteUserResize = () => {
      userSized = true;
      if (!applyingFit && !applyingDock && dock && win) {
        const b = win.getBounds();
        if (dock.isHidden()) {
          const rest = dock.getRest();
          if (rest) dock.setRest({ ...rest, width: b.width, height: b.height });
          dock.retarget();
        } else {
          dock.noteUserBounds(b);
        }
      }
      persistWindowBounds();
    };
    win.on("will-resize", noteUserResize);
    win.on("resized", noteUserResize);

    win.on("close", (event) => {
      if (app.isQuitting) return;
      if (policy.nativeClose === "hide") {
        event.preventDefault();
        concealWindow();
        return;
      }
      requestQuit();
    });

    win.on("closed", () => {
      dock?.dispose();
      dock = null;
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
        click: () => concealWindow(),
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
      if (win?.isVisible()) concealWindow();
      else showWindow();
    });
  }

  function stopServer() {
    stopPointerPoll();
    dock?.dispose();
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
    concealWindow();
  });

  ipcMain.handle("widget:pointer", (_evt, inside) => {
    dock?.notePointer(Boolean(inside));
  });

  ipcMain.handle("widget:open-dashboard", () => {
    shell.openExternal(`${currentServerEndpoint().baseUrl}/`);
  });

  ipcMain.handle("widget:ensure-server", async () => reviveIfNeeded());

  ipcMain.handle("widget:fit-content", (_evt, payload) => {
    const obj = payload && typeof payload === "object" ? payload : null;
    if (obj?.probe === true) return { locked: userSized };
    const height = obj ? obj.height : payload;
    return fitWindowToContent(height);
  });

  ipcMain.handle("widget:quit", requestQuit);

  if (argv.includes("--install-startup")) {
    app.whenReady().then(() => {
      const programs = platform === "win32" ? startMenuProgramsDir() : null;
      const target = programs && path.join(programs, "Startup", SHORTCUT_NAME);
      const ok = Boolean(target && writeWidgetShortcut(target));
      console.log(ok ? `Startup shortcut installed: ${target}` : "Startup shortcut was not written.");
      app.exit(ok ? 0 : 1);
    });
    return;
  }

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
