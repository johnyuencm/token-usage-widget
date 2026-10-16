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

/** Seconds from a positive finite number, clamped. 0, null, "" and NaN mean "not set". */
function positiveIntervalSec(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? clampIntervalSec(n) : undefined;
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
    const sec = typeof src[id] === "number" ? positiveIntervalSec(src[id]) : undefined;
    if (sec !== undefined) out[id] = sec;
  }
  return out;
}

/** Merge persisted JSON into canonical defaults. */
export function mergeUiSettings(incoming: unknown): UiSettings {
  if (!incoming || typeof incoming !== "object") return structuredClone(DEFAULT_UI);
  const src = incoming as Record<string, unknown>;
  const display = (src.display as Record<string, unknown> | undefined) ?? {};
  return {
    refreshIntervalSec: positiveIntervalSec(src.refreshIntervalSec) ?? DEFAULT_UI.refreshIntervalSec,
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

function sentFlags<T>(src: unknown): Partial<T> | undefined {
  if (!src || typeof src !== "object") return undefined;
  return Object.fromEntries(Object.entries(src).filter(([, v]) => typeof v === "boolean")) as Partial<T>;
}

export function parseUiPatch(body: unknown): Partial<UiSettings> {
  if (!body || typeof body !== "object") return {};
  const src = body as Record<string, unknown>;
  const patch: Partial<UiSettings> = {};
  // A value that is not a positive number (blank select, null) keeps the current one.
  const refresh = positiveIntervalSec(src.refreshIntervalSec);
  if (refresh !== undefined) patch.refreshIntervalSec = refresh;
  if (src.pollIntervalSec !== undefined) {
    patch.pollIntervalSec = mergePollIntervals({}, src.pollIntervalSec);
  }
  if (src.display !== undefined && typeof src.display === "object") {
    const d = src.display as Record<string, unknown>;
    // Keep only the flags sent, so applyUiPatch keeps the current siblings.
    patch.display = {
      claude: sentFlags<ClaudeDisplaySettings>(d.claude),
      cursor: sentFlags<CursorDisplaySettings>(d.cursor),
    } as UiSettings["display"];
  }
  return patch;
}

export function applyUiPatch(current: UiSettings, patch: Partial<UiSettings>): UiSettings {
  return mergeUiSettings({
    refreshIntervalSec: patch.refreshIntervalSec ?? current.refreshIntervalSec,
    pollIntervalSec: { ...current.pollIntervalSec, ...(patch.pollIntervalSec ?? {}) },
    display: {
      claude: { ...current.display.claude, ...patch.display?.claude },
      cursor: { ...current.display.cursor, ...patch.display?.cursor },
    },
  });
}
