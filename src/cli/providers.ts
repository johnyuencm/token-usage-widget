/**
 * Single-provider toggles: tuw enable|disable <id>, tuw providers
 */
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import { ALL_PROVIDER_IDS, type ProviderId } from "../types.js";
import { PROVIDER_META } from "../providers/registry.js";
import {
  SECRET_BY_PROVIDER,
  applySecret,
  ensureClaudeCredentials,
  loadExisting,
  parseProviderId,
  readProviderFlags,
  secretDetectNote,
  setProviderEnabled,
  writeConfig,
  type EnsureClaudeDeps,
} from "./provider-config.js";
import { refreshRuntime, type RefreshRuntimeDeps } from "./refresh-runtime.js";

export type AskLineFn = (question: string) => Promise<string>;

export interface ProviderCliDeps {
  loadExisting?: () => Record<string, unknown>;
  writeConfig?: (merged: Record<string, unknown>) => void;
  askLine?: AskLineFn;
  ensureClaude?: typeof ensureClaudeCredentials;
  ensureClaudeDeps?: EnsureClaudeDeps;
  refreshRuntime?: (deps?: RefreshRuntimeDeps) => Promise<void>;
  refreshDeps?: RefreshRuntimeDeps;
  log?: (msg: string) => void;
}

function defaultAskLine(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function promptSecretIfNeeded(
  id: ProviderId,
  existing: Record<string, unknown>,
  askLine: AskLineFn,
): Promise<void> {
  const secret = SECRET_BY_PROVIDER[id];
  if (!secret) return;
  const detected = secret.detect();
  if (detected) return;
  const note = secretDetectNote(secret, detected);
  const value = await askLine(`${secret.prompt}${note}: `);
  if (value) applySecret(existing, secret.kind, value);
}

export async function enableProvider(idRaw: string, deps: ProviderCliDeps = {}): Promise<void> {
  const id = parseProviderId(idRaw);
  const load = deps.loadExisting ?? loadExisting;
  const write = deps.writeConfig ?? writeConfig;
  const askLine = deps.askLine ?? defaultAskLine;
  const ensureClaude = deps.ensureClaude ?? ensureClaudeCredentials;
  const refresh = deps.refreshRuntime ?? refreshRuntime;
  const log = deps.log ?? ((msg: string) => {
    // eslint-disable-next-line no-console
    console.log(msg);
  });

  const existing = load();
  await promptSecretIfNeeded(id, existing, askLine);
  const merged = setProviderEnabled(existing, id, true);
  write(merged);
  log(`Enabled ${id}.`);

  if (readProviderFlags(merged).claude) {
    ensureClaude(merged, deps.ensureClaudeDeps);
  }

  await refresh(deps.refreshDeps);
}

export async function disableProvider(idRaw: string, deps: ProviderCliDeps = {}): Promise<void> {
  const id = parseProviderId(idRaw);
  const load = deps.loadExisting ?? loadExisting;
  const write = deps.writeConfig ?? writeConfig;
  const refresh = deps.refreshRuntime ?? refreshRuntime;
  const log = deps.log ?? ((msg: string) => {
    // eslint-disable-next-line no-console
    console.log(msg);
  });

  const existing = load();
  const merged = setProviderEnabled(existing, id, false);
  write(merged);
  log(`Disabled ${id}.`);
  await refresh(deps.refreshDeps);
}

export function listProviders(deps: ProviderCliDeps = {}): void {
  const load = deps.loadExisting ?? loadExisting;
  const log = deps.log ?? ((msg: string) => {
    // eslint-disable-next-line no-console
    console.log(msg);
  });
  const flags = readProviderFlags(load());
  const width = Math.max(...ALL_PROVIDER_IDS.map((id) => id.length));
  for (const id of ALL_PROVIDER_IDS) {
    const meta = PROVIDER_META.find((m) => m.id === id);
    const label = meta?.label ?? id;
    const state = flags[id] ? "on" : "off";
    log(`${id.padEnd(width)}  ${state.padEnd(3)}  ${label}`);
  }
}

export async function runProviderCommand(
  args: string[],
  deps: ProviderCliDeps = {},
): Promise<void> {
  const [cmd, id] = args;
  if (cmd === "providers" || cmd === "list") {
    listProviders(deps);
    return;
  }
  if (cmd === "enable") {
    if (!id) throw new Error(`Usage: tuw enable <provider>\nValid: ${ALL_PROVIDER_IDS.join(", ")}`);
    await enableProvider(id, deps);
    return;
  }
  if (cmd === "disable") {
    if (!id) throw new Error(`Usage: tuw disable <provider>\nValid: ${ALL_PROVIDER_IDS.join(", ")}`);
    await disableProvider(id, deps);
    return;
  }
  throw new Error(`Unknown provider command: ${cmd}`);
}

async function main(): Promise<void> {
  try {
    // argv: node providers.js <enable|disable|providers> [id]
    // When invoked via tuw, bin passes the subcommand as first arg.
    await runProviderCommand(process.argv.slice(2));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(msg);
    process.exit(1);
  }
}

const invokedDirectly =
  typeof process !== "undefined" &&
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  void main();
}
