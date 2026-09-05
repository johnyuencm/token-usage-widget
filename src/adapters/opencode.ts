import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { sqliteScalar as sqliteScalarQuery } from "../sqlite-scalar.js";
import { copyFile, readdir, readFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import type { Config } from "../config.js";
import type { ProviderUsage, WindowId, WindowUsage } from "../types.js";

const execFileAsync = promisify(execFile);

const DASHBOARD_PREFIX = "https://opencode.ai/workspace/";
const USAGE_API_URL = "https://opencode.ai/zen/go/v1/usage";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:148.0) Gecko/20100101 Firefox/148.0";

const NUM = String.raw`(-?\d+(?:\.\d+)?)`;

const RE_ROLLING_PCT_FIRST = new RegExp(
  String.raw`rollingUsage:\$R\[\d+\]=\{[^}]*usagePercent:${NUM}[^}]*resetInSec:${NUM}[^}]*\}`,
);
const RE_ROLLING_RESET_FIRST = new RegExp(
  String.raw`rollingUsage:\$R\[\d+\]=\{[^}]*resetInSec:${NUM}[^}]*usagePercent:${NUM}[^}]*\}`,
);
const RE_WEEKLY_PCT_FIRST = new RegExp(
  String.raw`weeklyUsage:\$R\[\d+\]=\{[^}]*usagePercent:${NUM}[^}]*resetInSec:${NUM}[^}]*\}`,
);
const RE_WEEKLY_RESET_FIRST = new RegExp(
  String.raw`weeklyUsage:\$R\[\d+\]=\{[^}]*resetInSec:${NUM}[^}]*usagePercent:${NUM}[^}]*\}`,
);
const RE_MONTHLY_PCT_FIRST = new RegExp(
  String.raw`monthlyUsage:\$R\[\d+\]=\{[^}]*usagePercent:${NUM}[^}]*resetInSec:${NUM}[^}]*\}`,
);
const RE_MONTHLY_RESET_FIRST = new RegExp(
  String.raw`monthlyUsage:\$R\[\d+\]=\{[^}]*resetInSec:${NUM}[^}]*usagePercent:${NUM}[^}]*\}`,
);

export interface GoWindowScraped {
  usagePercent: number;
  resetInSec: number;
}

