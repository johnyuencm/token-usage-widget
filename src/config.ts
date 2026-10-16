import { readFile } from "node:fs/promises";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
 * One-time copy of checkout `./config.json` into user-data when no user config
 * ever existed. No-ops when TOKEN_USAGE_WIDGET_CONFIG is set. A marker file
 * records "done": Electron creates the same folder, so the folder says nothing,
 * and a user config that the user deletes must not come back.
 */
export function migrateCwdConfigIfNeeded(): void {
  if (process.env.TOKEN_USAGE_WIDGET_CONFIG?.trim()) return;
  const dir = userDataDir();
  const dest = path.join(dir, "config.json");
  const marker = path.join(dir, ".cwd-config-migrated");
  if (existsSync(marker)) return;
  if (!existsSync(dest)) {
    const cwdConfig = path.join(process.cwd(), "config.json");
    if (!existsSync(cwdConfig) || path.resolve(cwdConfig) === path.resolve(dest)) return;
    let data: Record<string, unknown>;
    try {
      // Parse + write drops removed fields (the old opencode cookie) and sets mode 0600.
      data = parseConfigText(readFileSync(cwdConfig, "utf8"), cwdConfig);
    } catch {
      return; // A bad legacy file is not copied; the user config stays absent.
    }
    mkdirSync(dir, { recursive: true });
    writeConfigFile(dest, data);
  }
  writeFileSync(marker, "");
}

export function ensureConfigDir(): void {
  mkdirSync(path.dirname(configPath()), { recursive: true });
}

export type ProviderFlags = Record<ProviderId, boolean>;

export interface Config {
  /** Which providers to poll. Missing keys default per DEFAULT_ENABLED. */
  providers: ProviderFlags;
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
  /** Set when config.json exists but cannot be read or parsed; the API shows it. */
  configError?: string;
}

/** Cold start: show nothing until `npm run setup` (or explicit config.providers). */
export const DEFAULT_ENABLED: ProviderFlags = {
  openai: false,
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

/**
 * Parse config.json text. Strips a UTF-8 BOM (Notepad adds one) and drops the
 * removed `opencode` block so its old cookie is not carried into the next write.
 * Throws on bad JSON so callers never overwrite the file with an empty object.
 */
export function parseConfigText(raw: string, p: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Config at ${p} is not valid JSON; fix or delete it`);
  }
  const obj = parsed as Record<string, unknown>;
  delete obj.opencode;
  return obj;
}

/** Write config JSON atomically (tmp + rename) so a crash never leaves a truncated file. */
export function writeConfigFile(p: string, data: Record<string, unknown>): void {
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: SECRET_FILE_MODE });
  // `mode` only applies on create; tighten a stale .tmp left by a crash.
  tightenConfigFileMode(tmp);
  renameSync(tmp, p);
}

export async function loadConfig(): Promise<Config> {
  migrateCwdConfigIfNeeded();
  const cfg = defaultConfig();
  // Only a real port wins over the config: "abc", " " (Number is 0) and "0" are ignored.
  const envPortNum = Number(process.env.PORT?.trim() || NaN);
  const envPort = Number.isInteger(envPortNum) && envPortNum > 0 && envPortNum < 65536 ? envPortNum : undefined;
  if (envPort !== undefined) cfg.server.port = envPort;

  // config.example.json is documentation only: merging it would turn on
  // openai/cursor before setup. Every provider stays off until config.json says so.
  const p = configPath();
  if (existsSync(p)) {
    // Existing configs from before 0600: tighten on load, then read.
    tightenConfigFileMode(p);
    try {
      const parsed = parseConfigText(await readFile(p, "utf8"), p);
      if (parsed.providers) cfg.providers = mergeProviders(cfg.providers, parsed.providers);

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
        if (typeof srv.port === "number" && envPort === undefined) cfg.server.port = srv.port;
        if (typeof srv.host === "string") cfg.server.host = srv.host;
        cfg.server.lanToken = strOrNull(srv.lanToken) ?? cfg.server.lanToken;
      }
      if (parsed.ui) cfg.ui = mergeUiSettings(parsed.ui);
    } catch {
      // Keep defaults so the server still starts, but show the error on the API.
      // No path in the message: a LAN caller must not see the home folder layout.
      cfg.configError = "config.json cannot be read or is not valid JSON; fix or delete it";
    }
  }

  // Env overrides for secrets (never require storing in config.json)
  if (process.env.OPENROUTER_API_KEY?.trim()) cfg.openrouter.apiKey = process.env.OPENROUTER_API_KEY.trim();
  if (process.env.KIMI_CODE_API_KEY?.trim()) cfg.kimi.apiKey = process.env.KIMI_CODE_API_KEY.trim();
  if (process.env.ZAI_API_KEY?.trim()) cfg.zai.apiKey = process.env.ZAI_API_KEY.trim();
  else if (process.env.GLM_API_KEY?.trim()) cfg.zai.apiKey = process.env.GLM_API_KEY.trim();
  if (process.env.GROK_CLI_OAUTH_TOKEN?.trim()) cfg.grok.oauthToken = process.env.GROK_CLI_OAUTH_TOKEN.trim();
  if (process.env.CLAUDE_ACCESS_TOKEN?.trim()) cfg.claude.accessToken = process.env.CLAUDE_ACCESS_TOKEN.trim();

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
  // A bad file throws here instead of being replaced by `{}` (that would drop secrets).
  const merged = existsSync(p) ? parseConfigText(await readFile(p, "utf8"), p) : {};
  const server = (merged.server as Record<string, unknown> | undefined) ?? {};
  merged.server = { ...server, lanToken: token };
  ensureConfigDir();
  writeConfigFile(p, merged);
}

export function isFixtureMode(): boolean {
  return process.env.USAGE_FIXTURE === "1" || process.env.USAGE_FIXTURE === "true";
}

export function enabledProviders(cfg: Config): ProviderId[] {
  return ALL_PROVIDER_IDS.filter((id) => cfg.providers[id]);
}
