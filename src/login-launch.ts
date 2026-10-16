/**
 * Electron-free, reversible per-user macOS login launch for the widget.
 *
 * Installs/inspects/removes a LaunchAgent plist at
 *   ~/Library/LaunchAgents/com.token-usage-dashboard.widget.plist
 * that runs `node scripts/start-widget.cjs <checkout>` once at login
 * (RunAtLoad=true, KeepAlive=false). All side effects go through
 * injectable seams so behavior tests run without touching real files
 * or `launchctl`.
 */
import path from "node:path";
import { posix as posixPath } from "node:path";

export const MANAGED_LABEL = "com.token-usage-dashboard.widget";

/** Filesystem seam. */
export interface LoginLaunchFs {
  existsSync(p: string): boolean;
  mkdirSync(p: string, opts?: { recursive?: boolean }): void;
  readFileSync(p: string): Buffer;
  writeFileSync(p: string, data: string | Buffer): void;
  renameSync(from: string, to: string): void;
  unlinkSync(p: string): void;
  rmSync(p: string, opts?: { force?: boolean }): void;
}

/** execFile seam; matches Node's callback signature. */
export type LoginLaunchExecFile = (
  cmd: string,
  args: string[],
  callback: (err: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void,
) => void;

/** Injectable seams. */
export interface LoginLaunchSeams {
  platform: string;
  homeDir: string;
  checkout: string;
  nodeBin: string;
  launcher: string;
  logDir: string;
  uid: number;
  fs: LoginLaunchFs;
  execFile: LoginLaunchExecFile;
}

export type LoginLaunchResult =
  | { kind: "absent" }
  | { kind: "installed" }
  | { kind: "refreshed" }
  | { kind: "removed" };

export interface InspectResult {
  kind: "absent" | "installed";
  matches: boolean;
  plistPath: string;
}

interface PlistInputs {
  nodeBin: string;
  launcher: string;
  checkout: string;
  logDir: string;
  label: string;
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function buildPlistXml(inputs: PlistInputs): string {
  const { nodeBin, launcher, checkout, logDir, label } = inputs;
  // Log paths inside the plist are consumed by macOS launchd, so they are
  // always POSIX regardless of the host that generated the plist.
  const stdoutLog = posixPath.join(logDir, "widget.out.log");
  const stderrLog = posixPath.join(logDir, "widget.err.log");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${xmlEscape(label)}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${xmlEscape(nodeBin)}</string>
		<string>${xmlEscape(launcher)}</string>
		<string>${xmlEscape(checkout)}</string>
	</array>
	<key>WorkingDirectory</key>
	<string>${xmlEscape(checkout)}</string>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<false/>
	<key>StandardOutPath</key>
	<string>${xmlEscape(stdoutLog)}</string>
	<key>StandardErrorPath</key>
	<string>${xmlEscape(stderrLog)}</string>
</dict>
</plist>
`;
}

function plistPathFor(seams: LoginLaunchSeams): string {
  return path.join(seams.homeDir, "Library", "LaunchAgents", `${MANAGED_LABEL}.plist`);
}

function assertAbsolute(p: string, label: string): void {
  // Accept both POSIX-absolute ("/usr/...") and Win32-absolute ("\usr\...",
  // "C:\...") inputs so the same validation holds on every host without
  // weakening the absolute-path requirement.
  if (!path.posix.isAbsolute(p) && !path.win32.isAbsolute(p)) {
    throw new Error(`Expected absolute ${label}, got: ${p}`);
  }
}

function validateInputs(seams: LoginLaunchSeams): void {
  if (seams.platform !== "darwin") {
    throw new Error(`Login launch is only supported on darwin; got platform=${seams.platform}`);
  }
  assertAbsolute(seams.checkout, "checkout");
  assertAbsolute(seams.nodeBin, "node binary");
  assertAbsolute(seams.launcher, "launcher");
  if (!seams.fs.existsSync(seams.nodeBin)) {
    throw new Error(`Node executable not found at ${seams.nodeBin}`);
  }
  if (!seams.fs.existsSync(seams.launcher)) {
    throw new Error(`Widget launcher not found at ${seams.launcher}`);
  }
  if (!seams.fs.existsSync(path.join(seams.checkout, "package.json"))) {
    throw new Error(`Invalid checkout: package.json missing at ${seams.checkout}`);
  }
}

function ensureDirs(seams: LoginLaunchSeams, plistPath: string): void {
  seams.fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  seams.fs.mkdirSync(seams.logDir, { recursive: true });
}

function notLoadedLike(err: NodeJS.ErrnoException | null, stderr: string): boolean {
  if (!err) return false;
  if (err.code === "ENOENT") return true;
  const text = `${err.message} ${stderr}`.toLowerCase();
  return (
    text.includes("not loaded") ||
    text.includes("no such") ||
    text.includes("not found") ||
    text.includes("could not find")
  );
}

function execFileP(seams: LoginLaunchSeams, cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    seams.execFile(cmd, args, (err, stdout, stderr) => {
      if (err) {
        reject({ err, stdout, stderr });
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

/**
 * Bootout the existing agent, tolerating the expected "not loaded" outcome.
 * Rejects on any unexpected launchctl error. Use the service target
 * `gui/<uid>/<label>`: after `gui/<uid>`, launchctl reads a bare word as a plist path.
 */
async function bootoutAgent(seams: LoginLaunchSeams): Promise<void> {
  try {
    await execFileP(seams, "launchctl", ["bootout", `gui/${seams.uid}/${MANAGED_LABEL}`]);
  } catch (e) {
    const { err, stderr } = e as { err: NodeJS.ErrnoException; stderr: string };
    if (notLoadedLike(err, stderr)) return;
    const msg = err.message || stderr || "unknown launchctl error";
    throw new Error(`launchctl bootout failed: ${msg}`);
  }
}

export async function installLoginLaunch(seams: LoginLaunchSeams): Promise<LoginLaunchResult> {
  validateInputs(seams);
  const plistPath = plistPathFor(seams);
  ensureDirs(seams, plistPath);

  const expectedXml = buildPlistXml({
    nodeBin: seams.nodeBin,
    launcher: seams.launcher,
    checkout: seams.checkout,
    logDir: seams.logDir,
    label: MANAGED_LABEL,
  });

  const existing = seams.fs.existsSync(plistPath)
    ? seams.fs.readFileSync(plistPath).toString("utf8")
    : null;

  const needsRefresh = existing !== null && existing !== expectedXml;

  // Atomic write FIRST: temp file in same directory, then rename. If write or
  // rename fails, the previous plist and any loaded agent are untouched.
  const tmpPath = `${plistPath}.${process.pid}.tmp`;
  try {
    seams.fs.writeFileSync(tmpPath, expectedXml);
    seams.fs.renameSync(tmpPath, plistPath);
  } catch (err) {
    try {
      if (seams.fs.existsSync(tmpPath)) seams.fs.rmSync(tmpPath, { force: true });
    } catch {
      // Best-effort cleanup; the original error is what we surface.
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to write plist: ${msg}`);
  }

  // Plist is now the new definition. Always bootout first: bootstrap fails
  // when the agent is already loaded, also when the plist did not change.
  // not-loaded is tolerated (first install, or after a logout).
  await bootoutAgent(seams);

  // Bootstrap the new plist.
  try {
    await execFileP(seams, "launchctl", ["bootstrap", `gui/${seams.uid}`, plistPath]);
  } catch (e) {
    const { err, stderr } = e as { err: NodeJS.ErrnoException; stderr: string };
    const msg = err.message || stderr || "unknown launchctl error";
    throw new Error(`launchctl bootstrap failed: ${msg}`);
  }

  return needsRefresh ? { kind: "refreshed" } : { kind: "installed" };
}