export interface GoUsageSnapshot {
  rolling?: GoWindowScraped;
  weekly?: GoWindowScraped;
  monthly?: GoWindowScraped;
  source: "api" | "dashboard";
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

function windowFromGo(w: GoWindowScraped | undefined, missingReason: string): WindowUsage {
  if (!w) return unavailable(missingReason);
  const used = Math.min(100, Math.max(0, w.usagePercent));
  return {
    usedPercent: round1(used),
    remainingPercent: round1(Math.max(0, 100 - used)),
    resetsAtIso: new Date(Date.now() + Math.max(0, w.resetInSec) * 1000).toISOString(),
    status: "ok",
  };
}

function parseWindowUsage(
  html: string,
  rePctFirst: RegExp,
  reResetFirst: RegExp,
): GoWindowScraped | null {
  const a = rePctFirst.exec(html);
  if (a) {
    const usagePercent = Number(a[1]);
    const resetInSec = Number(a[2]);
    if (Number.isFinite(usagePercent) && Number.isFinite(resetInSec)) {
      return { usagePercent, resetInSec };
    }
  }
  const b = reResetFirst.exec(html);
  if (b) {
    const resetInSec = Number(b[1]);
    const usagePercent = Number(b[2]);
    if (Number.isFinite(usagePercent) && Number.isFinite(resetInSec)) {
      return { usagePercent, resetInSec };
    }
  }
  return null;
}

function parseHumanReadableTime(timeStr: string): number | null {
  const normalized = timeStr.toLowerCase().trim().replace(/\s+/g, " ");
  if (["reset-now", "reset now", "now", "resets now"].includes(normalized)) return 0;
  let totalSeconds = 0;
  const dayMatch = normalized.match(/(\d+(?:\.\d+)?)\s*days?/);
  const hourMatch = normalized.match(/(\d+(?:\.\d+)?)\s*hours?/);
  const minuteMatch = normalized.match(/(\d+(?:\.\d+)?)\s*minutes?/);
  const secondMatch = normalized.match(/(\d+(?:\.\d+)?)\s*seconds?/);
  // Traditional Chinese dashboard: 小時 / 分鐘 / 天
  const dayZh = normalized.match(/(\d+(?:\.\d+)?)\s*天/);
  const hourZh = normalized.match(/(\d+(?:\.\d+)?)\s*小時/);
  const minuteZh = normalized.match(/(\d+(?:\.\d+)?)\s*分鐘/);
  const has =
    dayMatch || hourMatch || minuteMatch || secondMatch || dayZh || hourZh || minuteZh;
  if (!has) return null;
  if (dayMatch) totalSeconds += Number(dayMatch[1]) * 86400;
  if (hourMatch) totalSeconds += Number(hourMatch[1]) * 3600;
  if (minuteMatch) totalSeconds += Number(minuteMatch[1]) * 60;
  if (secondMatch) totalSeconds += Number(secondMatch[1]);
  if (dayZh) totalSeconds += Number(dayZh[1]) * 86400;
  if (hourZh) totalSeconds += Number(hourZh[1]) * 3600;
  if (minuteZh) totalSeconds += Number(minuteZh[1]) * 60;
  return totalSeconds;
}

export function parseDataSlotFormat(html: string): Partial<Record<"rolling" | "weekly" | "monthly", GoWindowScraped>> {
  const result: Partial<Record<"rolling" | "weekly" | "monthly", GoWindowScraped>> = {};
  const items = html.split(/data-slot="usage-item"/);
  for (let i = 1; i < items.length; i++) {
    const content = items[i];
    const labelMatch = content.match(/data-slot="usage-label">([^<]+)</);
    if (!labelMatch) continue;
    const label = labelMatch[1].trim().toLowerCase();
    const usageMatch = content.match(/data-slot="usage-value">[^0-9]*(\d+(?:\.\d+)?)/);
    if (!usageMatch) continue;
    const usagePercent = Number(usageMatch[1]);
    const resetMatch = content.match(/data-slot="(reset-time|reset-now)">([\s\S]*?)<\/span>/);
    if (!resetMatch) continue;
    const resetContent = resetMatch[2]
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/Resets?\s*in\s*/i, "")
      .replace(/重置時間\s*/i, "")
      .trim();
    const resetInSec = resetMatch[1] === "reset-now" ? 0 : parseHumanReadableTime(resetContent);
    if (!Number.isFinite(usagePercent) || resetInSec === null) continue;
    let key: "rolling" | "weekly" | "monthly" | null = null;
    if (label.includes("rolling") || label.includes("滾動")) key = "rolling";
    else if (label.includes("weekly") || label.includes("每週") || label.includes("每周")) key = "weekly";
    else if (label.includes("monthly") || label.includes("每月")) key = "monthly";
    if (key) result[key] = { usagePercent, resetInSec };
  }
  return result;
}

export function parseGoDashboardHtml(html: string): GoUsageSnapshot | null {
  let rolling = parseWindowUsage(html, RE_ROLLING_PCT_FIRST, RE_ROLLING_RESET_FIRST);
  let weekly = parseWindowUsage(html, RE_WEEKLY_PCT_FIRST, RE_WEEKLY_RESET_FIRST);
  let monthly = parseWindowUsage(html, RE_MONTHLY_PCT_FIRST, RE_MONTHLY_RESET_FIRST);
  if (!rolling && !weekly && !monthly) {
    const slots = parseDataSlotFormat(html);
    rolling = slots.rolling ?? null;
    weekly = slots.weekly ?? null;
    monthly = slots.monthly ?? null;
  }
  if (!rolling && !weekly && !monthly) return null;
  return {
    source: "dashboard",
    ...(rolling ? { rolling } : {}),
    ...(weekly ? { weekly } : {}),
    ...(monthly ? { monthly } : {}),
  };
}

