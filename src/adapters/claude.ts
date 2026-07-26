import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Config } from "../config.js";
import type { BalanceBreakdown, ProviderUsage, WindowId, WindowUsage } from "../types.js";
import { unavailableAll, okWindow } from "../types.js";

/**
 * Claude Code / Claude.ai subscription usage via undocumented OAuth usage endpoint.
 * Auth: config/env token, else ~/.claude/.credentials.json (claudeAiOauth.accessToken).
 *
 * Consumer plans populate five_hour / seven_day windows.
 * Enterprise / Teams credit plans populate spend (or extra_usage) in USD.
 */

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

/** Soft cache so 429s don't wipe the last good spend/windows from the widget. */
let cachedOk: ProviderUsage | null = null;
let rateLimitedUntilMs = 0;

function readClaudeToken(cfg: Config): string | null {
  if (cfg.claude.accessToken) return cfg.claude.accessToken;
  const credPath = path.join(os.homedir(), ".claude", ".credentials.json");
  if (!existsSync(credPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(credPath, "utf8")) as Record<string, unknown>;
    const oauth = raw.claudeAiOauth as Record<string, unknown> | undefined;
    if (typeof oauth?.accessToken === "string" && oauth.accessToken.trim()) {
      return oauth.accessToken.trim();
    }
  } catch {
    // ignore
  }
  return null;
}

function claudeUserAgent(): string {
  // Anthropic rate-limits non–claude-code UAs aggressively; keep a real-ish version.
  return "claude-code/2.1.220";
}

function moneyFromMinor(
  amountMinor: unknown,
  exponent: unknown,
): number | null {
  const minor = Number(amountMinor);
  const exp = Number(exponent);
  if (!Number.isFinite(minor)) return null;
  const e = Number.isFinite(exp) && exp >= 0 ? exp : 2;
  // Round to the currency exponent so 364/100 → 3.64 exactly.
  return Number((minor / 10 ** e).toFixed(e));
}

function mapSpendBalance(body: Record<string, unknown>): BalanceBreakdown | undefined {
  const spend = body.spend as Record<string, unknown> | undefined;
  if (spend && spend.enabled !== false) {
    const usedObj = spend.used as Record<string, unknown> | undefined;
    const limitObj = spend.limit as Record<string, unknown> | undefined;
    const used = moneyFromMinor(usedObj?.amount_minor, usedObj?.exponent ?? 2);
    const total = moneyFromMinor(limitObj?.amount_minor, limitObj?.exponent ?? 2);
    if (used !== null && total !== null && total > 0) {
      const percent = Number(spend.percent);
      const remaining = Number((total - used).toFixed(2));
      return {
        currency: "USD",
        used,
        total,
        remaining: Math.max(0, remaining),
        label: Number.isFinite(percent)
          ? `Spend limit - ${Math.round(percent)}% used`
          : "Spend limit",
      };
    }
  }

  const extra = body.extra_usage as Record<string, unknown> | undefined;
  if (!extra || extra.is_enabled === false) return undefined;
  const decimals = Number(extra.decimal_places);
  const scale = Number.isFinite(decimals) && decimals >= 0 ? 10 ** decimals : 100;
  const limitRaw = Number(extra.monthly_limit);
  const usedRaw = Number(extra.used_credits);
  if (!Number.isFinite(limitRaw) || !Number.isFinite(usedRaw) || limitRaw <= 0) return undefined;
  const total = Number((limitRaw / scale).toFixed(Number.isFinite(decimals) && decimals >= 0 ? decimals : 2));
  const used = Number((usedRaw / scale).toFixed(Number.isFinite(decimals) && decimals >= 0 ? decimals : 2));
  const utilization = Number(extra.utilization);
  return {
    currency: "USD",
    used,
    total,
    remaining: Math.max(0, Number((total - used).toFixed(2))),
    label: Number.isFinite(utilization)
      ? `Spend limit - ${Math.round(utilization)}% used`
      : "Spend limit",
  };
}

