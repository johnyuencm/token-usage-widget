import { readFile, writeFile } from "node:fs/promises";
import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import type { ProviderId, WindowId } from "./types.js";
import { ALL_PROVIDER_IDS } from "./types.js";
import { generateLanToken, isLoopbackHost } from "./server-auth.js";
import { DEFAULT_UI, mergeUiSettings, type UiSettings } from "./ui-settings.js";

const PACKAGE_NAME = "token-usage-widget";

/** Package install root (parent of `src/` or `dist/`). */
export function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

/** Stable per-user config directory (not cwd). */
export function userDataDir(): string {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA?.trim();
    const base = appData && appData.length > 0
      ? appData
      : path.join(os.homedir(), "AppData", "Roaming");
    return path.join(base, PACKAGE_NAME);
  }
  return path.join(os.homedir(), ".config", PACKAGE_NAME);
}

/**
 * One-time copy of checkout `./config.json` into user-data when missing.
 * No-ops when TOKEN_USAGE_WIDGET_CONFIG is set or destination already exists.
 */
export function migrateCwdConfigIfNeeded(): void {
  if (process.env.TOKEN_USAGE_WIDGET_CONFIG?.trim()) return;
  const dest = path.join(userDataDir(), "config.json");
  if (existsSync(dest)) return;
  const cwdConfig = path.join(process.cwd(), "config.json");
  if (!existsSync(cwdConfig)) return;
  if (path.resolve(cwdConfig) === path.resolve(dest)) return;
  mkdirSync(userDataDir(), { recursive: true });
  copyFileSync(cwdConfig, dest);
}

export function ensureConfigDir(): void {
  mkdirSync(path.dirname(configPath()), { recursive: true });
}

export interface OpenCodeCaps {
  five_hour: number | null;
  week: number | null;
  month: number | null;
}

export type ProviderFlags = Record<ProviderId, boolean>;

export interface Config {
  /** Which providers to poll. Missing keys default per DEFAULT_ENABLED. */
  providers: ProviderFlags;
  opencode: {
    dbPath: string;
    caps: OpenCodeCaps;
    go: {
      workspaceId: string | null;
      authCookie: string | null;
    };
  };
  openrouter: { apiKey: string | null };
  kimi: { apiKey: string | null };
  zai: { apiKey: string | null };
  grok: { oauthToken: string | null };
  claude: { accessToken: string | null };
  server: {
    port: number;
    host: string;
    /**
     * Shared secret required by the API when `host` is not loopback. Null on
     * the default loopback bind. Generated and persisted on first LAN start.
     */
    lanToken: string | null;
  };
  ui: UiSettings;
}

const DEFAULT_DB_PATH = path.join(os.homedir(), ".local", "share", "opencode", "opencode.db");

/** Cold start: show nothing until `npm run setup` (or explicit config.providers). */
export const DEFAULT_ENABLED: ProviderFlags = {
  openai: false,
  opencode: false,
  cursor: false,
  claude: false,
  openrouter: false,
  kimi: false,
  zai: false,
  grok: false,
};

/** Fallback for `npm run setup:defaults` when no local agents are detected. */
export const SETUP_DEFAULTS_ENABLED: ProviderFlags = {
  openai: true,
  opencode: false,
  cursor: true,
  claude: false,
  openrouter: false,
  kimi: false,
  zai: false,
  grok: false,
};

function defaultConfig(): Config {
  return {
    providers: { ...DEFAULT_ENABLED },
    opencode: {
      dbPath: DEFAULT_DB_PATH,
      caps: { five_hour: null, week: null, month: null },
      go: { workspaceId: null, authCookie: null },
    },
    openrouter: { apiKey: null },
    kimi: { apiKey: null },
    zai: { apiKey: null },
    grok: { oauthToken: null },
    claude: { accessToken: null },
    server: { port: 4321, host: "127.0.0.1", lanToken: null },
    ui: structuredClone(DEFAULT_UI),
  };
}

