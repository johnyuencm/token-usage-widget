"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const {
  resolveNodeBinary,
  assertNotElectronBinary,
  buildEndpoint,
  allocateFreeLoopbackPort,
  isLoopbackPortAvailable,
  ensureUsageServer,
  healthCheck,
} = require("../desktop/server-launch.cjs");
const {
  getPlatformPolicy,
  selectDisplay,
  calculateCornerBounds,
} = require("../desktop/platform-policy.cjs");

function createFakeChild() {
  const child = new EventEmitter();
  child.killed = false;
  child.killCalls = 0;
  child.kill = () => {
    child.killCalls += 1;
    child.killed = true;
  };
  return child;
}

function createFakeFileSystem() {
  return {
    existsSync: () => true,
    writeFileSync: () => {},
    openSync: () => 9,
    closeSync: () => {},
    appendFileSync: () => {},
    readFileSync: () => "",
  };
}

async function loadMainHarness(
  serverResult,
  {
    platform = "win32",
    primaryDisplay = { workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
    pointerDisplay = { workArea: { x: 1920, y: 24, width: 1440, height: 876 } },
  } = {},
) {
  const mainPath = require.resolve("../desktop/main.cjs");
  const app = new EventEmitter();
  app.isQuitting = false;
  app.quitCalls = 0;
  app.activationPolicies = [];
  app.dock = { hideCalls: 0, hide: () => (app.dock.hideCalls += 1) };
  app.requestSingleInstanceLock = () => true;
  app.whenReady = () => Promise.resolve();
  app.setActivationPolicy = (policy) => app.activationPolicies.push(policy);
  app.quit = () => {
    app.quitCalls += 1;
    app.emit("before-quit");
  };
  app.getPath = (name) => {
    if (name === "appData") return "C:\\Users\\test\\AppData\\Roaming";
    if (name === "userData") return "C:\\Users\\test\\AppData\\Roaming\\token-usage-widget";
    return "C:\\tmp";
  };
  app.setAppUserModelId = () => {};

  const ipcHandlers = new Map();
  const windows = [];
  const trays = [];
  const openedUrls = [];
  const healthCalls = [];
  const legacyIcons = [];
  const templateIcons = [];
  const applicationMenus = [];
  let cursorPoint = { x: 2500, y: 400 };
  let activePointerDisplay = pointerDisplay;

  class FakeBrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.loadedUrl = null;
      this.visible = false;
      this.boundsCalls = [];
      this.alwaysOnTopCalls = [];
      this.workspaceCalls = [];
      this.showCalls = 0;
      this.showInactiveCalls = 0;
      this.focusCalls = 0;
      this.hideCalls = 0;
      windows.push(this);
    }
    setAlwaysOnTop(...args) {
      this.alwaysOnTopCalls.push(args);
    }
    setVisibleOnAllWorkspaces(...args) {
      this.workspaceCalls.push(args);
    }
    setBounds(bounds) {
      this.boundsCalls.push(bounds);
    }
    loadURL(url) {
      this.loadedUrl = url;
    }
    showInactive() {
      this.showInactiveCalls += 1;
      this.visible = true;
    }
    show() {
      this.showCalls += 1;
      this.visible = true;
    }
    focus() {
      this.focusCalls += 1;
    }
    hide() {
      this.hideCalls += 1;
      this.visible = false;
    }
    isVisible() {
      return this.visible;
    }
  }

  class FakeTray extends EventEmitter {
    constructor(icon) {
      super();
      this.icon = icon;
      trays.push(this);
    }
    setToolTip() {}
    setContextMenu(menu) {
      this.menu = menu;
    }
  }

  const screenApi = new EventEmitter();
  screenApi.getPrimaryDisplay = () => primaryDisplay;
  screenApi.getCursorScreenPoint = () => cursorPoint;
  screenApi.getDisplayNearestPoint = () => activePointerDisplay;

  const shortcutWrites = [];
  const electron = {
    app,
    BrowserWindow: FakeBrowserWindow,
    Tray: FakeTray,
    Menu: {
      buildFromTemplate: (template) =>
        template.map((item) => ({
          ...item,
          submenu: item.submenu?.map((submenuItem) =>
            submenuItem.role === "quit" && !submenuItem.click
              ? { ...submenuItem, click: () => app.quit() }
              : submenuItem,
          ),
        })),
      setApplicationMenu: (menu) => applicationMenus.push(menu),
    },
    nativeImage: {
      createFromDataURL: (dataUrl) => {
        const image = { dataUrl, template: false };
        legacyIcons.push(image);
        return image;
      },
      createEmpty: () => {
        const image = {
          representations: [],
          template: false,
          addRepresentation(options) {
            this.representations.push(options);
          },
          setTemplateImage(template) {
            this.template = template;
          },
        };
        templateIcons.push(image);
        return image;
      },
    },
    screen: screenApi,
    shell: {
      openExternal: (url) => {
        openedUrls.push(url);
      },
      writeShortcutLink: (shortcutPath, opts) => {
        shortcutWrites.push({ path: shortcutPath, opts });
        return true;
      },
    },
    ipcMain: {
      handle: (channel, handler) => ipcHandlers.set(channel, handler),
    },
    dialog: { showErrorBox: () => {} },
  };
  const launchModule = {
    DEFAULT_HOST: "127.0.0.1",
    DEFAULT_PORT: 4321,
    SERVER_LOG: "/tmp/server.log",
    ensureUsageServer: async () => serverResult,
    fetchHealth: async (host, port) => {
      healthCalls.push({ host, port });
      return { ok: true, fixture: false };
    },
  };

  const originalLoad = Module._load;
  let mainModule;
  Module._load = function load(request, parent, isMain) {
    if (request === "electron") return electron;
    if (parent?.filename === mainPath && request === "./server-launch.cjs") return launchModule;
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[mainPath];
  try {
    mainModule = require(mainPath);
  } finally {
    Module._load = originalLoad;
    delete require.cache[mainPath];
  }
  assert.equal(typeof mainModule.runWidgetMain, "function");
  mainModule.runWidgetMain({ electron, serverLaunch: launchModule, platform });
  await new Promise((resolve) => setImmediate(resolve));

  return {
    app,
    ipcHandlers,
    windows,
    trays,
    openedUrls,
    shortcutWrites,
    healthCalls,
    legacyIcons,
    templateIcons,
    applicationMenus,
    screen: screenApi,
    setCursorPoint: (point) => {
      cursorPoint = point;
    },
    setPointerDisplay: (display) => {
      activePointerDisplay = display;
    },
  };
}

