/**
 * Detect which local coding agents are installed / signed in on this machine.
 * Used by `tuw setup --defaults` so first-run enables Codex, Cursor, Claude,
 * and OpenCode when they are actually present — not a hardcoded pair.
 */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import {
  DEFAULT_ENABLED,
  SETUP_DEFAULTS_ENABLED,
  type ProviderFlags,
} from "../config.js";
import { ALL_PROVIDER_IDS, type ProviderId } from "../types.js";
import { resolveCursorStateDbPath } from "../adapters/cursor.js";

export const LOCAL_AGENT_IDS: readonly ProviderId[] = [
  "openai",
  "opencode",
  "cursor",
  "claude",
];

export interface DetectLocalSeams {
  platform?: NodeJS.Platform;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  existsSync?: (p: string) => boolean;
  commandExists?: (cmd: string) => boolean;
}

export function defaultCommandExists(
  cmd: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const bin = platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(bin, [cmd], {
    stdio: "ignore",
    windowsHide: true,
  });
  return result.status === 0;
}

export function detectLocalAgentFlags(seams: DetectLocalSeams = {}): ProviderFlags {
  const platform = seams.platform ?? process.platform;
  const homeDir = seams.homeDir ?? os.homedir();
  const env = seams.env ?? process.env;
  const exists = seams.existsSync ?? existsSync;
  const which =
    seams.commandExists ?? ((cmd: string) => defaultCommandExists(cmd, platform));

  const flags: ProviderFlags = { ...DEFAULT_ENABLED };

  flags.openai = which("codex") || exists(path.join(homeDir, ".codex"));

  const cursorDb = resolveCursorStateDbPath({ platform, homeDir, env });
  flags.cursor =
    Boolean(env.CURSOR_TOKEN?.trim()) || exists(cursorDb) || which("cursor");

  flags.claude =
    Boolean(env.CLAUDE_ACCESS_TOKEN?.trim()) ||
    exists(path.join(homeDir, ".claude", ".credentials.json")) ||
    which("claude");

  flags.opencode =
    Boolean(env.OPENCODE_GO_AUTH_COOKIE?.trim()) ||
    which("opencode") ||
    exists(path.join(homeDir, ".local", "share", "opencode", "opencode.db")) ||
    exists(path.join(homeDir, ".local", "share", "opencode", "auth.json"));

  return flags;
}

export function resolveSetupDefaultFlags(
  enableAll: boolean,
  detected: ProviderFlags = detectLocalAgentFlags(),
): ProviderFlags {
  if (enableAll) {
    return Object.fromEntries(ALL_PROVIDER_IDS.map((id) => [id, true])) as ProviderFlags;
  }
  const anyLocal = LOCAL_AGENT_IDS.some((id) => detected[id]);
  if (!anyLocal) return { ...SETUP_DEFAULTS_ENABLED };
  return {
    ...DEFAULT_ENABLED,
    openai: detected.openai,
    opencode: detected.opencode,
    cursor: detected.cursor,
    claude: detected.claude,
  };
}

export function usedDefaultsFallback(
  enableAll: boolean,
  detected: ProviderFlags,
): boolean {
  if (enableAll) return false;
  return !LOCAL_AGENT_IDS.some((id) => detected[id]);
}

export function formatDefaultsLog(
  enableAll: boolean,
  providers: ProviderFlags,
  usedFallback: boolean,
): string {
  if (enableAll) return "Defaults mode: all providers enabled (no secrets prompted).";
  if (usedFallback) {
    return "Defaults mode: no local agents detected; enabled openai + cursor (others off until you opt in).";
  }
  const enabled = ALL_PROVIDER_IDS.filter((id) => providers[id]);
  return `Defaults mode: enabled ${enabled.join(", ")} from local detection.`;
}
