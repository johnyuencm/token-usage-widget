import type { Config } from "../config.js";
import { resolvePollIntervalSec } from "../ui-settings.js";
import type { ProviderId, ProviderUsage } from "../types.js";
import { fetchProvider } from "./registry.js";

/** `errorRetry`: good data kept after one error; it expires after ERROR_RETRY_MS. */
const cache = new Map<ProviderId, { fetchedAtMs: number; usage: ProviderUsage; errorRetry?: boolean }>();
const inflight = new Map<ProviderId, Promise<ProviderUsage>>();

/** A widget tick can arrive a little early; without a margin it gets data one period old. */
const TICK_MARGIN_MS = 5_000;
const ERROR_RETRY_MS = 30_000;

export function resetPollCache(): void {
  cache.clear();
  inflight.clear();
}

export async function fetchProviderThrottled(id: ProviderId, cfg: Config): Promise<ProviderUsage> {
  const minMs = resolvePollIntervalSec(id, cfg.ui) * 1000;
  const ttlMs = Math.max(minMs - TICK_MARGIN_MS, minMs / 2);
  const retryMs = Math.min(ERROR_RETRY_MS, ttlMs);
  const now = Date.now();
  const hit = cache.get(id);
  if (hit && now - hit.fetchedAtMs < (hit.errorRetry ? retryMs : ttlMs)) {
    // Keep the original fetchedAt so cached data does not show as fresh.
    return hit.usage;
  }
  const pending = inflight.get(id);
  if (pending) {
    return pending;
  }
  const startedAt = now;
  const p = fetchProvider(id, cfg)
    .then((usage) => {
      const prev = cache.get(id);
      // Only data from the last regular poll counts: after a long gap (sleep, idle)
      // old data must not hide an error, and the adapter's own age cap must hold.
      const recent = prev && startedAt - prev.fetchedAtMs <= 2 * minMs;
      if (usage.error && prev && recent && !prev.usage.error && !prev.errorRetry) {
        // One error keeps the last good data (its own fetchedAt shows its age) and
        // retries soon. A second error in a row shows, so a lasting failure is not hidden.
        cache.set(id, { fetchedAtMs: startedAt, usage: prev.usage, errorRetry: true });
        return prev.usage;
      }
      cache.set(id, { fetchedAtMs: startedAt, usage });
      return usage;
    })
    .finally(() => {
      // A reset mid-fetch can start a newer fetch; do not delete its entry.
      if (inflight.get(id) === p) inflight.delete(id);
    });
  inflight.set(id, p);
  return p;
}

export async function fetchEnabledProvidersThrottled(cfg: Config): Promise<ProviderUsage[]> {
  const ids = (Object.keys(cfg.providers) as ProviderId[]).filter((id) => cfg.providers[id]);
  return Promise.all(ids.map((id) => fetchProviderThrottled(id, cfg)));
}

export const __test = { resetPollCache, cache, inflight };
