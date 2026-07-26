"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const {
  launchWidget,
  resolveLaunchPlan,
  spawnLaunchPlan,
} = require("../scripts/start-widget.cjs");
const packageJson = require("../package.json");

function createFileSystem(files) {
  const contents = new Map(Object.entries(files));
  return {
    existsSync(filePath) {
      return contents.has(filePath);
    },
    readFileSync(filePath) {
      if (!contents.has(filePath)) {
        throw new Error(`Unexpected read: ${filePath}`);
      }
      return contents.get(filePath);
    },
  };
}

test("the documented background npm command uses the platform dispatcher and runs its regression tests", () => {
  assert.equal(packageJson.scripts["widget:bg"], "node scripts/start-widget.cjs");
  assert.match(packageJson.scripts.test, /tests\/start-widget\.test\.cjs/);
});

test("Darwin launch planning uses checkout-local Electron and the current Node on Intel and Apple Silicon", () => {
  const checkout = "/workspace/token-usage-dashboard";
  const electronRoot = path.join(checkout, "node_modules", "electron");
  const electronRelativePath = "Electron.app/Contents/MacOS/Electron";
  const electronExecutable = path.join(electronRoot, "dist", electronRelativePath);
  const nodeExecPath = "/opt/current-node/bin/node";
  const fileSystem = createFileSystem({
    [path.join(checkout, "package.json")]: "{}",
    [path.join(electronRoot, "package.json")]: "{}",
    [path.join(electronRoot, "path.txt")]: `${electronRelativePath}\n`,
    [electronExecutable]: "",
    [nodeExecPath]: "",
  });
  const inputs = {
    platform: "darwin",
    checkout,
    nodeExecPath,
    env: { PATH: "/usr/bin", USAGE_FIXTURE: "1" },
    fs: fileSystem,
  };

  const intelPlan = resolveLaunchPlan({ ...inputs, arch: "x64" });
  const appleSiliconPlan = resolveLaunchPlan({ ...inputs, arch: "arm64" });

  assert.deepEqual(appleSiliconPlan, intelPlan);
  assert.equal(intelPlan.command, electronExecutable);
  assert.deepEqual(intelPlan.args, [checkout]);
  assert.equal(intelPlan.options.cwd, checkout);
  assert.equal(intelPlan.options.detached, true);
  assert.equal(intelPlan.options.stdio, "ignore");
  assert.equal(intelPlan.options.env.NODE_BINARY, nodeExecPath);
  assert.equal(intelPlan.options.env.PATH, "/usr/bin");
  assert.equal("USAGE_FIXTURE" in intelPlan.options.env, false);
});

test("the background launcher resolves and starts the checkout in one command", async () => {
  const checkout = "/workspace/token-usage-dashboard";
  const electronRoot = path.join(checkout, "node_modules", "electron");
  const electronRelativePath = "Electron.app/Contents/MacOS/Electron";
  const electronExecutable = path.join(electronRoot, "dist", electronRelativePath);
  const nodeExecPath = "/opt/current-node/bin/node";
  const fileSystem = createFileSystem({
    [path.join(checkout, "package.json")]: "{}",
    [path.join(electronRoot, "package.json")]: "{}",
    [path.join(electronRoot, "path.txt")]: electronRelativePath,
    [electronExecutable]: "",
    [nodeExecPath]: "",
  });
  const child = new EventEmitter();
  let unrefCount = 0;
  child.unref = () => {
    unrefCount += 1;
  };

  const launchedChild = await launchWidget(
    { platform: "darwin", checkout, nodeExecPath, env: {}, fs: fileSystem },
    {
      spawn() {
        queueMicrotask(() => child.emit("spawn"));
        return child;
      },
    },
  );

  assert.equal(launchedChild, child);
  assert.equal(unrefCount, 1);
});

test("Darwin launch rejects an invalid checkout with the exact missing package path", () => {
  const checkout = "/missing/token-usage-dashboard";
  const packagePath = path.join(checkout, "package.json");

  assert.throws(
    () => resolveLaunchPlan({
      platform: "darwin",
      checkout,
      nodeExecPath: "/opt/current-node/bin/node",
      env: {},
      fs: createFileSystem({}),
    }),
    { message: `Invalid widget checkout: package.json not found at ${packagePath}` },
  );
});