function mapGoToWindows(snap: GoUsageSnapshot): Record<WindowId, WindowUsage> {
  return {
    five_hour: windowFromGo(snap.rolling, "OpenCode Go did not report rolling (5h) usage."),
    week: windowFromGo(snap.weekly, "OpenCode Go did not report weekly usage."),
    month: windowFromGo(snap.monthly, "OpenCode Go did not report monthly usage."),
  };
}

function readJsonFile(filePath: string): Record<string, unknown> | null {
  try {
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export interface OpenCodePathOptions {
  platform?: NodeJS.Platform;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}

export interface FirefoxFileSystem {
  exists(filePath: string): boolean;
  list(directoryPath: string): Promise<string[]>;
  copy(sourcePath: string, destinationPath: string): Promise<void>;
  remove(filePath: string): Promise<void>;
}

export interface OpenCodeAdapterOptions extends OpenCodePathOptions {
  profilesRoot?: string;
  tempDir?: string;
  firefoxFs?: FirefoxFileSystem;
  sqliteGet?: (dbPath: string, sql: string) => Promise<string>;
  fetchImpl?: typeof fetch;
  onCleanupError?: (error: Error) => void;
}

const defaultFirefoxFs: FirefoxFileSystem = {
  exists: existsSync,
  list: (directoryPath) => readdir(directoryPath),
  copy: (sourcePath, destinationPath) => copyFile(sourcePath, destinationPath),
  remove: (filePath) => unlink(filePath),
};

export function resolveFirefoxProfilesRoot(options: OpenCodePathOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? os.homedir();
  return platform === "darwin"
    ? path.join(homeDir, "Library", "Application Support", "Firefox", "Profiles")
    : path.join(homeDir, "AppData", "Roaming", "Mozilla", "Firefox", "Profiles");
}

export async function resolveWorkspaceId(
  cfg: Config,
  options: OpenCodePathOptions = {},
): Promise<string | null> {
  if (cfg.opencode.go.workspaceId) return cfg.opencode.go.workspaceId;
  const envVars = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const env = envVars.OPENCODE_GO_WORKSPACE_ID?.trim();
  if (env) return env;

  const pluginCfg = readJsonFile(
    path.join(homeDir, ".config", "opencode", "opencode-go-usage.json"),
  );
  if (typeof pluginCfg?.workspaceId === "string" && pluginCfg.workspaceId.trim()) {
    return pluginCfg.workspaceId.trim();
  }

  const logPath = path.join(homeDir, ".local", "share", "opencode", "log", "opencode.log");
  try {
    const text = await readFile(logPath, "utf8");
    const match = text.match(/wrk_[A-Z0-9]+/);
    if (match) return match[0];
  } catch {
    // ignore
  }
  return null;
}

async function sqliteScalar(dbPath: string, sql: string): Promise<string> {
  return sqliteScalarQuery(dbPath, sql);
}

function defaultCleanupErrorReporter(error: Error): void {
  console.warn(error.message);
}

function reportCleanupError(reporter: (error: Error) => void, error: Error): void {
  try {
    reporter(error);
  } catch {
    defaultCleanupErrorReporter(error);
  }
}

async function cleanupTempFile(
  fs: FirefoxFileSystem,
  filePath: string,
  reporter: (error: Error) => void,
): Promise<void> {
  try {
    if (!fs.exists(filePath)) return;
    await fs.remove(filePath);
    if (fs.exists(filePath)) {
      throw new Error("Temporary file remained after removal.");
    }
  } catch (cause) {
    reportCleanupError(
      reporter,
      new Error("Firefox credential temporary file cleanup failed.", { cause }),
    );
  }
}

export async function readFirefoxAuthCookie(
  options: OpenCodeAdapterOptions = {},
): Promise<string | null> {
  const profilesRoot = options.profilesRoot ?? resolveFirefoxProfilesRoot(options);
  const fs = options.firefoxFs ?? defaultFirefoxFs;
  const cleanupErrorReporter = options.onCleanupError ?? defaultCleanupErrorReporter;
  if (!fs.exists(profilesRoot)) return null;

  let dirs: string[];
  try {
    dirs = await fs.list(profilesRoot);
  } catch {
    return null;
  }

  for (const dir of dirs) {
    const dbPath = path.join(profilesRoot, dir, "cookies.sqlite");
    if (!fs.exists(dbPath)) continue;
    const tmp = path.join(options.tempDir ?? os.tmpdir(), `ff-oc-${randomUUID()}.sqlite`);
    try {
      await fs.copy(dbPath, tmp);
      if (fs.exists(`${dbPath}-wal`)) {
        try {
          await fs.copy(`${dbPath}-wal`, `${tmp}-wal`);
        } catch {
          // WAL is optional; the copied main database may still contain the auth cookie.
        }
      }
      const value = await (options.sqliteGet ?? sqliteScalar)(
        tmp,
        "SELECT value FROM moz_cookies WHERE host LIKE '%opencode.ai%' AND name='auth' ORDER BY expiry DESC LIMIT 1;",
      );
      if (value.trim()) return value.trim();
    } catch {
      // try next profile
    } finally {
      await cleanupTempFile(fs, tmp, cleanupErrorReporter);
      await cleanupTempFile(fs, `${tmp}-wal`, cleanupErrorReporter);
      await cleanupTempFile(fs, `${tmp}-shm`, cleanupErrorReporter);
    }
  }
  return null;
}

export async function resolveAuthCookie(
  cfg: Config,
  options: OpenCodeAdapterOptions = {},
): Promise<string | null> {
  if (cfg.opencode.go.authCookie) return cfg.opencode.go.authCookie;
  const envVars = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const env = envVars.OPENCODE_GO_AUTH_COOKIE?.trim();
  if (env) return env;
  const pluginCfg = readJsonFile(
    path.join(homeDir, ".config", "opencode", "opencode-go-usage.json"),
  );
  if (typeof pluginCfg?.authCookie === "string" && pluginCfg.authCookie.trim()) {
    return pluginCfg.authCookie.trim();
  }
  const fileEnv = envVars.OPENCODE_GO_AUTH_COOKIE_FILE?.trim();
  if (fileEnv && existsSync(fileEnv)) {
    try {
      const v = (await readFile(fileEnv, "utf8")).trim();
      if (v) return v;
    } catch {
      // ignore
    }
  }
  return readFirefoxAuthCookie(options);
}

function readApiKey(options: OpenCodePathOptions = {}): string | null {
  const homeDir = options.homeDir ?? os.homedir();
  const env = options.env ?? process.env;
  const auth = readJsonFile(path.join(homeDir, ".local", "share", "opencode", "auth.json"));
  const go = auth?.["opencode-go"] as Record<string, unknown> | undefined;
  if (go && typeof go.key === "string" && go.key.trim()) return go.key.trim();
  return env.OPENCODE_GO_API_KEY?.trim() || null;
}

function normalizeApiWindow(raw: unknown): GoWindowScraped | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const usagePercent = Number(o.usagePercent ?? o.usage_percent);
  const resetInSec = Number(o.resetInSec ?? o.reset_in_sec ?? o.resetInSeconds);
  if (!Number.isFinite(usagePercent) || !Number.isFinite(resetInSec)) return undefined;
  return { usagePercent, resetInSec };
}

export async function fetchGoUsageApi(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GoUsageSnapshot | null> {
  const res = await fetchImpl(USAGE_API_URL, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
  });
  if (!res.ok) return null;
  const json = (await res.json()) as Record<string, unknown>;
  const rolling = normalizeApiWindow(json.rollingUsage ?? json.rolling ?? json.rolling5h);
  const weekly = normalizeApiWindow(json.weeklyUsage ?? json.weekly);
  const monthly = normalizeApiWindow(json.monthlyUsage ?? json.monthly);
  if (!rolling && !weekly && !monthly) return null;
  return {
    source: "api",
    ...(rolling ? { rolling } : {}),
    ...(weekly ? { weekly } : {}),
    ...(monthly ? { monthly } : {}),
  };
}

export async function scrapeGoDashboard(
  workspaceId: string,
  authCookie: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GoUsageSnapshot | null> {
  const url = `${DASHBOARD_PREFIX}${encodeURIComponent(workspaceId)}/go`;
  const res = await fetchImpl(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html",
      Cookie: `auth=${authCookie}`,
    },
    redirect: "manual",
  });
  if (res.status >= 300 && res.status < 400) {
    throw new Error("OpenCode Go session expired — refresh the auth cookie from opencode.ai.");
  }
  if (!res.ok) {
    throw new Error(`OpenCode Go dashboard HTTP ${res.status}`);
  }
  const html = await res.text();
  if (/sign[\s-]?in|login/i.test(html) && !/rollingUsage|usage-item|每月使用量|滾動使用量/.test(html)) {
    throw new Error("OpenCode Go session expired — refresh the auth cookie from opencode.ai.");
  }
  return parseGoDashboardHtml(html);
}