export async function inspectLoginLaunch(seams: LoginLaunchSeams): Promise<InspectResult> {
  if (seams.platform !== "darwin") {
    throw new Error(`Login launch is only supported on darwin; got platform=${seams.platform}`);
  }
  const plistPath = plistPathFor(seams);
  if (!seams.fs.existsSync(plistPath)) {
    return { kind: "absent", matches: false, plistPath };
  }
  const existing = seams.fs.readFileSync(plistPath).toString("utf8");
  const expected = buildPlistXml({
    nodeBin: seams.nodeBin,
    launcher: seams.launcher,
    checkout: seams.checkout,
    logDir: seams.logDir,
    label: MANAGED_LABEL,
  });
  // Inspect never loads/unloads the agent, and never reads credentials.
  return { kind: "installed", matches: existing === expected, plistPath };
}

export async function removeLoginLaunch(seams: LoginLaunchSeams): Promise<LoginLaunchResult> {
  if (seams.platform !== "darwin") {
    throw new Error(`Login launch is only supported on darwin; got platform=${seams.platform}`);
  }
  const plistPath = plistPathFor(seams);
  if (!seams.fs.existsSync(plistPath)) {
    return { kind: "absent" };
  }
  await bootoutAgent(seams);
  try {
    seams.fs.rmSync(plistPath, { force: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to delete managed plist: ${msg}`);
  }
  return { kind: "removed" };
}
