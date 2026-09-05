/**
 * Interactive / noninteractive config writer for multi-provider setup.
 *
 *   npm run setup
 *   npm run setup:defaults
 *   npm run setup:all
 */
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import { type ProviderFlags } from "../config.js";
import { PROVIDER_META } from "../providers/registry.js";
import {
  detectLocalAgentFlags,
  formatDefaultsLog,
  resolveSetupDefaultFlags,
  usedDefaultsFallback,
} from "./detect-local.js";
import {
  installLoginLaunch,
  type LoginLaunchSeams,
  type LoginLaunchResult,
} from "../login-launch.js";
import { defaultSeams as buildStartupSeams } from "./startup.js";
import {
  SECRET_BY_PROVIDER,
  applySecret,
  defaultShell,
  ensureClaudeCredentials,
  ensureOpencodeStub,
  loadExisting,
  readProviderFlags,
  secretDetectNote,
  writeConfig,
  type EnsureClaudeDeps,
} from "./provider-config.js";
import { refreshRuntime, type RefreshRuntimeDeps } from "./refresh-runtime.js";

function askYn(
  rl: readline.Interface,
  question: string,
  defaultYes: boolean,
): Promise<boolean> {
  const hint = defaultYes ? "Y/n" : "y/N";
  return new Promise((resolve) => {
    rl.question(`${question} [${hint}] `, (answer) => {
      const a = answer.trim().toLowerCase();
      if (!a) {
        resolve(defaultYes);
        return;
      }
      if (a === "y" || a === "yes" || a === "on" || a === "true" || a === "1") {
        resolve(true);
        return;
      }
      if (a === "n" || a === "no" || a === "off" || a === "false" || a === "0") {
        resolve(false);
        return;
      }
      resolve(defaultYes);
    });
  });
}

function askLine(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

async function runDefaults(enableAll: boolean): Promise<void> {
  const existing = loadExisting();
  const detected = detectLocalAgentFlags();
  const providers: ProviderFlags = resolveSetupDefaultFlags(enableAll, detected);
  const merged: Record<string, unknown> = {
    ...existing,
    providers,
    server: (existing.server as object) ?? defaultShell(),
  };
  ensureOpencodeStub(merged);
  writeConfig(merged);
  // eslint-disable-next-line no-console
  console.log(formatDefaultsLog(enableAll, providers, usedDefaultsFallback(enableAll, detected)));
}

async function runInteractive(): Promise<void> {
  const existing = loadExisting();
  const providers: ProviderFlags = readProviderFlags(existing);
  const localAgents = detectLocalAgentFlags();
  const hasSavedProviders = Boolean(
    existing.providers && typeof existing.providers === "object",
  );

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  // eslint-disable-next-line no-console
  console.log("Token Usage Dashboard — provider setup\n");

  try {
    for (const meta of PROVIDER_META) {
      // eslint-disable-next-line no-console
      console.log(`\n${meta.label} — ${meta.blurb}`);
      const found = localAgents[meta.id] ? " [found on this machine]" : "";
      // eslint-disable-next-line no-console
      console.log(`  detect: ${meta.detectHint}${found}`);
      const defaultYes = hasSavedProviders ? providers[meta.id] : Boolean(localAgents[meta.id]);
      const enable = await askYn(rl, `Enable ${meta.label}?`, defaultYes);
      providers[meta.id] = enable;
      if (!enable) continue;

      const secret = SECRET_BY_PROVIDER[meta.id];
      if (!secret) continue;

      const secretDetected = secret.detect();
      const detectNote = secretDetectNote(secret, secretDetected);
      const value = await askLine(rl, `${secret.prompt}${detectNote}: `);
      if (value) {
        applySecret(existing, secret.kind, value);
      }
    }
  } finally {
    rl.close();
  }

  const merged: Record<string, unknown> = {
    ...existing,
    providers,
    server: (existing.server as object) ?? defaultShell(),
  };
  ensureOpencodeStub(merged);
  writeConfig(merged);
}

export type SetupRunInteractive = () => Promise<void>;
export type SetupRunDefaults = (enableAll: boolean) => Promise<void>;
export type SetupInstallLoginLaunch = (seams: LoginLaunchSeams) => Promise<LoginLaunchResult>;
export type SetupBuildSeams = () => LoginLaunchSeams;
export type SetupEnsureClaude = (cfg: Record<string, unknown>, deps?: EnsureClaudeDeps) => void;
export type SetupRefreshRuntime = (deps?: RefreshRuntimeDeps) => Promise<void>;

export interface SetupDeps {
  runInteractive: SetupRunInteractive;
  runDefaults: SetupRunDefaults;
  installLoginLaunch: SetupInstallLoginLaunch;
  buildSeams: SetupBuildSeams;
  ensureClaude?: SetupEnsureClaude;
  ensureClaudeDeps?: EnsureClaudeDeps;
  refreshRuntime?: SetupRefreshRuntime;
  refreshDeps?: RefreshRuntimeDeps;
  loadExisting?: () => Record<string, unknown>;
}

/**
 * On darwin, after a successful setup (config save), install/refresh the
 * per-user login launch using the current checkout's default seams. On other
 * platforms, setup runs unchanged. Repeated setup calls refresh the agent.
 *
 * After save (+ Claude credential remediation when needed), refresh the
 * running widget/server so provider changes apply without a manual restart.
 *
 * If the setup op rejects, registration is never attempted and the original
 * error propagates. If registration rejects after save, throw an actionable
 * error containing "startup was not enabled" and the retry command
 * "npm run widget:startup"; config is left as the setup op wrote it.
 */
export async function runSetup(args: string[], deps?: SetupDeps): Promise<void> {
  const defaults = args.includes("--defaults");
  const all = args.includes("--all");
  if (all && !defaults) {
    throw new Error("--all is only valid with --defaults");
  }

  const resolved: SetupDeps = deps ?? {
    runInteractive,
    runDefaults,
    installLoginLaunch,
    buildSeams: buildStartupSeams,
  };

  if (defaults) {
    await resolved.runDefaults(all);
  } else {
    await resolved.runInteractive();
  }

  const load = resolved.loadExisting ?? loadExisting;
  const cfg = load();
  const ensureClaude = resolved.ensureClaude ?? ensureClaudeCredentials;
  ensureClaude(cfg, resolved.ensureClaudeDeps);

  if (process.platform === "darwin") {
    try {
      await resolved.installLoginLaunch(resolved.buildSeams());
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `startup was not enabled: ${reason}. Retry with: npm run widget:startup`,
      );
    }
  }

  const refresh = resolved.refreshRuntime ?? refreshRuntime;
  await refresh(resolved.refreshDeps);
}

async function main(): Promise<void> {
  try {
    await runSetup(process.argv.slice(2));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(msg);
    process.exit(1);
  }
}

const invokedDirectly =
  typeof process !== "undefined" &&
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  void main();
}
