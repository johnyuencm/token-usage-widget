/**
 * Detect which local coding agents are installed / signed in on this machine.
 * Used by `tuw setup --defaults` so first-run enables Codex, Cursor, and Claude
 * when they are actually present — not a hardcoded pair.
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

  return flags;
}

/**
 * `saved`: the provider flags already in config.json. Setup keeps them and only
 * turns on detected agents, so a re-run does not undo the user's choices.
 */
export function resolveSetupDefaultFlags(
  enableAll: boolean,
  detected: ProviderFlags = detectLocalAgentFlags(),
  saved?: ProviderFlags,
): ProviderFlags {
  if (enableAll) {
    return Object.fromEntries(ALL_PROVIDER_IDS.map((id) => [id, true])) as ProviderFlags;
  }
  if (saved) {
    const out = { ...saved };
    for (const id of LOCAL_AGENT_IDS) if (detected[id]) out[id] = true;
    return out;
  }
  const anyLocal = LOCAL_AGENT_IDS.some((id) => detected[id]);
  if (!anyLocal) return { ...SETUP_DEFAULTS_ENABLED };
  return {
    ...DEFAULT_ENABLED,
    openai: detected.openai,
    cursor: detected.cursor,
    claude: detected.claude,
  };
}

export function usedDefaultsFallback(
  enableAll: boolean,
  detected: ProviderFlags,
  saved?: ProviderFlags,
): boolean {
  if (enableAll || saved) return false;
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
