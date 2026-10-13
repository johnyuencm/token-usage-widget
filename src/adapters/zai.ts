import type { Config } from "../config.js";
import type { ProviderUsage, WindowId, WindowUsage } from "../types.js";
import { unavailableAll, okWindow } from "../types.js";

/** Z.AI / GLM coding-plan monitor quota (community endpoint). */

function mapQuota(body: unknown): Record<WindowId, WindowUsage> {
  const windows = unavailableAll("Z.AI did not report this window.");
  if (!body || typeof body !== "object") return windows;
  const root = body as Record<string, unknown>;
  const data = root.data as Record<string, unknown> | unknown[] | undefined;
  const limits = (root.limits ??
    (Array.isArray(data) ? data : data?.limits) ??
    root) as unknown;
  if (!Array.isArray(limits)) return windows;

  for (const raw of limits) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const name = String(item.type ?? item.name ?? item.limitType ?? "").toLowerCase();
    const used = Number(item.percentage ?? item.usagePercent ?? item.usedPercent);
    if (!Number.isFinite(used)) continue;
    const resetMs = Number(item.nextResetTime ?? item.resetTime ?? item.resetsAt);
    const resetsAtIso = Number.isFinite(resetMs) && resetMs > 1e12 ? new Date(resetMs).toISOString() : null;
    let id: WindowId | null = null;
    if (name.includes("session") || name.includes("5") || name.includes("token")) id = "five_hour";
    else if (name.includes("week")) id = "week";
    else if (name.includes("month")) id = "month";
    if (id) windows[id] = okWindow(used, resetsAtIso);
  }
  return windows;
}

export async function fetchZaiUsage(cfg: Config): Promise<ProviderUsage> {
  const fetchedAt = new Date().toISOString();
  const key = cfg.zai.apiKey;
  if (!key) {
    const reason = "Set ZAI_API_KEY or GLM_API_KEY.";
    return {
      provider: "zai",
      label: "Z.AI / GLM",
      windows: unavailableAll(reason),
      fetchedAt,
      error: reason,
    };
  }

  try {
    const res = await fetch("https://api.z.ai/api/monitor/usage/quota/limit", {
      headers: { Authorization: key, Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const reason = `Z.AI quota HTTP ${res.status}`;
      return {
        provider: "zai",
        label: "Z.AI / GLM",
        windows: unavailableAll(reason),
        fetchedAt,
        error: reason,
      };
    }
    const body = await res.json();
    return {
      provider: "zai",
      label: "Z.AI / GLM",
      windows: mapQuota(body),
      fetchedAt,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      provider: "zai",
      label: "Z.AI / GLM",
      windows: unavailableAll(msg),
      fetchedAt,
      error: msg,
    };
  }
}

export const __test = { mapQuota };