test("Darwin platform policy uses pointer display and native utility behavior", () => {
  const cursorPoint = { x: 2500, y: 400 };
  const pointerDisplay = { workArea: { x: 1920, y: 24, width: 1440, height: 876 } };
  let nearestPoint = null;
  const policy = getPlatformPolicy("darwin");
  const display = selectDisplay(policy, {
    getCursorScreenPoint: () => cursorPoint,
    getDisplayNearestPoint: (point) => {
      nearestPoint = point;
      return pointerDisplay;
    },
    getPrimaryDisplay: () => assert.fail("Darwin must select the display containing the pointer"),
  });

  assert.deepEqual(nearestPoint, cursorPoint);
  assert.equal(display, pointerDisplay);
  assert.deepEqual(calculateCornerBounds(display.workArea, policy), {
    x: 3024,
    y: 712,
    width: 320,
    height: 172,
  });
  assert.deepEqual(policy, {
    platform: "darwin",
    displaySelection: "cursor",
    width: 320,
    height: 172,
    margin: 16,
    windowLevel: "floating",
    visibleOnAllWorkspaces: true,
    visibleOnFullScreen: false,
    nativeClose: "quit",
    hideDock: true,
    activationPolicy: "accessory",
    trayIcon: "template",
  });
});

test("Win32 platform policy preserves primary-display 320x172 widget behavior", () => {
  const primaryDisplay = { workArea: { x: 0, y: 0, width: 1920, height: 1080 } };
  const policy = getPlatformPolicy("win32");
  const display = selectDisplay(policy, {
    getCursorScreenPoint: () => assert.fail("Win32 must retain primary-display placement"),
    getDisplayNearestPoint: () => assert.fail("Win32 must retain primary-display placement"),
    getPrimaryDisplay: () => primaryDisplay,
  });

  assert.equal(display, primaryDisplay);
  assert.deepEqual(calculateCornerBounds(display.workArea, policy), {
    x: 1584,
    y: 892,
    width: 320,
    height: 172,
  });
  assert.deepEqual(policy, {
    platform: "win32",
    displaySelection: "primary",
    width: 320,
    height: 172,
    margin: 16,
    windowLevel: "screen-saver",
    visibleOnAllWorkspaces: true,
    visibleOnFullScreen: true,
    nativeClose: "hide",
    hideDock: false,
    activationPolicy: null,
    trayIcon: "legacy",
  });
});

