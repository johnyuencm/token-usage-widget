import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Config } from "../config.js";
import type { BalanceBreakdown, ProviderUsage, WindowId, WindowUsage } from "../types.js";
import { unavailableAll, okWindow } from "../types.js";

/**
 * Claude Code / Claude.ai subscription usage via undocumented OAuth usage endpoint.
 * Auth: config/env token, else ~/.claude/.credentials.json (claudeAiOauth.accessToken).
 * The token is read only. The widget never refreshes it and never writes the
 * credentials file; Claude Code owns that file (run `claude` to refresh).
 *
 * Consumer plans populate five_hour / seven_day windows.
 * Enterprise / Teams credit plans populate spend (or extra_usage) in USD.
 */

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const TOKEN_EXPIRY_SKEW_MS = 60_000;
export const CLAUDE_BACKOFF_BASE_MS = 60_000;
export const CLAUDE_BACKOFF_MAX_MS = 60 * 60_000;

interface ClaudeOAuthCreds {
  accessToken: string;
  expiresAt: number | null;
}

interface BackoffState {
  untilMs: number;
  streak: number;
}

/** Soft cache so 429s don't wipe the last good spend/windows from the widget. */
let cachedOk: ProviderUsage | null = null;
let usageBackoff: BackoffState = { untilMs: 0, streak: 0 };
let nowFn: () => number = () => Date.now();

function nowMs(): number {
  return nowFn();
}

/** Wait after the Nth consecutive 429. Honors Retry-After when it is longer. */
export function nextClaudeBackoffMs(streak: number, retryAfterSec?: number | null): number {
  const n = Math.max(1, Math.floor(streak));
  const exp = Math.min(
    CLAUDE_BACKOFF_MAX_MS,
    CLAUDE_BACKOFF_BASE_MS * 2 ** Math.min(n - 1, 20),
  );
  const headerMs =
    typeof retryAfterSec === "number" && Number.isFinite(retryAfterSec) && retryAfterSec > 0
      ? retryAfterSec * 1000
      : 0;
  return Math.min(CLAUDE_BACKOFF_MAX_MS, Math.max(exp, headerMs));
}

function clearBackoff(): BackoffState {
  return { untilMs: 0, streak: 0 };
}

function apply429(state: BackoffState, retryAfterHeader: string | null): BackoffState {
  const parsed = Number(retryAfterHeader);
  const retryAfterSec = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  const streak = state.streak + 1;
  return {
    streak,
    untilMs: nowMs() + nextClaudeBackoffMs(streak, retryAfterSec),
  };
}

function inBackoff(state: BackoffState): boolean {
  return nowMs() < state.untilMs;
}

function rateLimitReason(untilMs: number): string {
  const waitMin = Math.max(1, Math.ceil((untilMs - nowMs()) / 60_000));
  return `Claude usage rate limited (retry in ~${waitMin}m)`;
}

function rateLimitUsage(untilMs: number, fetchedAt: string): ProviderUsage {
  const reason = rateLimitReason(untilMs);
  return {
    provider: "claude",
    label: "Claude",
    windows: unavailableAll(reason),
    fetchedAt,
    error: reason,
  };
}

function holdForBackoff(untilMs: number, fetchedAt: string): ProviderUsage {
  // Keep the cached fetchedAt so old data does not show as fresh.
  if (cachedOk) return cachedOk;
  return rateLimitUsage(untilMs, fetchedAt);
}

function claudeCredentialsPath(): string {
  return path.join(os.homedir(), ".claude", ".credentials.json");
}

function readClaudeOAuth(cfg: Config): ClaudeOAuthCreds | null {
  if (cfg.claude.accessToken) {
    return { accessToken: cfg.claude.accessToken, expiresAt: null };
  }
  const credPath = claudeCredentialsPath();
  if (!existsSync(credPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(credPath, "utf8")) as Record<string, unknown>;
    const oauth = raw.claudeAiOauth as Record<string, unknown> | undefined;
    if (typeof oauth?.accessToken !== "string" || !oauth.accessToken.trim()) return null;
    const expiresAt = Number(oauth.expiresAt);
    return {
      accessToken: oauth.accessToken.trim(),
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
    };
  } catch {
    return null;
  }
}

function readClaudeToken(cfg: Config): string | null {
  return readClaudeOAuth(cfg)?.accessToken ?? null;
}

function tokenExpired(expiresAt: number | null, atMs = nowMs()): boolean {
  if (expiresAt === null) return false;
  return atMs >= expiresAt - TOKEN_EXPIRY_SKEW_MS;
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

const TOKEN_EXPIRED_REASON = "Claude token expired — run `claude` to refresh it.";

function authErrorReason(status: number): string {
  if (status === 401) return TOKEN_EXPIRED_REASON;
  return `Claude usage HTTP ${status}`;
}

function errorUsage(reason: string, fetchedAt: string): ProviderUsage {
  return {
    provider: "claude",
    label: "Claude",
    windows: unavailableAll(reason),
    fetchedAt,
    error: reason,
  };
}

async function fetchUsageWithToken(token: string): Promise<Response> {
  return fetch(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
      "User-Agent": claudeUserAgent(),
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(10_000),
  });
}

export async function fetchClaudeUsage(cfg: Config): Promise<ProviderUsage> {
  const fetchedAt = new Date().toISOString();
  // Everything, the token read too, stays inside the try: one provider failure
  // must not reject Promise.all for /api/usage.
  try {
    const creds = readClaudeOAuth(cfg);
    if (!creds?.accessToken) {
      return errorUsage(
        "No Claude credentials. Sign in with Claude Code, or set CLAUDE_ACCESS_TOKEN / config.claude.accessToken.",
        fetchedAt,
      );
    }
    if (tokenExpired(creds.expiresAt)) return errorUsage(TOKEN_EXPIRED_REASON, fetchedAt);
    if (inBackoff(usageBackoff)) {
      return holdForBackoff(usageBackoff.untilMs, fetchedAt);
    }

    const res = await fetchUsageWithToken(creds.accessToken);
    if (res.status === 401) return errorUsage(TOKEN_EXPIRED_REASON, fetchedAt);
    if (res.status === 429) {
      usageBackoff = apply429(usageBackoff, res.headers.get("retry-after"));
      return holdForBackoff(usageBackoff.untilMs, fetchedAt);
    }
    if (!res.ok) {
      if (cachedOk) return cachedOk;
      return errorUsage(authErrorReason(res.status), fetchedAt);
    }
    const body = (await res.json()) as Record<string, unknown>;
    const usage = usageFromBody(body, fetchedAt);
    if (!usage.error) cachedOk = usage;
    usageBackoff = clearBackoff();
    return usage;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (cachedOk) return cachedOk;
    return errorUsage(msg, fetchedAt);
  }
}

export const __test = {
  mapOAuthUsage,
  mapSpendBalance,
  moneyFromMinor,
  usageFromBody,
  readClaudeToken,
  readClaudeOAuth,
  tokenExpired,
  authErrorReason,
  nextClaudeBackoffMs,
  CLAUDE_BACKOFF_MAX_MS,
  setNow(fn: (() => number) | null) {
    nowFn = fn ?? (() => Date.now());
  },
  resetCache() {
    cachedOk = null;
    usageBackoff = clearBackoff();
    nowFn = () => Date.now();
  },
};
