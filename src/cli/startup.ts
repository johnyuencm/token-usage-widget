/**
 * Cross-platform startup install/remove/status dispatcher for the widget.
 *
 *   node --import tsx src/cli/startup.ts install
 *   node --import tsx src/cli/startup.ts remove
 *   node --import tsx src/cli/startup.ts status
 *
 * - On darwin it uses src/login-launch.ts to manage a per-user LaunchAgent.
 * - On win32 `install` runs the checkout's electron.exe with `--install-startup`
 *   (Electron writes a Startup shortcut that targets electron.exe directly, so
 *   no cmd or PowerShell window opens at logon), then launches the widget.
 *   `remove` reports that the Startup shortcut is unmanaged by this command
 *   (it does not silently delete it).
 *
 * No provider config, credentials, cookies, or secrets are read or embedded.
 */
import path from "node:path";
import process from "node:process";
import { spawn as realSpawn, type ChildProcess } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import * as fs from "node:fs";
import {
  installLoginLaunch,
  inspectLoginLaunch,
  removeLoginLaunch,
  type LoginLaunchSeams,
} from "../login-launch.js";

type Command = "install" | "remove" | "status";

export type SpawnFn = (
  cmd: string,
  args: readonly string[],
  options?: { stdio?: "inherit" | "pipe" | "ignore" },
) => ChildProcess;

function parseCommand(arg: string | undefined): Command {
  if (arg === "install" || arg === "remove" || arg === "status") return arg;
  throw new Error(`Usage: npm run widget:startup -- [install|remove|status]`);
}

function checkoutRoot(): string {
  const here = new URL(".", import.meta.url);
  // src/cli/startup.ts -> ../../
  return path.resolve(fileURLToPath(here), "..", "..");
}

function defaultSeams(): LoginLaunchSeams {
  const checkout = checkoutRoot();
  return {
    platform: process.platform,
    homeDir: process.env.HOME ?? process.cwd(),
    checkout,
    nodeBin: process.execPath,
    launcher: path.join(checkout, "scripts", "start-widget.cjs"),
    logDir: path.join(process.env.HOME ?? process.cwd(), "Library", "Logs", "token-usage-dashboard"),
    uid: process.getuid?.() ?? 501,
    fs: realFs(),
    execFile: (cmd, args, cb) => {
      realSpawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] })
        .on("error", (err) => cb(err as NodeJS.ErrnoException, "", ""))
        .on("close", (code) =>
          cb(code === 0 ? null : (new Error(`exit ${code}`) as NodeJS.ErrnoException), "", ""),
        );
    },
  };
}

function realFs(): LoginLaunchSeams["fs"] {
  return {
    existsSync: fs.existsSync,
    mkdirSync: fs.mkdirSync,
    readFileSync: fs.readFileSync,
    writeFileSync: fs.writeFileSync,
    renameSync: fs.renameSync,
    unlinkSync: fs.unlinkSync,
    rmSync: fs.rmSync,
  };
}

function runToExit(spawnFn: SpawnFn, cmd: string, args: string[], what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawnFn(cmd, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${what} exited with code ${code}`));
    });
  });
}

async function runWin32InstallStartup(spawnFn: SpawnFn = realSpawn as SpawnFn): Promise<void> {
  const checkout = checkoutRoot();
  const electron = path.join(checkout, "node_modules", "electron", "dist", "electron.exe");
  await runToExit(spawnFn, electron, [checkout, "--install-startup"], "Electron --install-startup");
  await runToExit(spawnFn, process.execPath, [path.join(checkout, "scripts", "start-widget.cjs")], "Widget launch");
}

/** Testable dispatch. */
export async function dispatch(
  command: Command,
  platform: string,
  seams: LoginLaunchSeams,
  spawnFn: SpawnFn,
  log: (msg: string) => void,
): Promise<void> {
  if (platform === "win32") {
    if (command === "install") {
      await runWin32InstallStartup(spawnFn);
      return;
    }
    if (command === "remove") {
      log("Windows startup shortcut is not managed by this command. Remove it manually from Startup.");
      return;
    }
    if (command === "status") {
      log("Windows startup status is not introspected by this command.");
      return;
    }
  }

  if (platform === "darwin") {
    if (command === "install") {
      const result = await installLoginLaunch(seams);
      log(`Login launch ${result.kind}.`);
      return;
    }
    if (command === "remove") {
      const result = await removeLoginLaunch(seams);
      log(`Login launch ${result.kind}.`);
      return;
    }
    if (command === "status") {
      const result = await inspectLoginLaunch(seams);
      if (result.kind === "absent") {
        log("Login launch not installed.");
      } else {
        log(
          result.matches
            ? "Login launch installed and matches current checkout."
            : "Login launch installed but stale; rerun install to refresh.",
        );
      }
      return;
    }
  }

  throw new Error(`Startup command ${command} is not supported on platform ${platform}`);
}

async function main(argv: string[]): Promise<void> {
  const command = parseCommand(argv[0]);
  const seams = defaultSeams();
  await dispatch(command, seams.platform, seams, realSpawn as SpawnFn, (m) => console.log(m));
}

const invokedDirectly =
  typeof process !== "undefined" &&
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  const args = process.argv.slice(2);
  main(args).catch((err) => {
    console.error(`Startup failed: ${err.message}`);
    process.exitCode = 1;
  });
}

export { main, parseCommand, runWin32InstallStartup, defaultSeams };