test("macOS tray template assets provide 1x and 2x PNG representations", () => {
  const assets = [
    { name: "trayTemplate.png", width: 16, height: 16 },
    { name: "trayTemplate@2x.png", width: 32, height: 32 },
  ];

  for (const asset of assets) {
    const bytes = fs.readFileSync(path.join(__dirname, "..", "desktop", "assets", asset.name));
    assert.equal(bytes.subarray(1, 4).toString("ascii"), "PNG");
    assert.equal(bytes.readUInt32BE(16), asset.width);
    assert.equal(bytes.readUInt32BE(20), asset.height);
  }
});

test("resolveNodeBinary never returns electron.exe", () => {
  const bin = resolveNodeBinary(process.env);
  const base = path.basename(bin).toLowerCase();
  assert.notEqual(base, "electron.exe");
  assert.notEqual(base, "electron");
});

test("resolveNodeBinary prefers NODE_BINARY when it exists", () => {
  const node = resolveNodeBinary(process.env);
  // If we already resolved a real path, re-resolve with NODE_BINARY set to it.
  if (node.toLowerCase().endsWith("node.exe")) {
    const again = resolveNodeBinary({ ...process.env, NODE_BINARY: node });
    assert.equal(again, node);
  } else {
    assert.ok(node === "node" || node.toLowerCase().includes("node"));
  }
});

test("resolveNodeBinary uses injected Darwin filesystem and process inputs", () => {
  const nodeBin = resolveNodeBinary(
    { NODE_BINARY: "/opt/homebrew/bin/node" },
    {
      platform: "darwin",
      fs: { existsSync: (candidate) => candidate === "/opt/homebrew/bin/node" },
      execFileSync: () => assert.fail("Darwin must not invoke where.exe"),
      execPath: "/Applications/Electron.app/Contents/MacOS/Electron",
    },
  );

  assert.equal(nodeBin, "/opt/homebrew/bin/node");
});

test("assertNotElectronBinary throws for electron.exe", () => {
  assert.throws(() => assertNotElectronBinary("C:\\\\fake\\\\electron.exe"), /Refusing/);
  assert.doesNotThrow(() => assertNotElectronBinary("C:\\\\nvm4w\\\\nodejs\\\\node.exe"));
});

test("isLoopbackPortAvailable treats EACCES and EADDRINUSE as unavailable", async () => {
  function createListenErrorNet(code) {
    return {
      createServer() {
        const server = new EventEmitter();
        server.unref = () => {};
        server.listen = () => {
          queueMicrotask(() => {
            const err = Object.assign(new Error(code), { code });
            server.emit("error", err);
          });
        };
        return server;
      },
    };
  }

  assert.equal(await isLoopbackPortAvailable("127.0.0.1", 4321, createListenErrorNet("EACCES")), false);
  assert.equal(await isLoopbackPortAvailable("127.0.0.1", 4321, createListenErrorNet("EPERM")), false);
  assert.equal(await isLoopbackPortAvailable("127.0.0.1", 4321, createListenErrorNet("EADDRINUSE")), false);
});

test("buildEndpoint derives one base URL from the returned host and port", () => {
  assert.deepEqual(buildEndpoint("127.0.0.1", 6543), {
    host: "127.0.0.1",
    port: 6543,
    baseUrl: "http://127.0.0.1:6543",
  });
});

test("evidence runner targets the returned endpoint and resolves platform Electron binaries", async () => {
  const { evidenceElectronEnv, evidenceTarget, resolveInstalledElectron } = await import("../scripts/e2e-evidence.mjs");

  assert.deepEqual(
    evidenceTarget({ host: "127.0.0.1", port: 6543, baseUrl: "http://127.0.0.1:6543" }),
    {
      host: "127.0.0.1",
      port: 6543,
      healthUrl: "http://127.0.0.1:6543/api/health",
      usageUrl: "http://127.0.0.1:6543/api/usage",
      widgetUrl: "http://127.0.0.1:6543/widget.html",
    },
  );

  assert.deepEqual(
    evidenceElectronEnv({ host: "127.0.0.9", port: 6543 }, { KEEP: "yes", PORT: "4321" }),
    { KEEP: "yes", PORT: "6543", USAGE_HOST: "127.0.0.9" },
  );

  const cases = [
    { platform: "win32", root: "C:\\repo", expected: "C:\\repo\\node_modules\\electron\\dist\\electron.exe" },
    { platform: "darwin", root: "/repo", expected: "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" },
    { platform: "linux", root: "/repo", expected: "/repo/node_modules/electron/dist/electron" },
  ];
  for (const { platform, root, expected } of cases) {
    assert.equal(
      resolveInstalledElectron({
        platform,
        root,
        loadElectron: () => {
          throw new Error("package path unavailable");
        },
        existsSync: (candidate) => candidate === expected,
      }),
      expected,
    );
  }
});

