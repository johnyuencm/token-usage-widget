import type { ProviderId, WindowId } from "./types.js";
import { ALL_PROVIDER_IDS } from "./types.js";

export type CursorBillingField = "total" | "auto" | "api";

export interface ClaudeDisplaySettings {
  fiveHour: boolean;
  week: boolean;
  spend: boolean;
}

export interface CursorDisplaySettings {
  total: boolean;
  auto: boolean;
  api: boolean;
}

export interface UiSettings {
  /** How often dashboard/widget call /api/usage. */
  refreshIntervalSec: number;
  /** Minimum seconds between upstream provider API calls (per id). */
  pollIntervalSec: Partial<Record<ProviderId, number>>;
  display: {
    claude: ClaudeDisplaySettings;
    cursor: CursorDisplaySettings;
  };
}

export const DEFAULT_CLAUDE_DISPLAY: ClaudeDisplaySettings = {
  fiveHour: true,
  week: true,
  spend: true,
};

export const DEFAULT_CURSOR_DISPLAY: CursorDisplaySettings = {
  total: true,
  auto: true,
  api: true,
};

export const DEFAULT_UI: UiSettings = {
  refreshIntervalSec: 60,
  pollIntervalSec: { claude: 300 },
  display: {
    claude: { ...DEFAULT_CLAUDE_DISPLAY },
    cursor: { ...DEFAULT_CURSOR_DISPLAY },
  },
};

const MIN_INTERVAL_SEC = 30;
const MAX_INTERVAL_SEC = 3600;

function clampIntervalSec(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_UI.refreshIntervalSec;
  return Math.min(MAX_INTERVAL_SEC, Math.max(MIN_INTERVAL_SEC, Math.round(n)));
}

function boolOr(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function mergeClaudeDisplay(src: unknown): ClaudeDisplaySettings {
  const base = { ...DEFAULT_CLAUDE_DISPLAY };
  if (!src || typeof src !== "object") return base;
  const o = src as Record<string, unknown>;
  return {
    fiveHour: boolOr(o.fiveHour, base.fiveHour),
    week: boolOr(o.week, base.week),
    spend: boolOr(o.spend, base.spend),
  };
}

function mergeCursorDisplay(src: unknown): CursorDisplaySettings {
  const base = { ...DEFAULT_CURSOR_DISPLAY };
  if (!src || typeof src !== "object") return base;
  const o = src as Record<string, unknown>;
  return {
    total: boolOr(o.total, base.total),
    auto: boolOr(o.auto, base.auto),
    api: boolOr(o.api, base.api),
  };
}

function mergePollIntervals(base: Partial<Record<ProviderId, number>>, incoming: unknown): Partial<Record<ProviderId, number>> {
  const out = { ...base };
  if (!incoming || typeof incoming !== "object") return out;
  const src = incoming as Record<string, unknown>;
  for (const id of ALL_PROVIDER_IDS) {
    const val = src[id];
    if (typeof val === "number" && Number.isFinite(val)) out[id] = clampIntervalSec(val);
  }
  return out;
}

/** Merge persisted JSON into canonical defaults. */
export function mergeUiSettings(incoming: unknown): UiSettings {
  if (!incoming || typeof incoming !== "object") return structuredClone(DEFAULT_UI);
  const src = incoming as Record<string, unknown>;
  const display = (src.display as Record<string, unknown> | undefined) ?? {};
  return {
    refreshIntervalSec: clampIntervalSec(Number(src.refreshIntervalSec ?? DEFAULT_UI.refreshIntervalSec)),
    pollIntervalSec: mergePollIntervals(DEFAULT_UI.pollIntervalSec, src.pollIntervalSec),
    display: {
      claude: mergeClaudeDisplay(display.claude),
      cursor: mergeCursorDisplay(display.cursor),
    },
  };
}

export function resolvePollIntervalSec(id: ProviderId, ui: UiSettings): number {
  const specific = ui.pollIntervalSec[id];
  if (typeof specific === "number" && Number.isFinite(specific)) return clampIntervalSec(specific);
  return clampIntervalSec(ui.refreshIntervalSec);
}

export function claudeWindowIds(display: ClaudeDisplaySettings): WindowId[] {
  const out: WindowId[] = [];
  if (display.fiveHour) out.push("five_hour");
  if (display.week) out.push("week");
  return out;
}

export function cursorBillingFields(display: CursorDisplaySettings): CursorBillingField[] {
  const out: CursorBillingField[] = [];
  if (display.total) out.push("total");
  if (display.auto) out.push("auto");
  if (display.api) out.push("api");
  return out;
}

export function parseUiPatch(body: unknown): Partial<UiSettings> {
  if (!body || typeof body !== "object") return {};
  const src = body as Record<string, unknown>;
  const patch: Partial<UiSettings> = {};
  if (src.refreshIntervalSec !== undefined) {
    patch.refreshIntervalSec = clampIntervalSec(Number(src.refreshIntervalSec));
  }
  if (src.pollIntervalSec !== undefined) {
    patch.pollIntervalSec = mergePollIntervals({}, src.pollIntervalSec);
  }
  if (src.display !== undefined && typeof src.display === "object") {
    const d = src.display as Record<string, unknown>;
    patch.display = {
      claude: d.claude !== undefined ? mergeClaudeDisplay(d.claude) : undefined,
      cursor: d.cursor !== undefined ? mergeCursorDisplay(d.cursor) : undefined,
    } as UiSettings["display"];
  }
  return patch;
}

export function applyUiPatch(current: UiSettings, patch: Partial<UiSettings>): UiSettings {
  return mergeUiSettings({
    refreshIntervalSec: patch.refreshIntervalSec ?? current.refreshIntervalSec,
    pollIntervalSec: { ...current.pollIntervalSec, ...(patch.pollIntervalSec ?? {}) },
    display: {
      claude: patch.display?.claude ?? current.display.claude,
      cursor: patch.display?.cursor ?? current.display.cursor,
    },
  });
}