function isWindowId(v: unknown): v is WindowId {
  return v === "five_hour" || v === "week" || v === "month";
}

function mergeCaps(base: OpenCodeCaps, incoming: unknown): OpenCodeCaps {
  if (!incoming || typeof incoming !== "object") return base;
  const src = incoming as Record<string, unknown>;
  const out = { ...base };
  for (const key of Object.keys(out) as (keyof OpenCodeCaps)[]) {
    const val = src[key];
    if (val === null || typeof val === "number") {
      out[key] = val;
    } else if (typeof val === "string" && val.trim() !== "") {
      const n = Number(val);
      out[key] = Number.isFinite(n) ? n : null;
    }
  }
  return out;
}

function mergeProviders(base: ProviderFlags, incoming: unknown): ProviderFlags {
  const out = { ...base };
  if (!incoming || typeof incoming !== "object") return out;
  const src = incoming as Record<string, unknown>;
  for (const id of ALL_PROVIDER_IDS) {
    if (typeof src[id] === "boolean") out[id] = src[id];
  }
  return out;
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export function configPath(): string {
  const override = process.env.TOKEN_USAGE_WIDGET_CONFIG?.trim();
  if (override) return path.resolve(override);
  return path.join(userDataDir(), "config.json");
}

export function exampleConfigPath(): string {
  return path.join(packageRoot(), "config.example.json");
}

/** Owner-only mode for files that can hold plaintext provider secrets. No-op on Windows. */
export const SECRET_FILE_MODE = 0o600;

/** Best-effort chmod of an existing config file so pre-0600 installs are tightened on next load. */
export function tightenConfigFileMode(filePath: string): void {
  if (process.platform === "win32") return; // Windows ACLs; POSIX mode bits are a no-op there.
  try {
    if (existsSync(filePath)) chmodSync(filePath, SECRET_FILE_MODE);
  } catch {
    // Best effort: a read-only mount or foreign-owned file must not break startup.
  }
}

export async function loadConfig(): Promise<Config> {
  migrateCwdConfigIfNeeded();
  const cfg = defaultConfig();
  const envDb = process.env.OPENCODE_DB_PATH;
  if (envDb && envDb.trim() !== "") cfg.opencode.dbPath = envDb;
  const envPort = process.env.PORT;
  if (envPort && Number.isFinite(Number(envPort))) cfg.server.port = Number(envPort);

  for (const p of [exampleConfigPath(), configPath()]) {
    if (!existsSync(p)) continue;
    // Existing configs from before 0600: tighten on load, then read.
    if (p === configPath()) tightenConfigFileMode(p);
    try {
      const raw = await readFile(p, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (parsed.providers) cfg.providers = mergeProviders(cfg.providers, parsed.providers);

      const oc = parsed.opencode as Record<string, unknown> | undefined;
      if (oc) {
        if (typeof oc.dbPath === "string" && oc.dbPath.trim() !== "" && !envDb) {
          cfg.opencode.dbPath = oc.dbPath;
        }
        if (oc.caps) cfg.opencode.caps = mergeCaps(cfg.opencode.caps, oc.caps);
        const go = oc.go as Record<string, unknown> | undefined;
        if (go) {
          cfg.opencode.go.workspaceId = strOrNull(go.workspaceId) ?? cfg.opencode.go.workspaceId;
          cfg.opencode.go.authCookie = strOrNull(go.authCookie) ?? cfg.opencode.go.authCookie;
        }
      }

      const or = parsed.openrouter as Record<string, unknown> | undefined;
      if (or) cfg.openrouter.apiKey = strOrNull(or.apiKey) ?? cfg.openrouter.apiKey;
      const kimi = parsed.kimi as Record<string, unknown> | undefined;
      if (kimi) cfg.kimi.apiKey = strOrNull(kimi.apiKey) ?? cfg.kimi.apiKey;
      const zai = parsed.zai as Record<string, unknown> | undefined;
      if (zai) cfg.zai.apiKey = strOrNull(zai.apiKey) ?? cfg.zai.apiKey;
      const grok = parsed.grok as Record<string, unknown> | undefined;
      if (grok) cfg.grok.oauthToken = strOrNull(grok.oauthToken) ?? cfg.grok.oauthToken;
      const claude = parsed.claude as Record<string, unknown> | undefined;
      if (claude) cfg.claude.accessToken = strOrNull(claude.accessToken) ?? cfg.claude.accessToken;

      const srv = parsed.server as Record<string, unknown> | undefined;
      if (srv) {
        if (typeof srv.port === "number" && !envPort) cfg.server.port = srv.port;
        if (typeof srv.host === "string") cfg.server.host = srv.host;
        cfg.server.lanToken = strOrNull(srv.lanToken) ?? cfg.server.lanToken;
      }
      if (parsed.ui) cfg.ui = mergeUiSettings(parsed.ui);
    } catch {
      // ignore malformed config files, keep defaults
    }
  }

  // Env overrides for secrets (never require storing in config.json)
  if (process.env.OPENROUTER_API_KEY?.trim()) cfg.openrouter.apiKey = process.env.OPENROUTER_API_KEY.trim();
  if (process.env.KIMI_CODE_API_KEY?.trim()) cfg.kimi.apiKey = process.env.KIMI_CODE_API_KEY.trim();
  if (process.env.ZAI_API_KEY?.trim()) cfg.zai.apiKey = process.env.ZAI_API_KEY.trim();
  else if (process.env.GLM_API_KEY?.trim()) cfg.zai.apiKey = process.env.GLM_API_KEY.trim();
  if (process.env.GROK_CLI_OAUTH_TOKEN?.trim()) cfg.grok.oauthToken = process.env.GROK_CLI_OAUTH_TOKEN.trim();
  if (process.env.CLAUDE_ACCESS_TOKEN?.trim()) cfg.claude.accessToken = process.env.CLAUDE_ACCESS_TOKEN.trim();

  for (const key of Object.keys(cfg.opencode.caps) as (keyof OpenCodeCaps)[]) {
    const v = cfg.opencode.caps[key];
    if (v !== null && !(typeof v === "number" && v > 0)) cfg.opencode.caps[key] = null;
  }

  if (process.env.TUW_LAN_TOKEN?.trim()) cfg.server.lanToken = process.env.TUW_LAN_TOKEN.trim();

  void isWindowId;
  return cfg;
}

/**
 * Resolve the API auth token for a config. Loopback stays open (the OS limits
 * the socket). A non-loopback host with no stored token gets one generated and
 * persisted into the 0600 config so it survives restarts.
 */
export async function resolveServerAuth(cfg: Config): Promise<string | null> {
  if (isLoopbackHost(cfg.server.host)) return null;
  if (cfg.server.lanToken) return cfg.server.lanToken;
  const token = generateLanToken();
  cfg.server.lanToken = token;
  await persistLanToken(token);
  return token;
}

/** Merge `server.lanToken` into config.json without dropping existing keys. */
async function persistLanToken(token: string): Promise<void> {
  const p = configPath();
  let merged: Record<string, unknown> = {};
  if (existsSync(p)) {
    try {
      merged = JSON.parse(await readFile(p, "utf8")) as Record<string, unknown>;
    } catch {
      merged = {};
    }
  }
  const server = (merged.server as Record<string, unknown> | undefined) ?? {};
  merged.server = { ...server, lanToken: token };
  ensureConfigDir();
  await writeFile(p, `${JSON.stringify(merged, null, 2)}\n`, {
    encoding: "utf8",
    mode: SECRET_FILE_MODE,
  });
}

export function isFixtureMode(): boolean {
  return process.env.USAGE_FIXTURE === "1" || process.env.USAGE_FIXTURE === "true";
}

export function enabledProviders(cfg: Config): ProviderId[] {
  return ALL_PROVIDER_IDS.filter((id) => cfg.providers[id]);
}