test("allocateFreeLoopbackPort asks the OS for an ephemeral loopback port", async () => {
  const server = new EventEmitter();
  server.unref = () => {};
  server.listen = (port, host, callback) => {
    assert.equal(port, 0);
    assert.equal(host, "127.0.0.1");
    queueMicrotask(callback);
  };
  server.address = () => ({ address: "127.0.0.1", family: "IPv4", port: 6543 });
  server.close = (callback) => callback();

  const port = await allocateFreeLoopbackPort("127.0.0.1", {
    createServer: () => server,
  });

  assert.equal(port, 6543);
});

test("ensureUsageServer reuses a matching healthy server and returns its endpoint", async () => {
  const result = await ensureUsageServer({
    platform: "darwin",
    host: "127.0.0.1",
    port: 5432,
    logPath: "/tmp/reused-server.log",
    env: { USAGE_FIXTURE: "1" },
    fetchHealth: async () => ({ ok: true, fixture: true }),
  });

  assert.deepEqual(result, {
    proc: null,
    nodeBin: null,
    logPath: "/tmp/reused-server.log",
    reused: true,
    owned: false,
    endpoint: {
      host: "127.0.0.1",
      port: 5432,
      baseUrl: "http://127.0.0.1:5432",
    },
  });
});

test("ensureUsageServer preserves an unknown Darwin listener and starts on a free port", async () => {
  const child = createFakeChild();
  const healthCalls = [];
  let spawned;

  const result = await ensureUsageServer({
    platform: "darwin",
    host: "127.0.0.1",
    port: 4321,
    env: { USAGE_FIXTURE: "1" },
    maxAttempts: 1,
    fetchHealth: async (host, port) => {
      healthCalls.push({ host, port });
      if (healthCalls.length === 1) return null;
      return port === 6543 ? { ok: true, fixture: true } : null;
    },
    isPortAvailable: async () => false,
    allocateFreeLoopbackPort: async () => 6543,
    freePort: () => assert.fail("Darwin must not kill the preferred-port listener"),
    resolveNodeBinary: () => "/usr/bin/node",
    sleep: async () => {},
    fs: createFakeFileSystem(),
    spawn: (nodeBin, args, options) => {
      spawned = { nodeBin, args, options };
      return child;
    },
  });

  assert.equal(result.reused, false);
  assert.equal(result.owned, true);
  assert.equal(result.proc, child);
  assert.deepEqual(result.endpoint, {
    host: "127.0.0.1",
    port: 6543,
    baseUrl: "http://127.0.0.1:6543",
  });
  assert.equal(spawned.options.env.PORT, "6543");
  assert.deepEqual(healthCalls, [
    { host: "127.0.0.1", port: 4321 },
    { host: "127.0.0.1", port: 6543 },
  ]);
});

test("ensureUsageServer preserves a fixture-mismatched Darwin listener", async () => {
  const child = createFakeChild();
  const healthCalls = [];
  const freedPorts = [];

  const result = await ensureUsageServer({
    platform: "darwin",
    host: "127.0.0.1",
    port: 4321,
    env: { USAGE_FIXTURE: "1" },
    maxAttempts: 1,
    fetchHealth: async (host, port) => {
      healthCalls.push({ host, port });
      return healthCalls.length === 1
        ? { ok: true, fixture: false }
        : { ok: true, fixture: true };
    },
    isPortAvailable: () => assert.fail("a healthy mismatch is already known to occupy the port"),
    allocateFreeLoopbackPort: async () => 6544,
    freePort: (port) => freedPorts.push(port),
    resolveNodeBinary: () => "/usr/bin/node",
    sleep: async () => {},
    fs: createFakeFileSystem(),
    spawn: () => child,
  });

  assert.deepEqual(freedPorts, []);
  assert.equal(result.owned, true);
  assert.deepEqual(result.endpoint, {
    host: "127.0.0.1",
    port: 6544,
    baseUrl: "http://127.0.0.1:6544",
  });
  assert.deepEqual(healthCalls, [
    { host: "127.0.0.1", port: 4321 },
    { host: "127.0.0.1", port: 6544 },
  ]);
});