// --- local DB estimate (fallback only) ---

const WINDOW_MS: Record<WindowId, number> = {
  five_hour: 5 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
};

interface MessageRow {
  time_created: number;
  data: string;
}

function toMs(ts: number): number {
  if (ts > 1e11) return ts;
  return ts * 1000;
}

function extractTokens(data: string): { total: number } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const tokens = (parsed as Record<string, unknown>).tokens as Record<string, unknown> | undefined;
  if (!tokens || typeof tokens !== "object") return null;
  if (typeof tokens.total === "number" && Number.isFinite(tokens.total)) {
    return { total: tokens.total };
  }
  const readNum = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const cache = (tokens.cache as Record<string, unknown> | undefined) ?? {};
  return {
    total:
      readNum(tokens.input) +
      readNum(tokens.output) +
      readNum(tokens.reasoning) +
      readNum(cache.read) +
      readNum(cache.write),
  };
}

function tokenWindow(usedTokens: number, cap: number | null): WindowUsage {
  if (cap && cap > 0) {
    const usedPercent = Math.min(100, (usedTokens / cap) * 100);
    return {
      usedPercent,
      remainingPercent: Math.max(0, 100 - usedPercent),
      usedTokens,
      status: "ok",
      reason: "Local DB estimate — not OpenCode Go plan meters.",
    };
  }
  return {
    usedPercent: null,
    remainingPercent: null,
    usedTokens,
    status: "ok",
    reason: "Local DB estimate — not OpenCode Go plan meters.",
  };
}

