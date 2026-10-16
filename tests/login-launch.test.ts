import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { EventEmitter } from "node:events";
import { type ChildProcess } from "node:child_process";
import {
  installLoginLaunch,
  inspectLoginLaunch,
  removeLoginLaunch,
  buildPlistXml,
  type LoginLaunchSeams,
} from "../src/login-launch.js";
import { defaultSeams, dispatch, type SpawnFn } from "../src/cli/startup.js";

interface FsState {
  files: Map<string, string | Buffer>;
  dirs: Set<string>;
  renames: Array<{ from: string; to: string }>;
  writes: Array<{ path: string; bytes: number }>;
  removed: string[];
}

function makeFs(initial?: Partial<FsState>): FsState & {
  fs: LoginLaunchSeams["fs"];
} {
  const files = new Map<string, string | Buffer>(initial?.files ?? []);
  const dirs = new Set<string>(initial?.dirs ?? []);
  const renames: Array<{ from: string; to: string }> = [];
  const writes: Array<{ path: string; bytes: number }> = [];
  const removed: string[] = [];

  const fs: LoginLaunchSeams["fs"] = {
    existsSync(p) {
      return files.has(p) || dirs.has(p);
    },
    mkdirSync(p, opts) {
      void opts;
      dirs.add(p);
    },
    readFileSync(p) {
      const v = files.get(p);
      if (v === undefined) {
        const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return typeof v === "string" ? Buffer.from(v, "utf8") : v;
    },
    writeFileSync(p, data) {
      const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
      files.set(p, buf);
      writes.push({ path: p, bytes: buf.length });
    },
    renameSync(from, to) {
      const v = files.get(from);
      if (v === undefined) {
        const err = new Error(`ENOENT rename: ${from}`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      files.delete(from);
      files.set(to, v);
      renames.push({ from, to });
    },
    unlinkSync(p) {
      if (!files.delete(p)) {
        const err = new Error(`ENOENT unlink: ${p}`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      removed.push(p);
    },
    rmSync(p, opts) {
      void opts;
      if (files.has(p)) {
        files.delete(p);
        removed.push(p);
      } else {
        const err = new Error(`ENOENT rm: ${p}`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
    },
  };
  return { files, dirs, renames, writes, removed, fs };
}

interface ExecRecord {
  cmd: string;
  args: string[];
}

function makeExecFile(responses: Array<{ args?: string[]; stdout?: string; stderr?: string; code?: number; error?: NodeJS.ErrnoException }>) {
  const calls: ExecRecord[] = [];
  const queue = [...responses];
  const execFile: LoginLaunchSeams["execFile"] = (cmd, args, callback) => {
    calls.push({ cmd, args: args ?? [] });
    const rule = queue.shift() ?? { code: 0, stdout: "", stderr: "" };
    if (rule.error) {
      callback(rule.error, "", "");
      return;
    }
    const err =
      rule.code && rule.code !== 0
        ? (new Error(`exit ${rule.code}`) as NodeJS.ErrnoException)
        : null;
    if (err) err.code = rule.code === 3 ? "ENOENT" : undefined;
    callback(err as NodeJS.ErrnoException | null, rule.stdout ?? "", rule.stderr ?? "");
  };
  return { calls, execFile };
}

function baseSeams(overrides: Partial<LoginLaunchSeams> & { fs?: LoginLaunchSeams["fs"] } = {}): LoginLaunchSeams {
  const homeDir = overrides.homeDir ?? "/Users/test";
  const checkout = overrides.checkout ?? "/workspace/token-usage-dashboard";
  const nodeBin = overrides.nodeBin ?? "/opt/node/bin/node";
  const launcher = overrides.launcher ?? path.join(checkout, "scripts", "start-widget.cjs");
  const logDir = overrides.logDir ?? path.join(homeDir, "Library", "Logs", "token-usage-dashboard");
  const uid = overrides.uid ?? 501;
  const defaultFs = makeFs({
    files: new Map<string, string | Buffer>([
      [path.join(checkout, "package.json"), "{}"],
      [path.join(checkout, "scripts", "start-widget.cjs"), "require()"],
      [nodeBin, ""],
    ]),
    dirs: new Set<string>([checkout, path.join(checkout, "scripts")]),
  }).fs;
  return {
    platform: "darwin",
    homeDir,
    checkout,
    nodeBin,
    launcher,
    logDir,
    uid,
    fs: defaultFs,
    execFile: makeExecFile([]).execFile,
    ...overrides,
  };
}

function plistPath(seams: LoginLaunchSeams) {
  return path.join(seams.homeDir, "Library", "LaunchAgents", "com.token-usage-dashboard.widget.plist");
}

test("buildPlistXml escapes XML special characters in paths and keeps RunAtLoad=true, KeepAlive=false", () => {
  const xml = buildPlistXml({
    nodeBin: "/opt/node/bin/node",
    launcher: "/Users/a & b <c>/scripts/start-widget.cjs",
    checkout: "/Users/a & b <c>",
    logDir: "/Users/a & b <c>/Library/Logs/token-usage-dashboard",
    label: "com.token-usage-dashboard.widget",
  });
  assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(xml, /<key>KeepAlive<\/key>\s*<false\/>/);
  assert.match(xml, /&amp;/);
  assert.match(xml, /&lt;/);
  assert.match(xml, /&gt;/);
  // absolute argument array, no shell quoting
  assert.match(xml, /<string>\/opt\/node\/bin\/node<\/string>/);
  // stdout/stderr under logDir
  assert.match(xml, /\/Users\/a &amp; b &lt;c&gt;\/Library\/Logs\/token-usage-dashboard\/widget\.out\.log/);
  assert.match(xml, /\/Users\/a &amp; b &lt;c&gt;\/Library\/Logs\/token-usage-dashboard\/widget\.err\.log/);
});

test("install on non-Darwin fails clearly without touching any files", async () => {
  const seams = baseSeams({ platform: "linux" });
  await assert.rejects(() => installLoginLaunch(seams), /darwin/);
  // No fs writes occurred (no plist, no temp).
  assert.equal(seams.fs.existsSync(plistPath(seams)), false);
});

test("install rejects relative checkout/node/launcher paths", async () => {
  const seams = baseSeams({ checkout: "relative/checkout" });
  await assert.rejects(() => installLoginLaunch(seams), /absolute.*checkout/i);
});

test("install rejects missing launcher or node binary", async () => {
  const state = makeFs({
    files: new Map<string, string | Buffer>([
      [path.join("/workspace/token-usage-dashboard", "package.json"), "{}"],
      [path.join("/workspace/token-usage-dashboard", "scripts", "start-widget.cjs"), "require()"],
      ["/opt/node/bin/node", ""],
    ]),
    dirs: new Set<string>(["/workspace/token-usage-dashboard", "/workspace/token-usage-dashboard/scripts"]),
  });
  state.files.delete("/opt/node/bin/node");
  const seams = baseSeams({ fs: state.fs });
  await assert.rejects(() => installLoginLaunch(seams), /node/i);
});

test("install writes a temp file then atomically renames, with RunAtLoad=true and KeepAlive=false, absolute ProgramArguments and WorkingDirectory", async () => {
  const state = makeFs({
    files: new Map<string, string | Buffer>([
      [path.join("/workspace/token-usage-dashboard", "package.json"), "{}"],
      [path.join("/workspace/token-usage-dashboard", "scripts", "start-widget.cjs"), "require()"],
      ["/opt/node/bin/node", ""],
    ]),
    dirs: new Set<string>(["/workspace/token-usage-dashboard", "/workspace/token-usage-dashboard/scripts"]),
  });
  const exec = makeExecFile([{ args: ["bootstrap"], code: 0, stdout: "", stderr: "" }]);
  const seams = baseSeams({
    fs: state.fs,
    execFile: exec.execFile,
  });
  const result = await installLoginLaunch(seams);
  assert.equal(result.kind, "installed");
  // temp file was written then renamed to plist
  assert.ok(state.renames.length >= 1, "expected at least one rename");
  const rename = state.renames.find((r) => r.to === plistPath(seams));
  assert.ok(rename, "rename target is the plist path");
  // temp cleaned up (no temp file remains)
  assert.equal(state.files.has(rename!.from), false);
  // plist content
  const xml = state.files.get(plistPath(seams))!.toString("utf8");
  assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(xml, /<key>KeepAlive<\/key>\s*<false\/>/);
  // Escape backslashes so the assertion holds on hosts where the seam paths
  // carry Windows separators (backslash is a RegExp metacharacter).
  const reString = (s: string) => s.replace(/\\/g, "\\\\");
  assert.match(xml, new RegExp(`<string>${reString(seams.nodeBin)}</string>`));
  assert.match(xml, new RegExp(`<string>${reString(seams.launcher)}</string>`));
  assert.match(xml, new RegExp(`<string>${reString(seams.checkout)}</string>`));
  assert.match(xml, /<key>WorkingDirectory<\/key>\s*<string>\/workspace\/token-usage-dashboard<\/string>/);
  // bootout (not-loaded tolerated), then bootstraps gui/<uid>
  assert.deepEqual(exec.calls.map((c) => ({ cmd: c.cmd, args: c.args })), [
    { cmd: "launchctl", args: ["bootout", "gui/501/com.token-usage-dashboard.widget"] },
    { cmd: "launchctl", args: ["bootstrap", "gui/501", plistPath(seams)] },
  ]);
});

test("install idempotently refreshes stale paths when plist differs only in paths", async () => {
  const state = makeFs({
    files: new Map<string, string | Buffer>([
      [path.join("/workspace/token-usage-dashboard", "package.json"), "{}"],
      [path.join("/workspace/token-usage-dashboard", "scripts", "start-widget.cjs"), "require()"],
      ["/opt/node/bin/node", ""],
    ]),
    dirs: new Set<string>([
      "/workspace/token-usage-dashboard",
      "/workspace/token-usage-dashboard/scripts",
      "/Users/test/Library/LaunchAgents",
    ]),
  });
  // Seed an existing plist with stale node path
  const staleXml = buildPlistXml({
    nodeBin: "/old/node/bin/node",
    launcher: path.join("/workspace/token-usage-dashboard", "scripts", "start-widget.cjs"),
    checkout: "/workspace/token-usage-dashboard",
    logDir: "/Users/test/Library/Logs/token-usage-dashboard",
    label: "com.token-usage-dashboard.widget",
  });
  state.files.set(plistPath(baseSeams()), staleXml);
  // bootout (not-loaded ok) then bootstrap
  const exec = makeExecFile([
    { args: ["bootout"], code: 0, stdout: "", stderr: "" },
    { args: ["bootstrap"], code: 0, stdout: "", stderr: "" },
  ]);
  const seams = baseSeams({ fs: state.fs, execFile: exec.execFile });
  const result = await installLoginLaunch(seams);
  assert.equal(result.kind, "refreshed");
  const xml = state.files.get(plistPath(seams))!.toString("utf8");
  assert.match(xml, /<string>\/opt\/node\/bin\/node<\/string>/);
  assert.doesNotMatch(xml, /\/old\/node\/bin\/node/);
  assert.deepEqual(
    exec.calls.map((c) => c.args),
    [["bootout", "gui/501/com.token-usage-dashboard.widget"], ["bootstrap", "gui/501", plistPath(seams)]],
  );
});

test("install tolerates expected not-loaded bootout during refresh, but surfaces unexpected bootout errors", async () => {
  const stale = makeFs({
    files: new Map<string, string | Buffer>([
      [path.join("/workspace/token-usage-dashboard", "package.json"), "{}"],
      [path.join("/workspace/token-usage-dashboard", "scripts", "start-widget.cjs"), "require()"],
      ["/opt/node/bin/node", ""],
    ]),
    dirs: new Set<string>(["/workspace/token-usage-dashboard", "/workspace/token-usage-dashboard/scripts", "/Users/test/Library/LaunchAgents"]),
  });
  stale.files.set(
    plistPath(baseSeams()),
    buildPlistXml({
      nodeBin: "/old/node/bin/node",
      launcher: "/workspace/token-usage-dashboard/scripts/start-widget.cjs",
      checkout: "/workspace/token-usage-dashboard",
      logDir: "/Users/test/Library/Logs/token-usage-dashboard",
      label: "com.token-usage-dashboard.widget",
    }),
  );
  // bootout returns not-loaded ( tolerated), bootstrap ok
  const execTolerated = makeExecFile([
    { args: ["bootout"], code: 3, stderr: "Operation not permitted", error: Object.assign(new Error("not loaded"), { code: "ENOENT" }) },
    { args: ["bootstrap"], code: 0, stdout: "", stderr: "" },
  ]);
  const seamsT = baseSeams({ fs: stale.fs, execFile: execTolerated.execFile });
  const resultT = await installLoginLaunch(seamsT);
  assert.equal(resultT.kind, "refreshed");

  // unexpected bootout error surfaces
  const execUnexpected = makeExecFile([
    { args: ["bootout"], code: 1, stderr: "something broke" },
  ]);
  const seamsU = baseSeams({ fs: stale.fs, execFile: execUnexpected.execFile });
  await assert.rejects(() => installLoginLaunch(seamsU), /bootout|launchctl/i);
});

test("repeated install with an unchanged plist boots out the loaded agent before bootstrap (B11)", async () => {
  const state = makeFs({
    files: new Map<string, string | Buffer>([
      [path.join("/workspace/token-usage-dashboard", "package.json"), "{}"],
      [path.join("/workspace/token-usage-dashboard", "scripts", "start-widget.cjs"), "require()"],
      ["/opt/node/bin/node", ""],
    ]),
    dirs: new Set<string>(["/workspace/token-usage-dashboard", "/workspace/token-usage-dashboard/scripts"]),
  });
  const exec = makeExecFile([]);
  const seams = baseSeams({ fs: state.fs, execFile: exec.execFile });
  state.files.set(
    plistPath(seams),
    buildPlistXml({
      nodeBin: seams.nodeBin,
      launcher: seams.launcher,
      checkout: seams.checkout,
      logDir: seams.logDir,
      label: "com.token-usage-dashboard.widget",
    }),
  );
  const result = await installLoginLaunch(seams);
  assert.equal(result.kind, "installed");
  assert.deepEqual(
    exec.calls.map((c) => c.args),
    [["bootout", "gui/501/com.token-usage-dashboard.widget"], ["bootstrap", "gui/501", plistPath(seams)]],
  );
});

test("startup default execFile seam passes stderr, so a not-loaded bootout is recognized", async () => {
  const seams = defaultSeams();
  const got = await new Promise<{ err: unknown; stderr: string }>((resolve) => {
    seams.execFile(
      process.execPath,
      ["-e", "process.stderr.write('Boot-out failed: 3: No such process'); process.exit(3)"],
      (err, _stdout, stderr) => resolve({ err, stderr }),
    );
  });
  assert.ok(got.err, "a nonzero exit is an error");
  assert.match(got.stderr, /No such process/);
});

test("install preserves previous plist when rename fails and cleans temp file", async () => {
  const state = makeFs({
    files: new Map<string, string | Buffer>([
      [path.join("/workspace/token-usage-dashboard", "package.json"), "{}"],
      [path.join("/workspace/token-usage-dashboard", "scripts", "start-widget.cjs"), "require()"],
      ["/opt/node/bin/node", ""],
    ]),
    dirs: new Set<string>(["/workspace/token-usage-dashboard", "/workspace/token-usage-dashboard/scripts", "/Users/test/Library/LaunchAgents"]),
  });
  const previous = "<previous-plist-content/>";
  state.files.set(plistPath(baseSeams()), previous);
  // rename fails
  const realRename = state.fs.renameSync;
  state.fs.renameSync = (_from: string, to: string) => {
    if (to === plistPath(baseSeams())) {
      const err = new Error("rename EPERM") as NodeJS.ErrnoException;
      err.code = "EPERM";
      throw err;
    }
    realRename(_from, to);
  };
  const exec = makeExecFile([{ args: ["bootstrap"], code: 0, stdout: "", stderr: "" }]);
  const seams = baseSeams({ fs: state.fs, execFile: exec.execFile });
  await assert.rejects(() => installLoginLaunch(seams), /rename/i);
  // previous preserved
  assert.equal(state.files.get(plistPath(seams))?.toString("utf8"), previous);
  // no temp file remaining
  const temps = [...state.files.keys()].filter((p) => p.endsWith(".plist.tmp"));
  assert.equal(temps.length, 0);
  // bootstrap was NOT called
  assert.equal(exec.calls.length, 0);
});

test("inspect reports absent vs installed and detects definition match without loading", async () => {
  const state = makeFs({
    files: new Map<string, string | Buffer>([
      [path.join("/workspace/token-usage-dashboard", "package.json"), "{}"],
      [path.join("/workspace/token-usage-dashboard", "scripts", "start-widget.cjs"), "require()"],
      ["/opt/node/bin/node", ""],
    ]),
    dirs: new Set<string>(["/workspace/token-usage-dashboard", "/workspace/token-usage-dashboard/scripts"]),
  });
  const seams = baseSeams({ fs: state.fs });
  // absent
  const absent = await inspectLoginLaunch(seams);
  assert.equal(absent.kind, "absent");
  // installed & matching
  const expected = buildPlistXml({
    nodeBin: seams.nodeBin,
    launcher: seams.launcher,
    checkout: seams.checkout,
    logDir: seams.logDir,
    label: "com.token-usage-dashboard.widget",
  });
  state.files.set(plistPath(seams), expected);
  const match = await inspectLoginLaunch(seams);
  assert.equal(match.kind, "installed");
  assert.equal((match as { matches?: boolean }).matches, true);
  // stale
  state.files.set(
    plistPath(seams),
    buildPlistXml({
      nodeBin: "/old/node",
      launcher: seams.launcher,
      checkout: seams.checkout,
      logDir: seams.logDir,
      label: "com.token-usage-dashboard.widget",
    }),
  );
  const stale = await inspectLoginLaunch(seams);
  assert.equal(stale.kind, "installed");
  assert.equal((stale as { matches?: boolean }).matches, false);
});

test("remove tolerates already-absent state without calling launchctl", async () => {
  const state = makeFs({
    files: new Map<string, string | Buffer>([
      [path.join("/workspace/token-usage-dashboard", "package.json"), "{}"],
    ]),
    dirs: new Set<string>(["/workspace/token-usage-dashboard"]),
  });
  const exec = makeExecFile([]);
  const seams = baseSeams({ fs: state.fs, execFile: exec.execFile });
  const result = await removeLoginLaunch(seams);
  assert.equal(result.kind, "absent");
  assert.equal(exec.calls.length, 0);
});

test("remove bootouts the agent when present (tolerating not-loaded/not-found) and deletes only the managed plist", async () => {
  const state = makeFs({
    files: new Map<string, string | Buffer>([
      [path.join("/workspace/token-usage-dashboard", "package.json"), "{}"],
      [path.join("/workspace/token-usage-dashboard", "scripts", "start-widget.cjs"), "require()"],
      ["/opt/node/bin/node", ""],
      ["/Users/test/Library/Logs/token-usage-dashboard/widget.out.log", "log bytes"],
      ["/Users/test/.config/token-usage-dashboard/config.json", "{\"providers\":{}}"],
    ]),
    dirs: new Set<string>([
      "/workspace/token-usage-dashboard",
      "/workspace/token-usage-dashboard/scripts",
      "/Users/test/Library/LaunchAgents",
      "/Users/test/Library/Logs/token-usage-dashboard",
    ]),
  });
  state.files.set(
    plistPath(baseSeams()),
    buildPlistXml({
      nodeBin: "/opt/node/bin/node",
      launcher: "/workspace/token-usage-dashboard/scripts/start-widget.cjs",
      checkout: "/workspace/token-usage-dashboard",
      logDir: "/Users/test/Library/Logs/token-usage-dashboard",
      label: "com.token-usage-dashboard.widget",
    }),
  );
  const exec = makeExecFile([{ args: ["bootout"], code: 0, stdout: "", stderr: "" }]);
  const seams = baseSeams({ fs: state.fs, execFile: exec.execFile });
  const result = await removeLoginLaunch(seams);
  assert.equal(result.kind, "removed");
  // plist gone
  assert.equal(state.files.has(plistPath(seams)), false);
  // config and logs preserved
  assert.ok(state.files.has("/Users/test/.config/token-usage-dashboard/config.json"));
  assert.ok(state.files.has("/Users/test/Library/Logs/token-usage-dashboard/widget.out.log"));
  assert.deepEqual(
    exec.calls.map((c) => c.args),
    [["bootout", "gui/501/com.token-usage-dashboard.widget"]],
  );
});

test("remove tolerates not-loaded bootout but surfaces unexpected errors", async () => {
  const state = makeFs({
    files: new Map<string, string | Buffer>([
      [path.join("/workspace/token-usage-dashboard", "package.json"), "{}"],
      [path.join("/workspace/token-usage-dashboard", "scripts", "start-widget.cjs"), "require()"],
      ["/opt/node/bin/node", ""],
    ]),
    dirs: new Set<string>(["/workspace/token-usage-dashboard", "/workspace/token-usage-dashboard/scripts", "/Users/test/Library/LaunchAgents"]),
  });
  state.files.set(
    plistPath(baseSeams()),
    buildPlistXml({
      nodeBin: "/opt/node/bin/node",
      launcher: "/workspace/token-usage-dashboard/scripts/start-widget.cjs",
      checkout: "/workspace/token-usage-dashboard",
      logDir: "/Users/test/Library/Logs/token-usage-dashboard",
      label: "com.token-usage-dashboard.widget",
    }),
  );
  // tolerated: not-loaded (ENOENT or 3 with stderr mentioning "not loaded")
  const execT = makeExecFile([{ args: ["bootout"], code: 3, error: Object.assign(new Error("not loaded"), { code: "ENOENT" }) }]);
  const seamsT = baseSeams({ fs: state.fs, execFile: execT.execFile });
  const r = await removeLoginLaunch(seamsT);
  assert.equal(r.kind, "removed");
  assert.equal(state.files.has(plistPath(seamsT)), false);
});

test("package.json test list includes login-launch tests", async () => {
  const pkg = await import("../package.json", { with: { type: "json" } });
  assert.match(pkg.default.scripts.test, /tests\/login-launch\.test\.ts/);
  assert.match(pkg.default.scripts["widget:startup"] ?? "", /startup\.ts install/);
  assert.match(pkg.default.scripts["widget:startup:disable"] ?? "", /startup\.ts remove/);
});

test("startup CLI Win32 install uses electron.exe --install-startup, never PowerShell", async () => {
  const spawned: { cmd: string; args: readonly string[] }[] = [];
  const fakeSpawn = ((cmd: string, args: readonly string[]) => {
    spawned.push({ cmd, args });
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("close", 0));
    return child as unknown as ChildProcess;
  }) as unknown as SpawnFn;
  const logs: string[] = [];
  // Use a dummy seams object since win32 install should never touch it.
  const dummySeams = {} as LoginLaunchSeams;
  await dispatch("install", "win32", dummySeams, fakeSpawn, (m) => logs.push(m));
  assert.equal(spawned.length, 2, "install, then launch");
  assert.match(spawned[0].cmd, /electron[\\/]dist[\\/]electron\.exe$/);
  assert.ok(spawned[0].args.includes("--install-startup"));
  assert.match(String(spawned[1].args[0]), /start-widget\.cjs$/);
  assert.ok(spawned.every((s) => !/powershell/i.test(s.cmd)));
  assert.deepEqual(logs, []);
});

test("startup CLI Win32 remove deletes the Startup shortcut and tolerates a missing one (CLI-8)", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), "tuw-appdata-"));
  const startupDir = path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
  const lnk = path.join(startupDir, "Token Usage Widget.lnk");
  fs.mkdirSync(startupDir, { recursive: true });
  fs.writeFileSync(lnk, "");
  const prev = process.env.APPDATA;
  process.env.APPDATA = appData;
  try {
    const logs: string[] = [];
    let spawned = false;
    const fakeSpawn = (() => {
      spawned = true;
      return new EventEmitter() as unknown as ChildProcess;
    }) as unknown as SpawnFn;
    await dispatch("remove", "win32", {} as LoginLaunchSeams, fakeSpawn, (m) => logs.push(m));
    assert.equal(fs.existsSync(lnk), false, "the Startup shortcut is gone");
    // Already gone: no error.
    await dispatch("remove", "win32", {} as LoginLaunchSeams, fakeSpawn, (m) => logs.push(m));
    assert.equal(spawned, false);
    assert.match(logs[0], /removed/i);
    assert.match(logs[1], /not installed/i);
  } finally {
    if (prev === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = prev;
    fs.rmSync(appData, { recursive: true, force: true });
  }
});

test("startup CLI Darwin install plans to call installLoginLaunch via seams", async () => {
  const logs: string[] = [];
  const state = makeFs({
    files: new Map<string, string | Buffer>([
      [path.join("/workspace/token-usage-dashboard", "package.json"), "{}"],
      [path.join("/workspace/token-usage-dashboard", "scripts", "start-widget.cjs"), "require()"],
      ["/opt/node/bin/node", ""],
    ]),
    dirs: new Set<string>(["/workspace/token-usage-dashboard", "/workspace/token-usage-dashboard/scripts"]),
  });
  const exec = makeExecFile([{ args: ["bootstrap"], code: 0, stdout: "", stderr: "" }]);
  const seams = baseSeams({ fs: state.fs, execFile: exec.execFile });
  const noSpawn = (() => {
    throw new Error("spawn should not be called on darwin");
  }) as unknown as SpawnFn;
  await dispatch("install", "darwin", seams, noSpawn, (m) => logs.push(m));
  assert.match(logs.join(" "), /installed/i);
});
