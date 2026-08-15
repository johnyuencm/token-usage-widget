export type ProviderId =
  | "openai"
  | "opencode"
  | "cursor"
  | "claude"
  | "openrouter"
  | "kimi"
  | "zai"
  | "grok";

export type WindowId = "five_hour" | "week" | "month";

export type WindowStatus = "ok" | "unavailable" | "error";

export interface WindowUsage {
  usedPercent: number | null;
  remainingPercent: number | null;
  usedTokens?: number | null;
  resetsAtIso?: string | null;
  status: WindowStatus;
  reason?: string;
}

/** Cursor Pro+/billing-style breakdown (Total + First-party + API). */
export interface CursorBillingBreakdown {
  planLabel: string;
  totalPercentUsed: number | null;
  autoPercentUsed: number | null;
  apiPercentUsed: number | null;
  remainingPercent: number | null;
  resetsAtIso?: string | null;
  autoNote?: string;
  apiNote?: string;
  displayMessage?: string;
}

/** Prepaid / credit balance (OpenRouter, some xAI paths). */
export interface BalanceBreakdown {
  currency: "USD" | "credits";
  remaining: number | null;
  used?: number | null;
  total?: number | null;
  label?: string;
  resetsAtIso?: string | null;
}

export interface ProviderUsage {
  provider: ProviderId;
  label: string;
  windows: Record<WindowId, WindowUsage>;
  /** Present for Cursor — UI renders billing card instead of 5h/week/month meters. */
  billing?: CursorBillingBreakdown;
  /** Prepaid balance providers (e.g. OpenRouter). */
  balance?: BalanceBreakdown;
  fetchedAt: string;
  error?: string;
}

export interface UsageResponse {
  fetchedAt: string;
  fixture: boolean;
  providers: ProviderUsage[];
  ui?: import("./ui-settings.js").UiSettings;
}

export const ALL_PROVIDER_IDS: ProviderId[] = [
  "openai",
  "opencode",
  "cursor",
  "claude",
  "openrouter",
  "kimi",
  "zai",
  "grok",
];

export function unavailableAll(reason: string): Record<WindowId, WindowUsage> {
  const w = (): WindowUsage => ({
    usedPercent: null,
    remainingPercent: null,
    status: "unavailable",
    reason,
  });
  return { five_hour: w(), week: w(), month: w() };
}

export function okWindow(
  usedPercent: number,
  resetsAtIso?: string | null,
): WindowUsage {
  const used = Math.min(100, Math.max(0, usedPercent));
  return {
    usedPercent: used,
    remainingPercent: Math.max(0, 100 - used),
    resetsAtIso: resetsAtIso ?? null,
    status: "ok",
  };
}