async function fetchLocalEstimate(cfg: Config): Promise<ProviderUsage> {
  const dbPath = cfg.opencode.dbPath;
  if (!existsSync(dbPath)) {
    const msg = `OpenCode database not found at ${dbPath}`;
    return {
      provider: "opencode",
      label: "OpenCode Go",
      windows: {
        five_hour: unavailable(msg),
        week: unavailable(msg),
        month: unavailable(msg),
      },
      fetchedAt: new Date().toISOString(),
      error: msg,
    };
  }
  let rows: MessageRow[] = [];
  try {
    const { stdout } = await execFileAsync(
      "sqlite3",
      [dbPath, "SELECT time_created, data FROM message;", "-json"],
      { maxBuffer: 64 * 1024 * 1024, windowsHide: true },
    );
    const trimmed = stdout.trim();
    if (trimmed) rows = JSON.parse(trimmed) as MessageRow[];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      provider: "opencode",
      label: "OpenCode Go",
      windows: {
        five_hour: unavailable(msg),
        week: unavailable(msg),
        month: unavailable(msg),
      },
      fetchedAt: new Date().toISOString(),
      error: msg,
    };
  }

  const now = Date.now();
  const sums: Record<WindowId, number> = { five_hour: 0, week: 0, month: 0 };
  for (const row of rows) {
    const ts = typeof row.time_created === "number" ? toMs(row.time_created) : null;
    if (ts === null) continue;
    const parsed = extractTokens(row.data);
    if (!parsed || parsed.total <= 0) continue;
    for (const key of Object.keys(WINDOW_MS) as WindowId[]) {
      if (ts >= now - WINDOW_MS[key]) sums[key] += parsed.total;
    }
  }
  const windows: Record<WindowId, WindowUsage> = {
    five_hour: tokenWindow(sums.five_hour, cfg.opencode.caps.five_hour),
    week: tokenWindow(sums.week, cfg.opencode.caps.week),
    month: tokenWindow(sums.month, cfg.opencode.caps.month),
  };
  return {
    provider: "opencode",
    label: "OpenCode Go",
    windows,
    fetchedAt: new Date().toISOString(),
    error:
      "Using local DB estimate. Set OPENCODE_GO_AUTH_COOKIE (and workspace) to match the Go plan dashboard.",
  };
}

