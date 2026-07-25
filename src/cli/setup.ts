/**
 * Interactive / noninteractive config writer for multi-provider setup.
 *
 *   npm run setup
 *   npm run setup:defaults
 *   npm run setup:all
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_ENABLED,
  SETUP_DEFAULTS_ENABLED,
  configPath,
  ensureConfigDir,
  migrateCwdConfigIfNeeded,
  type Config,
  type ProviderFlags,
} from "../config.js";
import { ALL_PROVIDER_IDS, type ProviderId } from "../types.js";
import { PROVIDER_META } from "../providers/registry.js";
import {
  installLoginLaunch,
  type LoginLaunchSeams,
  type LoginLaunchResult,
} from "../login-launch.js";
import { defaultSeams as buildStartupSeams } from "./startup.js";

type SecretKind = "openrouter" | "kimi" | "zai" | "grok" | "claude" | "opencode_cookie" | null;

interface SecretSpec {
  kind: SecretKind;
  prompt: string;
  envNames: string[];
  detect: () => string | null;
}

const SECRET_BY_PROVIDER: Partial<Record<ProviderId, SecretSpec>> = {
  openrouter: {
    kind: "openrouter",
    prompt: "OpenRouter API key (credits/management)",
    envNames: ["OPENROUTER_API_KEY"],
    detect: () => process.env.OPENROUTER_API_KEY?.trim() || null,
  },
  kimi: {
    kind: "kimi",
    prompt: "Kimi Code API key",
    envNames: ["KIMI_CODE_API_KEY"],
    detect: () => {
      if (process.env.KIMI_CODE_API_KEY?.trim()) return process.env.KIMI_CODE_API_KEY.trim();
      const p = path.join(os.homedir(), ".kimi", "credentials", "kimi-code.json");
      if (!existsSync(p)) return null;
      try {
        const j = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
        for (const k of ["apiKey", "api_key", "token", "key"]) {
          if (typeof j[k] === "string" && String(j[k]).trim()) return String(j[k]).trim();
        }
      } catch {
        // ignore
      }
      return null;
    },
  },
  zai: {
    kind: "zai",
    prompt: "Z.AI / GLM API key",
    envNames: ["ZAI_API_KEY", "GLM_API_KEY"],
    detect: () =>
      process.env.ZAI_API_KEY?.trim() || process.env.GLM_API_KEY?.trim() || null,
  },
  grok: {
    kind: "grok",
    prompt: "Grok CLI OAuth token",
    envNames: ["GROK_CLI_OAUTH_TOKEN"],
    detect: () => {
      if (process.env.GROK_CLI_OAUTH_TOKEN?.trim()) return process.env.GROK_CLI_OAUTH_TOKEN.trim();
      const p = path.join(os.homedir(), ".grok", "auth.json");
      if (!existsSync(p)) return null;
      try {
        const j = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
        for (const k of ["accessToken", "access_token", "token", "oauthToken"]) {
          if (typeof j[k] === "string" && String(j[k]).trim()) return String(j[k]).trim();
        }
      } catch {
        // ignore
      }
      return null;
    },
  },
  claude: {
    kind: "claude",
    prompt: "Claude access token",
    envNames: ["CLAUDE_ACCESS_TOKEN"],
    detect: () => {
      if (process.env.CLAUDE_ACCESS_TOKEN?.trim()) return process.env.CLAUDE_ACCESS_TOKEN.trim();
      const p = path.join(os.homedir(), ".claude", ".credentials.json");
      if (!existsSync(p)) return null;
      try {
        const raw = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
        const oauth = raw.claudeAiOauth as Record<string, unknown> | undefined;
        if (typeof oauth?.accessToken === "string" && oauth.accessToken.trim()) {
          return oauth.accessToken.trim();
        }
      } catch {
        // ignore
      }
      return null;
    },
  },
  opencode: {
    kind: "opencode_cookie",
    prompt: "OpenCode Go website auth cookie (optional until API ships)",
    envNames: ["OPENCODE_GO_AUTH_COOKIE"],
    detect: () => process.env.OPENCODE_GO_AUTH_COOKIE?.trim() || null,
  },
};

function loadExisting(): Record<string, unknown> {
  migrateCwdConfigIfNeeded();
  const p = configPath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function defaultShell(): Config["server"] {
  return { port: 4321, host: "127.0.0.1" };
}

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
      // Accept on/off/true/false too — people type those instead of y/n.
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

function applySecret(
  out: Record<string, unknown>,
  kind: SecretKind,
  value: string,
): void {
  if (!kind || !value) return;
  if (kind === "openrouter") {
    out.openrouter = { ...(out.openrouter as object), apiKey: value };
  } else if (kind === "kimi") {
    out.kimi = { ...(out.kimi as object), apiKey: value };
  } else if (kind === "zai") {
    out.zai = { ...(out.zai as object), apiKey: value };
  } else if (kind === "grok") {
    out.grok = { ...(out.grok as object), oauthToken: value };
  } else if (kind === "claude") {
    out.claude = { ...(out.claude as object), accessToken: value };
  } else if (kind === "opencode_cookie") {
    const oc = (out.opencode as Record<string, unknown>) ?? {};
    const go = (oc.go as Record<string, unknown>) ?? {};
    out.opencode = { ...oc, go: { ...go, authCookie: value } };
  }
}

function writeConfig(merged: Record<string, unknown>): void {
  ensureConfigDir();
  const p = configPath();
  writeFileSync(p, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  // eslint-disable-next-line no-console
  console.log(`Wrote ${p}`);
}

async function runDefaults(enableAll: boolean): Promise<void> {
  const existing = loadExisting();
  const providers: ProviderFlags = enableAll
    ? Object.fromEntries(ALL_PROVIDER_IDS.map((id) => [id, true])) as ProviderFlags
    : { ...SETUP_DEFAULTS_ENABLED };
  const merged: Record<string, unknown> = {
    ...existing,
    providers,
    server: (existing.server as object) ?? defaultShell(),
  };
  if (!merged.opencode) {
    merged.opencode = {
      dbPath: null,
      caps: { five_hour: null, week: null, month: null },
      go: { workspaceId: null, authCookie: null },
    };
  }
  writeConfig(merged);
  // eslint-disable-next-line no-console
  console.log(
    enableAll
      ? "Defaults mode: all providers enabled (no secrets prompted)."
      : "Defaults mode: openai + cursor enabled (others off until you opt in).",
  );
}

async function runInteractive(): Promise<void> {
  const existing = loadExisting();
  const prevProviders = (existing.providers as Partial<ProviderFlags> | undefined) ?? {};
  const providers: ProviderFlags = { ...DEFAULT_ENABLED };
  for (const id of ALL_PROVIDER_IDS) {
    if (typeof prevProviders[id] === "boolean") providers[id] = prevProviders[id]!;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  // eslint-disable-next-line no-console
  console.log("Token Usage Dashboard — provider setup\n");

  try {
    for (const meta of PROVIDER_META) {
      // eslint-disable-next-line no-console
      console.log(`\n${meta.label} — ${meta.blurb}`);
      // eslint-disable-next-line no-console
      console.log(`  detect: ${meta.detectHint}`);
      const enable = await askYn(rl, `Enable ${meta.label}?`, providers[meta.id]);
      providers[meta.id] = enable;
      if (!enable) continue;

      const secret = SECRET_BY_PROVIDER[meta.id];
      if (!secret) continue;

      const detected = secret.detect();
      const envHint = secret.envNames.join(" / ");
      const detectNote = detected
        ? " (detected env/file — press Enter to keep)"
        : ` (Enter to use ${envHint} / file if present)`;
      const value = await askLine(rl, `${secret.prompt}${detectNote}: `);
      if (value) {
        applySecret(existing, secret.kind, value);
      }
      // Enter with no value → leave config alone; loadConfig will pick env/file at runtime
    }
  } finally {
    rl.close();
  }

  const merged: Record<string, unknown> = {
    ...existing,
    providers,
    server: (existing.server as object) ?? defaultShell(),
  };
  if (!merged.opencode) {
    merged.opencode = {
      dbPath: null,
      caps: { five_hour: null, week: null, month: null },
      go: { workspaceId: null, authCookie: null },
    };
  }
  writeConfig(merged);

  if (providers.claude) {
    const token =
      SECRET_BY_PROVIDER.claude?.detect() ||
      (typeof (merged.claude as { accessToken?: string } | undefined)?.accessToken === "string"
        ? (merged.claude as { accessToken: string }).accessToken
        : null);
    if (!token) {
      // eslint-disable-next-line no-console
      console.log(
        "\nNote: Claude is enabled but no credentials were found.\n" +
          "  Sign in with Claude Code (`claude auth login`), then restart the widget (`tuw`).",
      );
    }
  }
}

export type SetupRunInteractive = () => Promise<void>;
export type SetupRunDefaults = (enableAll: boolean) => Promise<void>;
export type SetupInstallLoginLaunch = (seams: LoginLaunchSeams) => Promise<LoginLaunchResult>;
export type SetupBuildSeams = () => LoginLaunchSeams;

export interface SetupDeps {
  runInteractive: SetupRunInteractive;
  runDefaults: SetupRunDefaults;
  installLoginLaunch: SetupInstallLoginLaunch;
  buildSeams: SetupBuildSeams;
}

/**
 * On darwin, after a successful setup (config save), install/refresh the
 * per-user login launch using the current checkout's default seams. On other
 * platforms, setup runs unchanged. Repeated setup calls refresh the agent.
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

  if (process.platform !== "darwin") return;

  try {
    await resolved.installLoginLaunch(resolved.buildSeams());
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `startup was not enabled: ${reason}. Retry with: npm run widget:startup`,
    );
  }
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