test("ensureUsageServer preserves Windows mode-mismatch replacement on the preferred port", async () => {
  const child = createFakeChild();
  const healthCalls = [];
  const freedPorts = [];
  let spawnedPort;

  const result = await ensureUsageServer({
    platform: "win32",
    host: "127.0.0.1",
    port: 4321,
    env: { USAGE_FIXTURE: "1" },
    maxAttempts: 1,
    fetchHealth: async (host, port) => {
      healthCalls.push({ host, port });
      return healthCalls.length === 1
        ? { ok: true, fixture: false }
        : { ok: true, fixture: true };
    },
    isPortAvailable: () => assert.fail("Windows mode mismatch must retain its existing replacement path"),
    allocateFreeLoopbackPort: () => assert.fail("Windows must retain the configured port"),
    freePort: (port) => freedPorts.push(port),
    resolveNodeBinary: () => "C:\\nvm4w\\nodejs\\node.exe",
    sleep: async () => {},
    fs: createFakeFileSystem(),
    spawn: (_nodeBin, _args, options) => {
      spawnedPort = options.env.PORT;
      return child;
    },
  });

  assert.deepEqual(freedPorts, [4321]);
  assert.equal(spawnedPort, "4321");
  assert.equal(result.owned, true);
  assert.deepEqual(result.endpoint, {
    host: "127.0.0.1",
    port: 4321,
    baseUrl: "http://127.0.0.1:4321",
  });
  assert.deepEqual(healthCalls, [
    { host: "127.0.0.1", port: 4321 },
    { host: "127.0.0.1", port: 4321 },
  ]);
});

test("ensureUsageServer picks a free Windows loopback port when 4321 is excluded (EACCES)", async () => {
  const child = createFakeChild();
  const healthCalls = [];
  const freedPorts = [];
  let spawnedPort;

  const result = await ensureUsageServer({
    platform: "win32",
    host: "127.0.0.1",
    port: 4321,
    env: {},
    maxAttempts: 1,
    fetchHealth: async (host, port) => {
      healthCalls.push({ host, port });
      if (port === 8877) return { ok: true, fixture: false };
      return null;
    },
    isPortAvailable: async () => false,
    allocateFreeLoopbackPort: async () => 8877,
    freePort: (port) => freedPorts.push(port),
    resolveNodeBinary: () => "C:\\nvm4w\\nodejs\\node.exe",
    sleep: async () => {},
    fs: createFakeFileSystem(),
    spawn: (_nodeBin, _args, options) => {
      spawnedPort = options.env.PORT;
      return child;
    },
  });

  assert.deepEqual(freedPorts, []);
  assert.equal(spawnedPort, "8877");
  assert.equal(result.owned, true);
  assert.deepEqual(result.endpoint, {
    host: "127.0.0.1",
    port: 8877,
    baseUrl: "http://127.0.0.1:8877",
  });
  assert.deepEqual(healthCalls, [
    { host: "127.0.0.1", port: 4321 },
    { host: "127.0.0.1", port: 8877 },
  ]);
});