export async function fetchOpenCodeUsage(
  cfg: Config,
  options: OpenCodeAdapterOptions = {},
): Promise<ProviderUsage> {
  const fetchedAt = new Date().toISOString();
  const env = options.env ?? process.env;
  const apiKey = readApiKey(options);
  if (apiKey) {
    try {
      const apiSnap = await fetchGoUsageApi(apiKey, options.fetchImpl);
      if (apiSnap) {
        return {
          provider: "opencode",
          label: "OpenCode Go",
          windows: mapGoToWindows(apiSnap),
          fetchedAt,
        };
      }
    } catch {
      // fall through to dashboard scrape
    }
  }

  const workspaceId = await resolveWorkspaceId(cfg, options);
  const authCookie = await resolveAuthCookie(cfg, options);

  if (workspaceId && authCookie) {
    try {
      const snap = await scrapeGoDashboard(workspaceId, authCookie, options.fetchImpl);
      if (snap) {
        return {
          provider: "opencode",
          label: "OpenCode Go",
          windows: mapGoToWindows(snap),
          fetchedAt,
        };
      }
      return {
        provider: "opencode",
        label: "OpenCode Go",
        windows: {
          five_hour: unavailable("Could not parse Go rolling/weekly/monthly usage from dashboard HTML."),
          week: unavailable("Could not parse Go rolling/weekly/monthly usage from dashboard HTML."),
          month: unavailable("Could not parse Go rolling/weekly/monthly usage from dashboard HTML."),
        },
        fetchedAt,
        error: "Dashboard returned HTML but usage meters were not found.",
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        provider: "opencode",
        label: "OpenCode Go",
        windows: {
          five_hour: unavailable(msg),
          week: unavailable(msg),
          month: unavailable(msg),
        },
        fetchedAt,
        error: msg,
      };
    }
  }

  // No session cookie — do not invent Go plan % from local DB (that misaligns the dashboard).
  // API key from `opencode auth` / auth.json is already tried above; OpenCode has not shipped
  // GET /zen/go/v1/usage yet (community PR still open). Terminal login ≠ plan-meter access.
  const missing = [
    !workspaceId ? "workspace id" : null,
    !authCookie ? "browser auth cookie" : null,
  ]
    .filter(Boolean)
    .join(" and ");

  if (env.OPENCODE_ALLOW_LOCAL_ESTIMATE === "1") {
    const estimate = await fetchLocalEstimate(cfg);
    estimate.error = `Missing ${missing} for live Go plan meters. ${estimate.error ?? ""}`.trim();
    return estimate;
  }

  const hasApiKey = Boolean(readApiKey(options));
  const reason = hasApiKey
    ? "OpenCode API key is present, but Go plan meters (rolling/weekly/monthly) are not exposed via API yet — only the website. Until OpenCode ships that endpoint, set a browser `auth` cookie (or keep Firefox logged into opencode.ai so we can read it)."
    : `Set ${missing} to load live OpenCode Go rolling/weekly/monthly meters from opencode.ai (API key login alone cannot read Go plan quotas today).`;
  return {
    provider: "opencode",
    label: "OpenCode Go",
    windows: {
      five_hour: unavailable(reason),
      week: unavailable(reason),
      month: unavailable(reason),
    },
    fetchedAt,
    error: reason,
  };
}

export const __test = {
  toMs,
  extractTokens,
  tokenWindow,
  WINDOW_MS,
  parseGoDashboardHtml,
  parseDataSlotFormat,
  parseHumanReadableTime,
  windowFromGo,
  mapGoToWindows,
};
