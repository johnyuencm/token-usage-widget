import type { Config } from "../config.js";
import { resolvePollIntervalSec } from "../ui-settings.js";
import type { ProviderId, ProviderUsage } from "../types.js";
import { fetchProvider } from "./registry.js";

const cache = new Map<ProviderId, { fetchedAtMs: number; usage: ProviderUsage }>();
const inflight = new Map<ProviderId, Promise<ProviderUsage>>();

export function resetPollCache(): void {
  cache.clear();
  inflight.clear();
}

export async function fetchProviderThrottled(id: ProviderId, cfg: Config): Promise<ProviderUsage> {
  const minMs = resolvePollIntervalSec(id, cfg.ui) * 1000;
  const now = Date.now();
  const hit = cache.get(id);
  if (hit && now - hit.fetchedAtMs < minMs) {
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
      cache.set(id, { fetchedAtMs: startedAt, usage });
      return usage;
    })
    .finally(() => {
      inflight.delete(id);
    });
  inflight.set(id, p);
  return p;
}

export async function fetchEnabledProvidersThrottled(cfg: Config): Promise<ProviderUsage[]> {
  const ids = (Object.keys(cfg.providers) as ProviderId[]).filter((id) => cfg.providers[id]);
  return Promise.all(ids.map((id) => fetchProviderThrottled(id, cfg)));
}

export const __test = { resetPollCache, cache, inflight };
