import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Config } from "../config.js";
import type { ProviderUsage } from "../types.js";
import { unavailableAll, okWindow } from "../types.js";

function readGrokToken(cfg: Config): string | null {
  if (cfg.grok.oauthToken) return cfg.grok.oauthToken;
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
}

export async function fetchGrokUsage(cfg: Config): Promise<ProviderUsage> {
  const fetchedAt = new Date().toISOString();
  const token = readGrokToken(cfg);
  if (!token) {
    const reason = "Run `grok login`, or set GROK_CLI_OAUTH_TOKEN / config.grok.oauthToken.";
    return {
      provider: "grok",
      label: "Grok Build",
      windows: unavailableAll(reason),
      fetchedAt,
      error: reason,
    };
  }

  try {
    const res = await fetch("https://cli-chat-proxy.grok.com/v1/billing", {
      headers: {
        Authorization: `Bearer ${token}`,
        "x-xai-token-auth": "xai-grok-cli",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const reason = `Grok billing HTTP ${res.status}`;
      return {
        provider: "grok",
        label: "Grok Build",
        windows: unavailableAll(reason),
        fetchedAt,
        error: reason,
      };
    }
    const body = (await res.json()) as Record<string, unknown>;
    const used = Number(body.credits_used ?? body.used ?? body.usage);
    const limit = Number(body.credits_limit ?? body.limit ?? body.total);
    const remaining = Number(body.credits_remaining ?? body.remaining);
    let usedPct: number | null = null;
    if (Number.isFinite(used) && Number.isFinite(limit) && limit > 0) {
      usedPct = Math.min(100, Math.max(0, (used / limit) * 100));
    } else if (Number.isFinite(remaining) && Number.isFinite(limit) && limit > 0) {
      usedPct = Math.min(100, Math.max(0, ((limit - remaining) / limit) * 100));
    } else if (Number.isFinite(Number(body.usagePercent))) {
      usedPct = Number(body.usagePercent);
    }

    const reset =
      typeof body.resets_at === "string"
        ? body.resets_at
        : typeof body.resetAt === "string"
          ? body.resetAt
          : null;

    const windows = unavailableAll("Grok Build exposes a billing-period credit pool, not separate 5h/week windows.");
    if (usedPct !== null) {
      windows.month = okWindow(usedPct, reset);
    }

    return {
      provider: "grok",
      label: "Grok Build",
      windows,
      balance:
        Number.isFinite(remaining) || Number.isFinite(limit)
          ? {
              currency: "credits",
              remaining: Number.isFinite(remaining) ? remaining : null,
              used: Number.isFinite(used) ? used : null,
              total: Number.isFinite(limit) ? limit : null,
              label: "Build credits",
              resetsAtIso: reset,
            }
          : undefined,
      fetchedAt,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      provider: "grok",
      label: "Grok Build",
      windows: unavailableAll(msg),
      fetchedAt,
      error: msg,
    };
  }
}