test("Darwin main applies menu-bar utility policy and reanchors every restore path", async () => {
  const harness = await loadMainHarness(
    {
      proc: null,
      nodeBin: null,
      logPath: "/tmp/server.log",
      reused: true,
      owned: false,
      endpoint: {
        host: "127.0.0.1",
        port: 4321,
        baseUrl: "http://127.0.0.1:4321",
      },
    },
    { platform: "darwin" },
  );
  const window = harness.windows[0];
  const boundsFor = (workArea) => ({
    x: workArea.x + workArea.width - 336,
    y: workArea.y + workArea.height - 188,
    width: 320,
    height: 172,
  });

  assert.deepEqual(harness.app.activationPolicies, ["accessory"]);
  assert.equal(harness.app.dock.hideCalls, 1);
  assert.deepEqual(harness.shortcutWrites, []);
  assert.deepEqual(window.options, {
    x: 3024,
    y: 712,
    width: 320,
    height: 172,
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
    webPreferences: {
      preload: path.join(__dirname, "..", "desktop", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  assert.deepEqual(window.alwaysOnTopCalls, [[true, "floating"]]);
  assert.deepEqual(window.workspaceCalls, [[true, { visibleOnFullScreen: false }]]);
  assert.equal(harness.legacyIcons.length, 0);
  assert.equal(harness.templateIcons.length, 1);
  assert.equal(harness.templateIcons[0].template, true);
  assert.deepEqual(
    harness.templateIcons[0].representations.map(({ scaleFactor }) => scaleFactor),
    [1, 2],
  );
  assert.equal(harness.trays[0].icon, harness.templateIcons[0]);

  const initialRestoreArea = { x: -1600, y: 25, width: 1600, height: 975 };
  harness.setPointerDisplay({ workArea: initialRestoreArea });
  window.emit("ready-to-show");
  assert.deepEqual(window.boundsCalls.at(-1), boundsFor(initialRestoreArea));
  assert.equal(window.showInactiveCalls, 1);

  const showItem = harness.trays[0].menu.find((item) => item.label === "Show widget");
  const menuRestoreArea = { x: 0, y: 24, width: 1512, height: 958 };
  harness.setPointerDisplay({ workArea: menuRestoreArea });
  showItem.click();
  assert.deepEqual(window.boundsCalls.at(-1), boundsFor(menuRestoreArea));

  harness.trays[0].emit("click");
  assert.equal(window.isVisible(), false);
  const trayRestoreArea = { x: 1512, y: 0, width: 1920, height: 1080 };
  harness.setPointerDisplay({ workArea: trayRestoreArea });
  harness.trays[0].emit("click");
  assert.deepEqual(window.boundsCalls.at(-1), boundsFor(trayRestoreArea));

  const secondInstanceArea = { x: 0, y: 38, width: 1728, height: 1079 };
  harness.setPointerDisplay({ workArea: secondInstanceArea });
  harness.app.emit("second-instance");
  assert.deepEqual(window.boundsCalls.at(-1), boundsFor(secondInstanceArea));

  for (const [eventName, workArea] of [
    ["display-added", { x: 1728, y: 0, width: 2560, height: 1440 }],
    ["display-removed", { x: 0, y: 24, width: 1440, height: 876 }],
    ["display-metrics-changed", { x: -1920, y: 0, width: 1920, height: 1050 }],
  ]) {
    harness.setPointerDisplay({ workArea });
    harness.screen.emit(eventName);
    assert.deepEqual(window.boundsCalls.at(-1), boundsFor(workArea));
  }
});

test("Darwin application menu routes Command-Q through native quit cleanup once", async () => {
  const child = createFakeChild();
  const harness = await loadMainHarness(
    {
      proc: child,
      nodeBin: "/usr/bin/node",
      logPath: "/tmp/server.log",
      reused: false,
      owned: true,
      endpoint: {
        host: "127.0.0.1",
        port: 6543,
        baseUrl: "http://127.0.0.1:6543",
      },
    },
    { platform: "darwin" },
  );

  assert.equal(harness.applicationMenus.length, 1);
  const appMenu = harness.applicationMenus[0][0];
  const commandQItem = appMenu.submenu.find((item) => item.role === "quit");
  assert.equal(commandQItem.accelerator, "Command+Q");
  commandQItem.click();
  harness.app.emit("before-quit");

  assert.equal(harness.app.quitCalls, 1);
  assert.equal(child.killCalls, 1);
});

test("Darwin hide remains restorable while every exit route cleans up once", async () => {
  function ownedServerResult(child) {
    return {
      proc: child,
      nodeBin: "/usr/bin/node",
      logPath: "/tmp/server.log",
      reused: false,
      owned: true,
      endpoint: {
        host: "127.0.0.1",
        port: 6543,
        baseUrl: "http://127.0.0.1:6543",
      },
    };
  }

  const hiddenChild = createFakeChild();
  const hiddenHarness = await loadMainHarness(ownedServerResult(hiddenChild), { platform: "darwin" });
  const hiddenWindow = hiddenHarness.windows[0];
  hiddenWindow.emit("ready-to-show");
  hiddenHarness.ipcHandlers.get("widget:close")();
  assert.equal(hiddenWindow.isVisible(), false);
  assert.equal(hiddenHarness.app.quitCalls, 0);
  assert.equal(hiddenChild.killCalls, 0);
  hiddenHarness.trays[0].emit("click");
  assert.equal(hiddenWindow.isVisible(), true);
  hiddenHarness.trays[0].menu.find((item) => item.label === "Quit").click();
  hiddenHarness.app.emit("before-quit");
  assert.equal(hiddenChild.killCalls, 1);

  const exitRoutes = [
    {
      name: "custom x",
      run: (harness) => harness.ipcHandlers.get("widget:quit")(),
      expectedQuitCalls: 1,
    },
    {
      name: "native close",
      run: (harness) => {
        let prevented = false;
        harness.windows[0].emit("close", { preventDefault: () => (prevented = true) });
        assert.equal(prevented, false);
      },
      expectedQuitCalls: 1,
    },
    {
      name: "menu Quit",
      run: (harness) => harness.trays[0].menu.find((item) => item.label === "Quit").click(),
      expectedQuitCalls: 1,
    },
    {
      name: "Command-Q",
      run: (harness) => harness.app.emit("before-quit"),
      expectedQuitCalls: 0,
    },
  ];

  for (const route of exitRoutes) {
    const child = createFakeChild();
    const harness = await loadMainHarness(ownedServerResult(child), { platform: "darwin" });
    route.run(harness);
    harness.app.emit("before-quit");
    assert.equal(harness.app.quitCalls, route.expectedQuitCalls, route.name);
    assert.equal(child.killCalls, 1, route.name);
  }
});

test("Win32 main preserves tray, primary placement, Spaces, and native close-to-hide", async () => {
  const child = createFakeChild();
  const harness = await loadMainHarness(
    {
      proc: child,
      nodeBin: "C:\\nodejs\\node.exe",
      logPath: "C:\\temp\\server.log",
      reused: false,
      owned: true,
      endpoint: {
        host: "127.0.0.1",
        port: 4321,
        baseUrl: "http://127.0.0.1:4321",
      },
    },
    { platform: "win32" },
  );
  const window = harness.windows[0];

  assert.deepEqual(harness.app.activationPolicies, []);
  assert.equal(harness.app.dock.hideCalls, 0);
  assert.equal(harness.applicationMenus.length, 0);
  assert.deepEqual(
    { x: window.options.x, y: window.options.y, width: window.options.width, height: window.options.height },
    { x: 1584, y: 892, width: 320, height: 172 },
  );
  assert.deepEqual(window.alwaysOnTopCalls, [[true, "screen-saver"]]);
  assert.deepEqual(window.workspaceCalls, [[true, { visibleOnFullScreen: true }]]);
  assert.equal(harness.legacyIcons.length, 1);
  assert.equal(harness.templateIcons.length, 0);
  assert.equal(harness.trays[0].icon, harness.legacyIcons[0]);
  assert.equal(harness.shortcutWrites.length, 1);
  assert.match(harness.shortcutWrites[0].path, /Start Menu\\Programs\\Token Usage Widget\.lnk$/);
  assert.match(harness.shortcutWrites[0].opts.target, /start-widget\.cmd$/);
  assert.match(harness.shortcutWrites[0].opts.icon, /icon\.ico$/);
  assert.equal(harness.shortcutWrites[0].opts.appUserModelId, "com.token-usage.widget");

  window.emit("ready-to-show");
  let prevented = false;
  window.emit("close", { preventDefault: () => (prevented = true) });
  assert.equal(prevented, true);
  assert.equal(window.isVisible(), false);
  assert.equal(harness.app.quitCalls, 0);
  assert.equal(child.killCalls, 0);

  harness.setPointerDisplay({ workArea: { x: 1920, y: 0, width: 2560, height: 1440 } });
  harness.trays[0].emit("click");
  assert.deepEqual(window.boundsCalls.at(-1), { x: 1584, y: 892, width: 320, height: 172 });
  harness.ipcHandlers.get("widget:quit")();
  assert.equal(harness.app.quitCalls, 1);
  assert.equal(child.killCalls, 1);
});

test("desktop main ignores second-instance until endpoint startup is ready", async () => {
  let resolveServer;
  const serverResult = new Promise((resolve) => {
    resolveServer = resolve;
  });
  const harness = await loadMainHarness(serverResult);

  assert.doesNotThrow(() => harness.app.emit("second-instance"));
  assert.equal(harness.windows.length, 0);

  resolveServer({
    proc: null,
    nodeBin: null,
    logPath: "/tmp/server.log",
    reused: true,
    owned: false,
    endpoint: {
      host: "127.0.0.1",
      port: 4321,
      baseUrl: "http://127.0.0.1:4321",
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.windows.length, 1);
  assert.equal(harness.windows[0].loadedUrl, "http://127.0.0.1:4321/widget.html");
});

test("desktop main uses one returned endpoint and stops its owned child on quit", async () => {
  const child = createFakeChild();
  const harness = await loadMainHarness({
    proc: child,
    nodeBin: "/usr/bin/node",
    logPath: "/tmp/server.log",
    reused: false,
    owned: true,
    endpoint: {
      host: "127.0.0.1",
      port: 6543,
      baseUrl: "http://127.0.0.1:6543",
    },
  });

  assert.deepEqual(harness.healthCalls, [{ host: "127.0.0.1", port: 6543 }]);
  assert.equal(harness.windows[0].loadedUrl, "http://127.0.0.1:6543/widget.html");

  const dashboardItem = harness.trays[0].menu.find((item) => item.label === "Open full dashboard");
  dashboardItem.click();
  harness.ipcHandlers.get("widget:open-dashboard")();
  assert.deepEqual(harness.openedUrls, [
    "http://127.0.0.1:6543/",
    "http://127.0.0.1:6543/",
  ]);

  harness.app.emit("before-quit");
  assert.equal(child.killed, true);
});

test("desktop main never stops a child it does not own", async () => {
  const child = createFakeChild();
  const harness = await loadMainHarness({
    proc: child,
    nodeBin: "/usr/bin/node",
    logPath: "/tmp/server.log",
    reused: true,
    owned: false,
    endpoint: {
      host: "127.0.0.1",
      port: 4321,
      baseUrl: "http://127.0.0.1:4321",
    },
  });

  harness.app.emit("before-quit");
  assert.equal(child.killed, false);
});

test("ensureUsageServer waits for its spawned child to exit when startup readiness fails", async () => {
  const child = createFakeChild();
  let exited = false;
  child.kill = () => {
    child.killed = true;
    setImmediate(() => {
      exited = true;
      child.emit("exit", 0);
    });
  };
  let healthChecks = 0;

  await assert.rejects(
    ensureUsageServer({
      platform: "darwin",
      host: "127.0.0.1",
      port: 4321,
      maxAttempts: 1,
      fetchHealth: async () => {
        healthChecks += 1;
        return null;
      },
      isPortAvailable: async () => true,
      resolveNodeBinary: () => "/usr/bin/node",
      sleep: async () => {},
      fs: createFakeFileSystem(),
      spawn: () => child,
    }),
    /did not become ready on http:\/\/127\.0\.0\.1:4321/,
  );

  assert.equal(healthChecks, 2);
  assert.equal(child.killed, true);
  assert.equal(exited, true);
});

test("ensureUsageServer starts fixture server with real node (not electron)", async () => {
  const port = 18765;
  // Clean slate: if something is on this port, skip conflict by using unique port.
  assert.equal(await healthCheck("127.0.0.1", port, 500), false);

  const result = await ensureUsageServer({
    host: "127.0.0.1",
    port,
    env: { ...process.env, USAGE_FIXTURE: "1", USAGE_FIXTURE_ALL: "1", PORT: String(port) },
    maxAttempts: 60,
  });

  try {
    assert.equal(result.reused, false);
    assert.ok(result.nodeBin);
    assert.notEqual(path.basename(result.nodeBin).toLowerCase(), "electron.exe");
    assert.equal(await healthCheck("127.0.0.1", port), true);

    const res = await fetch(`http://127.0.0.1:${port}/api/usage`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.fixture, true);
    assert.equal(body.providers.length, 8);
    const ids = body.providers.map((p) => p.provider).sort();
    assert.deepEqual(ids, [
      "claude",
      "cursor",
      "grok",
      "kimi",
      "openai",
      "opencode",
      "openrouter",
      "zai",
    ]);
  } finally {
    if (result.proc && !result.proc.killed) result.proc.kill();
  }
});

test("ensureUsageServer restarts after the child process dies", async () => {
  // Distinct from e2e-smoke (18766) so parallel runs do not reuse that fixture server.
  const port = 28767;
  assert.equal(await healthCheck("127.0.0.1", port, 500), false);

  const first = await ensureUsageServer({
    host: "127.0.0.1",
    port,
    env: { ...process.env, USAGE_FIXTURE: "1", USAGE_FIXTURE_ALL: "1", PORT: String(port) },
    maxAttempts: 60,
  });
  assert.ok(first.proc);

  first.proc.kill();
  const deadAt = Date.now();
  while (await healthCheck("127.0.0.1", port, 400)) {
    if (Date.now() - deadAt > 10_000) assert.fail("server did not die after kill");
    await new Promise((r) => setTimeout(r, 200));
  }

  const second = await ensureUsageServer({
    host: "127.0.0.1",
    port,
    env: { ...process.env, USAGE_FIXTURE: "1", USAGE_FIXTURE_ALL: "1", PORT: String(port) },
    maxAttempts: 60,
  });

  try {
    assert.equal(second.reused, false);
    assert.ok(second.proc);
    assert.notEqual(second.proc.pid, first.proc.pid);
    assert.equal(await healthCheck("127.0.0.1", port), true);
  } finally {
    if (second.proc && !second.proc.killed) second.proc.kill();
  }
});