function mapOAuthUsage(body: Record<string, unknown>): Record<WindowId, WindowUsage> {
  const windows = unavailableAll("Claude did not report this window.");
  const five = body.five_hour as Record<string, unknown> | undefined;
  const seven = (body.seven_day ?? body.seven_day_opus ?? body.seven_day_sonnet) as
    | Record<string, unknown>
    | undefined;

  const apply = (id: WindowId, block: Record<string, unknown> | undefined) => {
    if (!block) return;
    const used = Number(block.utilization ?? block.used_percentage ?? block.usedPercent);
    if (!Number.isFinite(used)) return;
    const resets =
      typeof block.resets_at === "string"
        ? block.resets_at
        : typeof block.resetsAt === "string"
          ? block.resetsAt
          : null;
    windows[id] = okWindow(used, resets);
  };

  apply("five_hour", five);
  apply("week", seven);
  // No reliable month in OAuth payload for consumer plans.
  return windows;
}

function usageFromBody(body: Record<string, unknown>, fetchedAt: string): ProviderUsage {
  const windows = mapOAuthUsage(body);
  const balance = mapSpendBalance(body);
  const hasWindow = Object.values(windows).some((w) => w.status === "ok");
  if (!hasWindow && !balance) {
    const reason =
      "Claude reported no rolling windows or spend limit (common on some enterprise seats).";
    return {
      provider: "claude",
      label: "Claude",
      windows,
      fetchedAt,
      error: reason,
    };
  }
  return {
    provider: "claude",
    label: "Claude",
    windows,
    ...(balance ? { balance } : {}),
    fetchedAt,
  };
}

export async function fetchClaudeUsage(cfg: Config): Promise<ProviderUsage> {
  const fetchedAt = new Date().toISOString();
  const token = readClaudeToken(cfg);
  if (!token) {
    const reason =
      "No Claude credentials. Sign in with Claude Code, or set CLAUDE_ACCESS_TOKEN / config.claude.accessToken.";
    return {
      provider: "claude",
      label: "Claude",
      windows: unavailableAll(reason),
      fetchedAt,
      error: reason,
    };
  }

  const now = Date.now();
  if (now < rateLimitedUntilMs && cachedOk) {
    return { ...cachedOk, fetchedAt };
  }

  try {
    const res = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": claudeUserAgent(),
        Accept: "application/json",
      },
    });
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitSec = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 180;
      rateLimitedUntilMs = Date.now() + waitSec * 1000;
      if (cachedOk) return { ...cachedOk, fetchedAt };
      const reason = `Claude usage rate limited (retry in ~${Math.ceil(waitSec / 60)}m)`;
      return {
        provider: "claude",
        label: "Claude",
        windows: unavailableAll(reason),
        fetchedAt,
        error: reason,
      };
    }
    if (!res.ok) {
      const reason = `Claude usage HTTP ${res.status}`;
      if (cachedOk) return { ...cachedOk, fetchedAt };
      return {
        provider: "claude",
        label: "Claude",
        windows: unavailableAll(reason),
        fetchedAt,
        error: reason,
      };
    }
    const body = (await res.json()) as Record<string, unknown>;
    const usage = usageFromBody(body, fetchedAt);
    if (!usage.error) cachedOk = usage;
    rateLimitedUntilMs = 0;
    return usage;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (cachedOk) return { ...cachedOk, fetchedAt };
    return {
      provider: "claude",
      label: "Claude",
      windows: unavailableAll(msg),
      fetchedAt,
      error: msg,
    };
  }
}

export const __test = {
  mapOAuthUsage,
  mapSpendBalance,
  moneyFromMinor,
  usageFromBody,
  readClaudeToken,
  resetCache() {
    cachedOk = null;
    rateLimitedUntilMs = 0;
  },
};
