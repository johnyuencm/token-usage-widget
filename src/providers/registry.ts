import type { Config } from "../config.js";
import type { ProviderId, ProviderUsage } from "../types.js";
import { unavailableAll } from "../types.js";
import { fetchOpenAIUsage } from "../adapters/openai.js";
import { fetchCursorUsage } from "../adapters/cursor.js";
import { fetchClaudeUsage } from "../adapters/claude.js";
import { fetchOpenRouterUsage } from "../adapters/openrouter.js";
import { fetchKimiUsage } from "../adapters/kimi.js";
import { fetchZaiUsage } from "../adapters/zai.js";
import { fetchGrokUsage } from "../adapters/grok.js";

export interface ProviderMeta {
  id: ProviderId;
  label: string;
  /** Short blurb for setup CLI. */
  blurb: string;
  /** How setup detects existing credentials. */
  detectHint: string;
}

export const PROVIDER_META: ProviderMeta[] = [
  {
    id: "openai",
    label: "OpenAI Codex",
    blurb: "Codex CLI session rate limits (5h / week / month).",
    detectHint: "Uses logged-in `codex` / codex-status-mcp (no key in config).",
  },
  {
    id: "cursor",
    label: "Cursor",
    blurb: "Pro+ billing cycle (total / first-party / API).",
    detectHint: "Reads Cursor desktop login token from state.vscdb.",
  },
  {
    id: "claude",
    label: "Claude",
    blurb: "Claude Code / Claude.ai subscription windows (5h / week).",
    detectHint: "~/.claude/.credentials.json OAuth, or CLAUDE_ACCESS_TOKEN.",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    blurb: "Prepaid credit balance ($).",
    detectHint: "OPENROUTER_API_KEY or config openrouter.apiKey (management/credits key).",
  },
  {
    id: "kimi",
    label: "Kimi Code",
    blurb: "Kimi Code subscription usages (5h / week).",
    detectHint: "KIMI_CODE_API_KEY or ~/.kimi/credentials/kimi-code.json.",
  },
  {
    id: "zai",
    label: "Z.AI / GLM",
    blurb: "Z.AI coding-plan session + weekly quota.",
    detectHint: "ZAI_API_KEY / GLM_API_KEY.",
  },
  {
    id: "grok",
    label: "Grok Build",
    blurb: "xAI Grok CLI / Build subscription credits.",
    detectHint: "`grok login` → ~/.grok/auth.json, or GROK_CLI_OAUTH_TOKEN.",
  },
];

type Fetcher = (cfg: Config) => Promise<ProviderUsage>;

const FETCHERS: Record<ProviderId, Fetcher> = {
  openai: async () => fetchOpenAIUsage(),
  cursor: async () => fetchCursorUsage(),
  claude: (cfg) => fetchClaudeUsage(cfg),
  openrouter: (cfg) => fetchOpenRouterUsage(cfg),
  kimi: (cfg) => fetchKimiUsage(cfg),
  zai: (cfg) => fetchZaiUsage(cfg),
  grok: (cfg) => fetchGrokUsage(cfg),
};

/** Never rejects: one provider failure must not fail Promise.all for /api/usage. */
export async function fetchProvider(id: ProviderId, cfg: Config): Promise<ProviderUsage> {
  try {
    return await FETCHERS[id](cfg);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      provider: id,
      label: PROVIDER_META.find((m) => m.id === id)?.label ?? id,
      windows: unavailableAll(msg),
      fetchedAt: new Date().toISOString(),
      error: msg,
    };
  }
}

export async function fetchEnabledProviders(cfg: Config): Promise<ProviderUsage[]> {
  const ids = PROVIDER_META.map((m) => m.id).filter((id) => cfg.providers[id]);
  return Promise.all(ids.map((id) => fetchProvider(id, cfg)));
}
