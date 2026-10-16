import type { Config } from "../config.js";
import type { ProviderUsage } from "../types.js";
import { unavailableAll } from "../types.js";

/** Official OpenRouter credits API → prepaid USD balance. */

/** Number(null) and Number("") are 0. Read them as missing, not as 0. */
function num(v: unknown): number {
  return v === null || v === "" ? NaN : Number(v);
}

export async function fetchOpenRouterUsage(cfg: Config): Promise<ProviderUsage> {
  const fetchedAt = new Date().toISOString();
  const key = cfg.openrouter.apiKey;
  if (!key) {
    const reason = "Set OPENROUTER_API_KEY or config.openrouter.apiKey (credits/management key).";
    return {
      provider: "openrouter",
      label: "OpenRouter",
      windows: unavailableAll(reason),
      fetchedAt,
      error: reason,
    };
  }

  try {
    const res = await fetch("https://openrouter.ai/api/v1/credits", {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const reason = `OpenRouter credits HTTP ${res.status}`;
      return {
        provider: "openrouter",
        label: "OpenRouter",
        windows: unavailableAll(reason),
        fetchedAt,
        error: reason,
      };
    }
    const json = (await res.json()) as {
      data?: { total_credits?: number; total_usage?: number };
      total_credits?: number;
      total_usage?: number;
    };
    const data = json.data ?? json;
    const total = num(data.total_credits);
    const used = num(data.total_usage);
    const remaining =
      Number.isFinite(total) && Number.isFinite(used) ? Math.max(0, total - used) : null;

    return {
      provider: "openrouter",
      label: "OpenRouter",
      windows: unavailableAll("OpenRouter is prepaid credits — no 5h/week/month plan windows."),
      balance: {
        currency: "USD",
        remaining,
        used: Number.isFinite(used) ? used : null,
        total: Number.isFinite(total) ? total : null,
        label: "Credits remaining",
      },
      fetchedAt,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      provider: "openrouter",
      label: "OpenRouter",
      windows: unavailableAll(msg),
      fetchedAt,
      error: msg,
    };
  }
}
