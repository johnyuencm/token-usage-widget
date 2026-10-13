import type { ProviderUsage, UsageResponse, WindowId, WindowUsage } from "./types.js";
import { unavailableAll } from "./types.js";
import type { ProviderFlags } from "./config.js";

function isoFromUnix(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString();
}

function okWindow(usedPercent: number, resetsAtUnix?: number): WindowUsage {
  return {
    usedPercent,
    remainingPercent: Math.max(0, 100 - usedPercent),
    resetsAtIso: resetsAtUnix ? isoFromUnix(resetsAtUnix) : null,
    status: "ok",
  };
}

function unavailableWindow(reason: string): WindowUsage {
  return {
    usedPercent: null,
    remainingPercent: null,
    status: "unavailable",
    reason,
  };
}

function openaiFixture(): ProviderUsage {
  // Live-probe-style payload: primary is weekly-only (secondary null).
  // five_hour and month are unavailable with a reason, not fake %.
  const now = Math.floor(Date.now() / 1000);
  const weekReset = now + 3 * 24 * 3600 + 5 * 3600;
  const windows: Record<WindowId, WindowUsage> = {
    five_hour: unavailableWindow("Codex app-server did not report a 5h window for this plan."),
    week: okWindow(34, weekReset),
    month: unavailableWindow("Codex app-server did not report a monthly window for this plan."),
  };
  return {
    provider: "openai",
    label: "OpenAI Codex",
    windows,
    fetchedAt: new Date().toISOString(),
  };
}

function cursorFixture(): ProviderUsage {
  const cycleEndMs = Date.now() + 12 * 24 * 3600 * 1000;
  const windows: Record<WindowId, WindowUsage> = {
    five_hour: unavailableWindow("Cursor does not expose a 5-hour rolling usage window."),
    week: unavailableWindow("Cursor does not expose a weekly rolling usage window."),
    month: okWindow(23, Math.floor(cycleEndMs / 1000)),
  };
  return {
    provider: "cursor",
    label: "Cursor",
    windows,
    billing: {
      planLabel: "Included in Pro+",
      totalPercentUsed: 23,
      autoPercentUsed: 13,
      apiPercentUsed: 99,
      remainingPercent: 77,
      resetsAtIso: new Date(cycleEndMs).toISOString(),
      autoNote: "Additional usage beyond limits consumes API quota or on-demand spend.",
      apiNote:
        "Additional usage beyond limits consumes on-demand spend. Your plan includes at least $70 of API usage.",
      displayMessage: "You've hit your usage limit",
    },
    fetchedAt: new Date().toISOString(),
  };
}

function claudeFixture(): ProviderUsage {
  const now = Math.floor(Date.now() / 1000);
  return {
    provider: "claude",
    label: "Claude",
    windows: {
      five_hour: okWindow(42, now + 3 * 3600),
      week: okWindow(61, now + 4 * 24 * 3600),
      month: unavailableWindow("Claude OAuth usage does not report a monthly window."),
    },
    fetchedAt: new Date().toISOString(),
  };
}

function openrouterFixture(): ProviderUsage {
  return {
    provider: "openrouter",
    label: "OpenRouter",
    windows: unavailableAll("OpenRouter is prepaid credits — no 5h/week/month plan windows."),
    balance: {
      currency: "USD",
      remaining: 12.34,
      used: 7.66,
      total: 20,
      label: "Credits remaining",
    },
    fetchedAt: new Date().toISOString(),
  };
}

function kimiFixture(): ProviderUsage {
  const now = Math.floor(Date.now() / 1000);
  return {
    provider: "kimi",
    label: "Kimi Code",
    windows: {
      five_hour: okWindow(18, now + 2 * 3600),
      week: okWindow(55, now + 5 * 24 * 3600),
      month: unavailableWindow("Kimi Code did not report a monthly window."),
    },
    fetchedAt: new Date().toISOString(),
  };
}

function zaiFixture(): ProviderUsage {
  const now = Math.floor(Date.now() / 1000);
  return {
    provider: "zai",
    label: "Z.AI / GLM",
    windows: {
      five_hour: okWindow(27, now + 4 * 3600),
      week: okWindow(70, now + 3 * 24 * 3600),
      month: unavailableWindow("Z.AI did not report a monthly window."),
    },
    fetchedAt: new Date().toISOString(),
  };
}

function grokFixture(): ProviderUsage {
  const resetIso = new Date(Date.now() + 20 * 24 * 3600 * 1000).toISOString();
  return {
    provider: "grok",
    label: "Grok Build",
    windows: {
      five_hour: unavailableWindow("Grok Build exposes a billing-period credit pool, not separate 5h/week windows."),
      week: unavailableWindow("Grok Build exposes a billing-period credit pool, not separate 5h/week windows."),
      month: okWindow(35, Math.floor(Date.parse(resetIso) / 1000)),
    },
    balance: {
      currency: "credits",
      remaining: 650,
      used: 350,
      total: 1000,
      label: "Build credits",
      resetsAtIso: resetIso,
    },
    fetchedAt: new Date().toISOString(),
  };
}

export function buildFixtureResponse(
  enabled?: ProviderFlags,
): UsageResponse {
  const all: ProviderUsage[] = [
    openaiFixture(),
    cursorFixture(),
    claudeFixture(),
    openrouterFixture(),
    kimiFixture(),
    zaiFixture(),
    grokFixture(),
  ];
  const providers = enabled
    ? all.filter((p) => enabled[p.provider] === true)
    : all;
  return {
    fetchedAt: new Date().toISOString(),
    fixture: true,
    providers,
  };
}
