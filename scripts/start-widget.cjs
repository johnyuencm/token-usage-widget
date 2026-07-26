"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function requirePath(fileSystem, filePath, label, remedy) {
  if (!fileSystem.existsSync(filePath)) {
    const nextStep = remedy ? `. ${remedy}` : "";
    throw new Error(`${label} not found at ${filePath}${nextStep}`);
  }
}

function resolveLaunchPlan({
  platform = process.platform,
  checkout = path.resolve(__dirname, ".."),
  nodeExecPath = process.execPath,
  env = process.env,
  fs: fileSystem = fs,
} = {}) {
  // Pass absolute checkouts through unchanged. path.resolve on a driveless
  // absolute path (e.g. "/workspace/x") prepends the host's drive prefix on
  // Windows (C:\workspace\x), corrupting simulated POSIX checkouts and
  // breaking the fs lookup against test fixtures.
  const checkoutPath = path.isAbsolute(checkout) ? checkout : path.resolve(checkout);
  requirePath(
    fileSystem,
    path.join(checkoutPath, "package.json"),
    "Invalid widget checkout: package.json",
  );

  if (platform === "win32") {
    const commandLauncher = path.join(checkoutPath, "scripts", "start-widget.cmd");
    requirePath(fileSystem, commandLauncher, "Windows widget launcher");
    // Do not pre-quote the path: Node's Windows spawn already quotes args with
    // spaces. Manual quotes become \"...\" and cmd.exe looks for a literal
    // '\"C:\...\start-widget.cmd\"' (not recognized).
    return {
      platform,
      command: env.ComSpec || env.COMSPEC || "cmd.exe",
      args: ["/d", "/s", "/c", commandLauncher],
      options: {
        cwd: checkoutPath,
        env: { ...env },
        detached: false,
        stdio: "inherit",
      },
      waitForExit: true,
    };
  }

  if (platform !== "darwin") {
    throw new Error(`Unsupported widget launch platform: ${platform}`);
  }

  requirePath(fileSystem, nodeExecPath, "Current Node executable");

  const electronRoot = path.join(checkoutPath, "node_modules", "electron");
  const installElectron = `Run npm install in ${checkoutPath} first.`;
  requirePath(
    fileSystem,
    path.join(electronRoot, "package.json"),
    "Local Electron dependency",
    installElectron,
  );
  const electronPathFile = path.join(electronRoot, "path.txt");
  requirePath(fileSystem, electronPathFile, "Local Electron path metadata", installElectron);
  const electronRelativePath = String(fileSystem.readFileSync(electronPathFile, "utf8")).trim();
  if (!electronRelativePath) {
    throw new Error(`Local Electron path metadata is empty at ${electronPathFile}`);
  }
  const electronExecutable = path.join(electronRoot, "dist", electronRelativePath);
  requirePath(fileSystem, electronExecutable, "Local Electron executable", installElectron);

  const launchEnv = { ...env, NODE_BINARY: nodeExecPath };
  delete launchEnv.USAGE_FIXTURE;

  return {
    platform,
    command: electronExecutable,
    args: [checkoutPath],
    options: {
      cwd: checkoutPath,
      env: launchEnv,
      detached: true,
      stdio: "ignore",
    },
  };
}

function spawnError(plan, error) {
  return new Error(`Failed to spawn widget from ${plan.command}: ${error.message}`, { cause: error });
}

function spawnLaunchPlan(plan, { spawn = childProcess.spawn } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(plan.command, plan.args, plan.options);
    } catch (error) {
      reject(spawnError(plan, error));
      return;
    }

    function removeLaunchListeners() {
      child.removeListener("error", onError);
      child.removeListener("spawn", onSpawn);
      child.removeListener("close", onClose);
    }

    function onError(error) {
      removeLaunchListeners();
      try {
        child.kill?.();
      } catch {
        // The failed child may never have reached an OS process.
      }
      reject(spawnError(plan, error));
    }

    function onClose(code, signal) {
      removeLaunchListeners();
      if (code === 0) {
        resolve(child);
        return;
      }
      const outcome = code === null ? `signal ${signal || "unknown"}` : `code ${code}`;
      reject(new Error(`Windows widget launcher exited with ${outcome}`));
    }

    function onSpawn() {
      if (plan.waitForExit) {
        return;
      }
      removeLaunchListeners();
      if (plan.options.detached) {
        child.unref();
      }
      resolve(child);
    }

    child.once("error", onError);
    child.once("spawn", onSpawn);
    if (plan.waitForExit) {
      child.once("close", onClose);
    }
  });
}

function launchWidget(options, dependencies) {
  return spawnLaunchPlan(resolveLaunchPlan(options), dependencies);
}

async function main() {
  await launchWidget();
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Widget launch failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { launchWidget, main, resolveLaunchPlan, spawnLaunchPlan };