test("Darwin launch reports how to restore a missing checkout-local Electron dependency", () => {
  const checkout = "/workspace/token-usage-dashboard";
  const nodeExecPath = "/opt/current-node/bin/node";
  const electronPackagePath = path.join(checkout, "node_modules", "electron", "package.json");
  const fileSystem = createFileSystem({
    [path.join(checkout, "package.json")]: "{}",
    [nodeExecPath]: "",
  });

  assert.throws(
    () => resolveLaunchPlan({ platform: "darwin", checkout, nodeExecPath, env: {}, fs: fileSystem }),
    {
      message: `Local Electron dependency not found at ${electronPackagePath}. Run npm install in ${checkout} first.`,
    },
  );
});

test("Win32 planning delegates to the established CMD launcher from the checkout", () => {
  const checkout = "/workspace/token-usage-dashboard";
  const commandLauncher = path.join(checkout, "scripts", "start-widget.cmd");
  const comSpec = "C:\\Windows\\System32\\cmd.exe";
  const fileSystem = createFileSystem({
    [path.join(checkout, "package.json")]: "{}",
    [commandLauncher]: "",
  });

  const plan = resolveLaunchPlan({
    platform: "win32",
    checkout,
    env: { ComSpec: comSpec, USAGE_FIXTURE: "1" },
    fs: fileSystem,
  });

  assert.equal(plan.command, comSpec);
  assert.deepEqual(plan.args, ["/d", "/s", "/c", commandLauncher]);
  assert.equal(plan.options.cwd, checkout);
  assert.equal(plan.options.detached, false);
  assert.equal(plan.options.stdio, "inherit");
  assert.equal(plan.options.env.USAGE_FIXTURE, "1");
  assert.equal(plan.waitForExit, true);
});

test("Darwin launch detaches only after the child reports a successful spawn", async () => {
  const plan = {
    platform: "darwin",
    command: "/workspace/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    args: ["/workspace"],
    options: { cwd: "/workspace", detached: true, stdio: "ignore", env: {} },
  };
  const child = new EventEmitter();
  let unrefCount = 0;
  child.unref = () => {
    unrefCount += 1;
  };
  let spawnCall;

  const launch = spawnLaunchPlan(plan, {
    spawn(command, args, options) {
      spawnCall = { command, args, options };
      return child;
    },
  });

  assert.equal(unrefCount, 0);
  child.emit("spawn");
  assert.equal(await launch, child);
  assert.equal(unrefCount, 1);
  assert.deepEqual(spawnCall, {
    command: plan.command,
    args: plan.args,
    options: plan.options,
  });
});

test("Win32 dispatch waits for the CMD launcher and propagates its failure", async () => {
  const plan = {
    platform: "win32",
    command: "C:\\Windows\\System32\\cmd.exe",
    args: ["/d", "/s", "/c", "C:\\workspace\\scripts\\start-widget.cmd"],
    options: { cwd: "C:\\workspace", detached: false, stdio: "inherit", env: {} },
    waitForExit: true,
  };
  const child = new EventEmitter();
  child.kill = () => {};
  const launch = spawnLaunchPlan(plan, { spawn: () => child });

  child.emit("spawn");
  child.emit("close", 7, null);

  await assert.rejects(
    launch,
    { message: "Windows widget launcher exited with code 7" },
  );
});

test("Darwin spawn errors identify the executable and do not leave an unreferenced child", async () => {
  const plan = {
    platform: "darwin",
    command: "/workspace/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    args: ["/workspace"],
    options: { cwd: "/workspace", detached: true, stdio: "ignore", env: {} },
  };
  const child = new EventEmitter();
  let unrefCount = 0;
  let killCount = 0;
  child.unref = () => {
    unrefCount += 1;
  };
  child.kill = () => {
    killCount += 1;
  };
  const launch = spawnLaunchPlan(plan, { spawn: () => child });

  child.emit("error", new Error("operation not permitted"));

  await assert.rejects(
    launch,
    new RegExp(`Failed to spawn widget from ${plan.command.replaceAll("/", "\\/")}: operation not permitted`),
  );
  assert.equal(unrefCount, 0);
  assert.equal(killCount, 1);
});
