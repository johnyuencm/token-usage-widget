import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import {
  copySqliteSidecars,
  removeSqliteSidecars,
  sqliteScalar,
} from "../sqlite-scalar.js";
import type {
  CursorBillingBreakdown,
  ProviderUsage,
  WindowId,
  WindowUsage,
} from "../types.js";

const DASHBOARD_URL =
  "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage";

export interface CursorPeriodUsage {
  billingCycleStart?: string | number;
  billingCycleEnd?: string | number;
  planUsage?: {
    totalPercentUsed?: number;
    autoPercentUsed?: number;
    apiPercentUsed?: number;
    totalSpend?: number;
    includedSpend?: number;
    limit?: number;
    remainingBonus?: boolean;
    bonusTooltip?: string;
  };
  displayMessage?: string;
  autoModelSelectedDisplayMessage?: string;
  namedModelSelectedDisplayMessage?: string;
}

function unavailable(reason: string): WindowUsage {
  return {
    usedPercent: null,
    remainingPercent: null,
    status: "unavailable",
    reason,
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Round like the Cursor bill, but 99.6% used is 99, not a full 100. */
function roundPct(n: number): number {
  const r = Math.round(n);
  return n < 100 && r === 100 ? 99 : r;
}

function clampPct(n: number): number {
  return Math.min(100, Math.max(0, n));
}

/** Cursor billingCycle* fields arrive as unix-ms strings or numbers. */
export function parseCursorTimestamp(value: string | number | undefined | null): string | null {
  if (value === undefined || value === null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = n < 1e12 ? n * 1000 : n;
  return new Date(ms).toISOString();
}

export function formatPlanLabel(membership: string | null | undefined): string {
  const raw = (membership ?? "").trim().toLowerCase();
  if (!raw) return "Included in plan";
  const map: Record<string, string> = {
    pro_plus: "Included in Pro+",
    proplus: "Included in Pro+",
    pro: "Included in Pro",
    free: "Included in Free",
    business: "Included in Business",
    team: "Included in Team",
    ultra: "Included in Ultra",
  };
  if (map[raw]) return map[raw];
  const pretty = raw
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
  return `Included in ${pretty}`;
}

export function mapCursorPeriod(period: CursorPeriodUsage | null | undefined): Record<WindowId, WindowUsage> {
  const windows: Record<WindowId, WindowUsage> = {
    five_hour: unavailable("Cursor does not expose a 5-hour rolling usage window."),
    week: unavailable("Cursor does not expose a weekly rolling usage window."),
    month: unavailable("Cursor did not report billing-cycle plan usage."),
  };

  const used = period?.planUsage?.totalPercentUsed;
  if (typeof used !== "number" || !Number.isFinite(used)) {
    return windows;
  }

  const clamped = clampPct(used);
  windows.month = {
    usedPercent: round1(clamped),
    remainingPercent: round1(Math.max(0, 100 - clamped)),
    resetsAtIso: parseCursorTimestamp(period?.billingCycleEnd),
    status: "ok",
  };
  return windows;
}

const LIMIT_HIT_RE = /hit your usage limit/i;

/** limitHit: Cursor says so, or spend reached the limit with no bonus left. */
export function buildCursorBilling(
  period: CursorPeriodUsage | null | undefined,
  membership: string | null | undefined,
): CursorBillingBreakdown & { limitHit: boolean } {
  const plan = period?.planUsage;
  const total =
    typeof plan?.totalPercentUsed === "number" && Number.isFinite(plan.totalPercentUsed)
      ? roundPct(clampPct(plan.totalPercentUsed))
      : null;
  const auto =
    typeof plan?.autoPercentUsed === "number" && Number.isFinite(plan.autoPercentUsed)
      ? roundPct(clampPct(plan.autoPercentUsed))
      : null;
  const api =
    typeof plan?.apiPercentUsed === "number" && Number.isFinite(plan.apiPercentUsed)
      ? roundPct(clampPct(plan.apiPercentUsed))
      : null;

  const includedCents =
    typeof plan?.limit === "number" && Number.isFinite(plan.limit)
      ? plan.limit
      : typeof plan?.includedSpend === "number" && Number.isFinite(plan.includedSpend)
        ? plan.includedSpend
        : null;
  const includedUsd =
    includedCents !== null && includedCents > 0 ? Math.round(includedCents / 100) : null;

  return {
    planLabel: formatPlanLabel(membership),
    totalPercentUsed: total,
    autoPercentUsed: auto,
    apiPercentUsed: api,
    remainingPercent: total !== null ? Math.max(0, 100 - total) : null,
    resetsAtIso: parseCursorTimestamp(period?.billingCycleEnd),
    autoNote: "Additional usage beyond limits consumes API quota or on-demand spend.",
    apiNote:
      includedUsd !== null
        ? `Additional usage beyond limits consumes on-demand spend. Your plan includes at least $${includedUsd} of API usage.`
        : "Additional usage beyond limits consumes on-demand spend.",
    displayMessage: period?.displayMessage,
    limitHit:
      LIMIT_HIT_RE.test(period?.displayMessage ?? "") ||
      (typeof plan?.totalSpend === "number" &&
        typeof plan.limit === "number" &&
        plan.limit > 0 &&
        plan.totalSpend >= plan.limit &&
        plan.remainingBonus === false),
  };
}

export interface CursorPathOptions {
  platform?: NodeJS.Platform;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}

export interface CursorAdapterOptions extends CursorPathOptions {
  sqliteGet?: (dbPath: string, sql: string) => Promise<string>;
  fetchImpl?: typeof fetch;
}

export function resolveCursorStateDbPath(options: CursorPathOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? os.homedir();
  const env = options.env ?? process.env;
  const override = env.CURSOR_STATE_DB?.trim();
  if (override) return override;

  const root =
    platform === "darwin"
      ? path.join(homeDir, "Library", "Application Support")
      : env.APPDATA ?? path.join(homeDir, "AppData", "Roaming");
  return path.join(root, "Cursor", "User", "globalStorage", "state.vscdb");
}

const LOCKED_RE = /SQLITE_BUSY|SQLITE_LOCKED|database is locked/i;

/**
 * Reads state.vscdb in place. It copies the DB (~1 GB) only when Cursor holds a
 * lock, and only once per reader: token and membership share one copy. A copy
 * is slow and looks like credential theft to AV. Call cleanup() in finally.
 */
function createCursorDbReader(): {
  get: (dbPath: string, sql: string) => Promise<string>;
  cleanup: () => void;
} {
  let tmp: string | null = null;
  let copied: Promise<void> | null = null;
  const get = async (dbPath: string, sql: string): Promise<string> => {
    // sqlite3 creates a missing path. Reject before any open.
    if (!existsSync(dbPath)) {
      throw new Error(`Failed to read Cursor state.vscdb: database file does not exist (${dbPath})`);
    }
    try {
      return await sqliteScalar(dbPath, sql);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // No reader, missing file, bad SQL: a copy cannot help.
      if (!LOCKED_RE.test(msg)) throw new Error(`Failed to read Cursor state.vscdb: ${msg}`);
    }
    try {
      if (!copied) {
        tmp = path.join(os.tmpdir(), `tuw-cursor-${randomUUID()}.vscdb`);
        copied = copySqliteSidecars(dbPath, tmp);
      }
      await copied;
      return await sqliteScalar(tmp!, sql);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to read Cursor state.vscdb: ${msg}`);
    }
  };
  const cleanup = (): void => {
    if (tmp) removeSqliteSidecars(tmp);
  };
  return { get, cleanup };
}

async function sqliteGet(dbPath: string, sql: string): Promise<string> {
  const reader = createCursorDbReader();
  try {
    return await reader.get(dbPath, sql);
  } finally {
    reader.cleanup();
  }
}

export async function readCursorAccessToken(options: CursorAdapterOptions = {}): Promise<string> {
  const env = options.env ?? process.env;
  const fromEnv = env.CURSOR_TOKEN?.trim();
  if (fromEnv) return fromEnv;

  const stdout = await (options.sqliteGet ?? sqliteGet)(
    resolveCursorStateDbPath(options),
    "SELECT value FROM ItemTable WHERE key='cursorAuth/accessToken';",
  );
  if (!stdout) {
    throw new Error("No cursorAuth/accessToken in Cursor state.vscdb — sign in to Cursor and retry.");
  }
  return stdout;
}

export async function readCursorMembership(options: CursorAdapterOptions = {}): Promise<string | null> {
  try {
    const value = await (options.sqliteGet ?? sqliteGet)(
      resolveCursorStateDbPath(options),
      "SELECT value FROM ItemTable WHERE key='cursorAuth/stripeMembershipType';",
    );
    return value || null;
  } catch {
    return null;
  }
}

async function fetchCurrentPeriodUsage(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CursorPeriodUsage> {
  const res = await fetchImpl(DASHBOARD_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "Connect-Protocol-Version": "1",
      "User-Agent": "token-usage-dashboard",
    },
    body: "{}",
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`Cursor GetCurrentPeriodUsage HTTP ${res.status}`);
  }
  return (await res.json()) as CursorPeriodUsage;
}

export async function fetchCursorUsage(options: CursorAdapterOptions = {}): Promise<ProviderUsage> {
  const fetchedAt = new Date().toISOString();
  const reader = options.sqliteGet ? null : createCursorDbReader();
  const readOpts = reader ? { ...options, sqliteGet: reader.get } : options;
  try {
    const [token, membership] = await Promise.all([
      readCursorAccessToken(readOpts),
      readCursorMembership(readOpts),
    ]);
    reader?.cleanup();
    const period = await fetchCurrentPeriodUsage(token, options.fetchImpl);
    return {
      provider: "cursor",
      label: "Cursor",
      windows: mapCursorPeriod(period),
      billing: buildCursorBilling(period, membership),
      fetchedAt,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      provider: "cursor",
      label: "Cursor",
      windows: {
        five_hour: unavailable("Cursor usage unavailable."),
        week: unavailable("Cursor usage unavailable."),
        month: unavailable("Cursor usage unavailable."),
      },
      billing: {
        planLabel: "Included in plan",
        totalPercentUsed: null,
        autoPercentUsed: null,
        apiPercentUsed: null,
        remainingPercent: null,
      },
      fetchedAt,
      error: msg,
    };
  } finally {
    reader?.cleanup();
  }
}

export const __test = {
  mapCursorPeriod,
  parseCursorTimestamp,
  buildCursorBilling,
  formatPlanLabel,
  round1,
  createCursorDbReader,
};
