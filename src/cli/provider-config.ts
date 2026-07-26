/**
 * Shared provider config helpers for setup / enable / disable.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  DEFAULT_ENABLED,
  configPath,
  ensureConfigDir,
  migrateCwdConfigIfNeeded,
  type Config,
  type ProviderFlags,
} from "../config.js";
import { ALL_PROVIDER_IDS, type ProviderId } from "../types.js";

export type SecretKind =
  | "openrouter"
  | "kimi"
  | "zai"
  | "grok"
  | "claude"
  | "opencode_cookie"
  | null;

export interface SecretSpec {
  kind: SecretKind;
  prompt: string;
  envNames: string[];
  detect: () => string | null;
}

export const SECRET_BY_PROVIDER: Partial<Record<ProviderId, SecretSpec>> = {
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

export function loadExisting(): Record<string, unknown> {
  migrateCwdConfigIfNeeded();
  const p = configPath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function defaultShell(): Config["server"] {
  return { port: 4321, host: "127.0.0.1" };
}

export function secretDetectNote(secret: SecretSpec, detected: string | null): string {
  if (detected) return " (detected env/file — press Enter to keep)";
  return " (none detected — paste token or Enter to skip)";
}

export function applySecret(
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

export function writeConfig(merged: Record<string, unknown>): void {
  ensureConfigDir();
  const p = configPath();
  writeFileSync(p, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  // eslint-disable-next-line no-console
  console.log(`Wrote ${p}`);
}

export function readProviderFlags(existing: Record<string, unknown>): ProviderFlags {
  const prev = (existing.providers as Partial<ProviderFlags> | undefined) ?? {};
  const providers: ProviderFlags = { ...DEFAULT_ENABLED };
  for (const id of ALL_PROVIDER_IDS) {
    if (typeof prev[id] === "boolean") providers[id] = prev[id]!;
  }
  return providers;
}

export function ensureOpencodeStub(merged: Record<string, unknown>): void {
  if (!merged.opencode) {
    merged.opencode = {
      dbPath: null,
      caps: { five_hour: null, week: null, month: null },
      go: { workspaceId: null, authCookie: null },
    };
  }
}

export function resolveClaudeToken(cfg: Record<string, unknown>): string | null {
  const fromDetect = SECRET_BY_PROVIDER.claude?.detect() ?? null;
  if (fromDetect) return fromDetect;
  const claude = cfg.claude as { accessToken?: unknown } | undefined;
  if (typeof claude?.accessToken === "string" && claude.accessToken.trim()) {
    return claude.accessToken.trim();
  }
  return null;
}

export function isProviderId(v: string): v is ProviderId {
  return (ALL_PROVIDER_IDS as string[]).includes(v);
}

export function parseProviderId(raw: string | undefined): ProviderId {
  if (!raw || !isProviderId(raw)) {
    throw new Error(
      `Unknown provider${raw ? `: ${raw}` : ""}. Valid: ${ALL_PROVIDER_IDS.join(", ")}`,
    );
  }
  return raw;
}

export function setProviderEnabled(
  existing: Record<string, unknown>,
  id: ProviderId,
  on: boolean,
): Record<string, unknown> {
  const providers = readProviderFlags(existing);
  providers[id] = on;
  const merged: Record<string, unknown> = {
    ...existing,
    providers,
    server: (existing.server as object) ?? defaultShell(),
  };
  ensureOpencodeStub(merged);
  return merged;
}

export type ClaudeAuthLogin = () => SpawnSyncReturns<Buffer | string> | { status: number | null; error?: Error };

export interface EnsureClaudeDeps {
  detect?: () => string | null;
  authLogin?: ClaudeAuthLogin;
  resolveToken?: (cfg: Record<string, unknown>) => string | null;
}

function defaultClaudeAuthLogin(): SpawnSyncReturns<Buffer | string> {
  return spawnSync("claude", ["auth", "login"], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
}

/**
 * If Claude is enabled in cfg and no token is available, run `claude auth login`
 * then re-detect. Throws with an actionable message if still missing.
 */
export function ensureClaudeCredentials(
  cfg: Record<string, unknown>,
  deps: EnsureClaudeDeps = {},
): void {
  const providers = readProviderFlags(cfg);
  if (!providers.claude) return;

  const resolve = deps.resolveToken ?? resolveClaudeToken;
  if (resolve(cfg)) return;

  const authLogin = deps.authLogin ?? defaultClaudeAuthLogin;
  // eslint-disable-next-line no-console
  console.log("\nClaude is enabled but no credentials were found. Running: claude auth login");
  const result = authLogin();
  if (result.error) {
    throw new Error(
      `Claude enabled but not logged in (claude CLI failed: ${result.error.message}). Run: claude auth login`,
    );
  }

  const detect = deps.detect ?? (() => SECRET_BY_PROVIDER.claude?.detect() ?? null);
  if (detect() || resolve(cfg)) return;

  throw new Error(
    "Claude enabled but not logged in. Run: claude auth login",
  );
}

export function serverEndpointFromConfig(cfg: Record<string, unknown>): {
  host: string;
  port: number;
} {
  const srv = cfg.server as { host?: unknown; port?: unknown } | undefined;
  const host = typeof srv?.host === "string" && srv.host.trim() ? srv.host.trim() : "127.0.0.1";
  const port =
    typeof srv?.port === "number" && Number.isFinite(srv.port) ? srv.port : 4321;
  return { host, port };
}
