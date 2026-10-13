import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Config } from "../config.js";
import type { ProviderUsage, WindowId, WindowUsage } from "../types.js";
import { unavailableAll, okWindow } from "../types.js";

function readKimiKey(cfg: Config): string | null {
  if (cfg.kimi.apiKey) return cfg.kimi.apiKey;
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
}

function pctFromLimit(used: number, limit: number): number | null {
  if (!(limit > 0) || !Number.isFinite(used)) return null;
  return Math.min(100, Math.max(0, (used / limit) * 100));
}

function mapUsages(body: unknown): Record<WindowId, WindowUsage> {
  const windows = unavailableAll("Kimi Code did not report this window.");
  if (!body || typeof body !== "object") return windows;
  const root = body as Record<string, unknown>;
  const list = (root.data ?? root.usages ?? root.windows ?? body) as unknown;

  const apply = (id: WindowId, item: Record<string, unknown>) => {
    const used = Number(item.used ?? item.usage ?? item.consumed);
    const limit = Number(item.limit ?? item.total ?? item.quota);
    const remaining = Number(item.remaining);
    let usedPct = pctFromLimit(used, limit);
    if (usedPct === null && Number.isFinite(remaining) && Number.isFinite(limit) && limit > 0) {
      usedPct = Math.min(100, Math.max(0, ((limit - remaining) / limit) * 100));
    }
    if (usedPct === null && Number.isFinite(Number(item.usedPercent))) {
      usedPct = Number(item.usedPercent);
    }
    if (usedPct === null) return;
    const reset =
      typeof item.resetTime === "string"
        ? item.resetTime
        : typeof item.reset_time === "string"
          ? item.reset_time
          : typeof item.resetsAt === "string"
            ? item.resetsAt
            : null;
    windows[id] = okWindow(usedPct, reset);
  };

  if (Array.isArray(list)) {
    for (const raw of list) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as Record<string, unknown>;
      const name = String(item.name ?? item.type ?? item.window ?? "").toLowerCase();
      if (name.includes("300") || name.includes("5h") || name.includes("session") || name.includes("rolling")) {
        apply("five_hour", item);
      } else if (name.includes("week")) {
        apply("week", item);
      } else if (name.includes("month")) {
        apply("month", item);
      }
    }
  } else if (list && typeof list === "object") {
    const o = list as Record<string, unknown>;
    for (const [key, val] of Object.entries(o)) {
      if (!val || typeof val !== "object") continue;
      const item = val as Record<string, unknown>;
      const k = key.toLowerCase();
      if (k.includes("5") || k.includes("300") || k.includes("session")) apply("five_hour", item);
      else if (k.includes("week")) apply("week", item);
      else if (k.includes("month")) apply("month", item);
    }
  }
  return windows;
}

export async function fetchKimiUsage(cfg: Config): Promise<ProviderUsage> {
  const fetchedAt = new Date().toISOString();
  const key = readKimiKey(cfg);
  if (!key) {
    const reason = "Set KIMI_CODE_API_KEY or ~/.kimi/credentials/kimi-code.json.";
    return {
      provider: "kimi",
      label: "Kimi Code",
      windows: unavailableAll(reason),
      fetchedAt,
      error: reason,
    };
  }

  try {
    const res = await fetch("https://api.kimi.com/coding/v1/usages", {
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
        "User-Agent": "KimiCLI/1.0",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const reason = `Kimi Code usages HTTP ${res.status}`;
      return {
        provider: "kimi",
        label: "Kimi Code",
        windows: unavailableAll(reason),
        fetchedAt,
        error: reason,
      };
    }
    const body = await res.json();
    return {
      provider: "kimi",
      label: "Kimi Code",
      windows: mapUsages(body),
      fetchedAt,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      provider: "kimi",
      label: "Kimi Code",
      windows: unavailableAll(msg),
      fetchedAt,
      error: msg,
    };
  }
}

export const __test = { mapUsages };
