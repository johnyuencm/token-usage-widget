import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * True when the module at `metaUrl` is the script that node runs. Node loads
 * the real path of argv[1], so resolve a junction or symlink in it first;
 * else a CLI reached through a link does nothing and exits 0.
 */
export function isEntryModule(metaUrl: string): boolean {
  const entry = typeof process !== "undefined" ? process.argv[1] : undefined;
  if (!entry) return false;
  try {
    return pathToFileURL(realpathSync(entry)).href === metaUrl;
  } catch {
    return false;
  }
}
