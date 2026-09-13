import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFixtureResponse } from "../src/fixtures.js";
import { fetchOpenAIUsage, formatCodexStatusError, __test as openaiTest } from "../src/adapters/openai.js";
import { CodexStatusError } from "codex-status-mcp";
import { __test as opencodeTest } from "../src/adapters/opencode.js";
import { __test as cursorTest } from "../src/adapters/cursor.js";
import type { WindowId, WindowUsage } from "../src/types.js";

const { classifyDuration, mapWindows, windowFromRateLimit, pickRateLimits } = openaiTest;
const { extractTokens, toMs, tokenWindow } = opencodeTest;
const { mapCursorPeriod, parseCursorTimestamp, buildCursorBilling, formatPlanLabel } = cursorTest;

const WINDOW_IDS: WindowId[] = ["five_hour", "week", "month"];

test("classifyDuration maps ~300→five_hour, ~10080→week, ~43200→month", () => {
  assert.equal(classifyDuration(300), "five_hour");
  assert.equal(classifyDuration(305), "five_hour");
  assert.equal(classifyDuration(10080), "week");
  assert.equal(classifyDuration(10000), "week");
  assert.equal(classifyDuration(43200), "month");
  assert.equal(classifyDuration(45000), "month");
});

test("classifyDuration rejects wildly off durations", () => {
  assert.equal(classifyDuration(1), null);
  assert.equal(classifyDuration(99999), null);
  assert.equal(classifyDuration(undefined), null);
});

test("windowFromRateLimit computes remainingPercent = 100 - used", () => {
  const w = windowFromRateLimit({ usedPercent: 34, windowDurationMins: 10080, resetsAtIso: "2026-01-01T00:00:00.000Z" });
  assert.equal(w.status, "ok");
  assert.equal(w.usedPercent, 34);
  assert.equal(w.remainingPercent, 66);
  assert.equal(w.resetsAtIso, "2026-01-01T00:00:00.000Z");
});

test("windowFromRateLimit handles resetsAt unix seconds", () => {
  const w = windowFromRateLimit({ usedPercent: 10, windowDurationMins: 300, resetsAt: 1780000000 });
  assert.equal(w.status, "ok");
  assert.equal(w.remainingPercent, 90);
  assert.equal(w.resetsAtIso, new Date(1780000000 * 1000).toISOString());
});

test("mapWindows marks missing windows unavailable when only weekly reported", () => {
  const limits = {
    primary: { usedPercent: 23, windowDurationMins: 10080, resetsAtIso: "2026-01-01T00:00:00.000Z" },
    secondary: null,
  limitId: "codex",
  limitName: null,
    credits: null,
    planType: "plus",
    rateLimitReachedType: null,
  };
  const windows = mapWindows(limits);
  assert.equal(windows.week.status, "ok");
  assert.equal(windows.week.usedPercent, 23);
  assert.equal(windows.five_hour.status, "unavailable");
  assert.equal(windows.month.status, "unavailable");
  assert.ok(windows.five_hour.reason);
  assert.ok(windows.month.reason);
});

test("mapWindows maps both primary (5h) and secondary (7d) when present", () => {
  const limits = {
    primary: { usedPercent: 45, windowDurationMins: 300 },
    secondary: { usedPercent: 12, windowDurationMins: 10080 },
    limitId: "codex",
    limitName: null,
    credits: null,
    planType: "plus",
    rateLimitReachedType: null,
  };
  const windows = mapWindows(limits);
  assert.equal(windows.five_hour.status, "ok");
  assert.equal(windows.five_hour.usedPercent, 45);
  assert.equal(windows.week.status, "ok");
  assert.equal(windows.week.usedPercent, 12);
  assert.equal(windows.month.status, "unavailable");
});

test("mapWindows returns all-unavailable when limits null", () => {
  const windows = mapWindows(null);
  assert.equal(windows.five_hour.status, "unavailable");
  assert.equal(windows.week.status, "unavailable");
  assert.equal(windows.month.status, "unavailable");
});

test("pickRateLimits prefers codex limitId over spark", () => {
  const result = {
    source: "codex app-server account/rateLimits/read" as const,
    account: null,
    requiresOpenaiAuth: true,
    rateLimits: { limitId: "spark", primary: { usedPercent: 1, windowDurationMins: 300 }, secondary: null },
    rateLimitsByLimitId: {
      spark: { limitId: "spark", primary: { usedPercent: 1, windowDurationMins: 300 }, secondary: null },
      codex: { limitId: "codex", primary: { usedPercent: 50, windowDurationMins: 300 }, secondary: { usedPercent: 5, windowDurationMins: 10080 } },
    },
  };
  const picked = pickRateLimits(result);
  assert.equal(picked?.limitId, "codex");
  assert.equal(picked?.primary?.usedPercent, 50);
});

test("formatCodexStatusError maps expired ChatGPT token JSON-RPC to login hint", () => {
  const err = new CodexStatusError("Codex app-server returned a JSON-RPC error.", {
    accountError: undefined,
    rateLimitsError: {
      code: -32603,
      message:
        'failed to fetch codex rate limits: GET https://chatgpt.com/backend-api/wham/usage failed: 401 Unauthorized; body={"error":{"code":"token_expired"}}',
    },
  });
  assert.equal(formatCodexStatusError(err), "Codex token expired. Run: `codex login`");
});

test("formatCodexStatusError maps refresh_token_reused stderr to login hint", () => {
  const err = new CodexStatusError("Codex app-server returned a JSON-RPC error.", {
    stderr: 'Failed to refresh token: 401 Unauthorized: {"code":"refresh_token_reused"}',
  });
  assert.equal(formatCodexStatusError(err), "Codex token expired. Run: `codex login`");
});

test("formatCodexStatusError keeps spawn/timeout messages", () => {
  const err = new CodexStatusError("Timed out waiting for Codex app-server status data.");
  assert.equal(formatCodexStatusError(err), "Timed out waiting for Codex app-server status data.");
});

test("fetchOpenAIUsage surfaces token-expired JSON-RPC as login hint", async () => {
  const usage = await fetchOpenAIUsage({
    getStatus: async () => {
      throw new CodexStatusError("Codex app-server returned a JSON-RPC error.", {
        rateLimitsError: {
          code: -32603,
          message: "Provided authentication token is expired. Please try signing in again.",
        },
      });
    },
  });
  assert.equal(usage.error, "Codex token expired. Run: `codex login`");
  assert.equal(usage.windows.week.status, "unavailable");
  assert.match(usage.windows.week.reason ?? "", /Codex token expired/);
});

test("pickRateLimits falls back to top-level rateLimits when no codex key", () => {
  const result = {
    source: "codex app-server account/rateLimits/read" as const,
    account: null,
    requiresOpenaiAuth: true,
    rateLimits: { limitId: "codex", primary: { usedPercent: 7, windowDurationMins: 10080 }, secondary: null },
    rateLimitsByLimitId: {},
  };
  const picked = pickRateLimits(result);
  assert.equal(picked?.limitId, "codex");
  assert.equal(picked?.primary?.usedPercent, 7);
});

test("fixture response shape: eight providers, three windows each, fixture flag true", () => {
  const resp = buildFixtureResponse();
  assert.equal(resp.fixture, true);
  assert.equal(resp.providers.length, 8);
  const ids = resp.providers.map((p) => p.provider).sort();
  assert.deepEqual(ids, [
    "claude",
    "cursor",
    "grok",
    "kimi",
    "openai",
    "opencode",
    "openrouter",
    "zai",
  ]);
  for (const p of resp.providers) {
    assert.ok(p.fetchedAt);
    assert.equal(Object.keys(p.windows).length, 3);
    for (const winId of WINDOW_IDS) {
      const w = p.windows[winId];
      assert.ok(["ok", "unavailable", "error"].includes(w.status), `${p.provider}/${winId} status`);
    }
  }
});

test("fixture response respects enabled provider flags", () => {
  const resp = buildFixtureResponse({
    openai: true,
    opencode: false,
    cursor: true,
    claude: false,
    openrouter: false,
    kimi: false,
    zai: false,
    grok: false,
  });
  assert.equal(resp.providers.length, 2);
  assert.deepEqual(
    resp.providers.map((p) => p.provider),
    ["openai", "cursor"],
  );
});

test("fixture OpenAI weekly window is ok with remainingPercent = 100 - used", () => {
  const resp = buildFixtureResponse();
  const openai = resp.providers.find((p) => p.provider === "openai");
  if (!openai) throw new Error("openai provider missing from fixture");
  assert.equal(openai.windows.five_hour.status, "unavailable");
  assert.equal(openai.windows.month.status, "unavailable");
  assert.equal(openai.windows.week.status, "ok");
  const w = openai.windows.week;
  assert.equal(w.remainingPercent, Math.max(0, 100 - w.usedPercent!));
});

test("fixture OpenCode windows report usedTokens and remainingPercent when capped", () => {
  const resp = buildFixtureResponse();
  const oc = resp.providers.find((p) => p.provider === "opencode");
  if (!oc) throw new Error("opencode provider missing from fixture");
  assert.equal(oc.label, "OpenCode Go");
  assert.equal(oc.windows.five_hour.usedPercent, 0);
  assert.equal(oc.windows.week.usedPercent, 100);
  assert.equal(oc.windows.month.usedPercent, 50);
  assert.equal(oc.windows.week.remainingPercent, 0);
  assert.equal(oc.windows.month.remainingPercent, 50);
  assert.ok(oc.windows.five_hour.resetsAtIso);
});

test("parseGoDashboardHtml extracts rolling/weekly/monthly", () => {
  const { parseGoDashboardHtml, mapGoToWindows } = opencodeTest;
  const html =
    "<script>rollingUsage:$R[10]={resetInSec:18000,usagePercent:0}weeklyUsage:$R[11]={resetInSec:57180,usagePercent:100}monthlyUsage:$R[12]={resetInSec:2336400,usagePercent:50}</script>";
  const snap = parseGoDashboardHtml(html);
  assert.ok(snap);
  assert.equal(snap!.rolling?.usagePercent, 0);
  assert.equal(snap!.weekly?.usagePercent, 100);
  assert.equal(snap!.monthly?.usagePercent, 50);
  const windows = mapGoToWindows(snap!);
  assert.equal(windows.five_hour.usedPercent, 0);
  assert.equal(windows.week.usedPercent, 100);
  assert.equal(windows.month.usedPercent, 50);
  assert.equal(windows.week.remainingPercent, 0);
});

test("extractTokens prefers explicit total, else sums nested parts", () => {
  assert.equal(extractTokens('{"tokens":{"total":1234}}')?.total, 1234);
  const summed = extractTokens('{"tokens":{"input":100,"output":20,"reasoning":5,"cache":{"read":10,"write":3}}}');
  assert.equal(summed?.total, 138);
  assert.equal(extractTokens('{"tokens":{"input":1}}')?.total, 1);
  assert.equal(extractTokens('not json'), null);
  assert.equal(extractTokens('{"nope":1}'), null);
});

test("toMs auto-detects seconds vs milliseconds", () => {
  const sec = 1780000000; // seconds, ~2026
  const ms = 1780000000_000; // ms, ~2026
  assert.ok(Math.abs(toMs(sec) - toMs(ms)) < 1);
  assert.equal(toMs(sec), sec * 1000);
  assert.equal(toMs(ms), ms);
});

test("OpenCode tokenWindow: remainingPercent null when no cap, usedTokens still shown", () => {
  const w = tokenWindow(5_000_000, null);
  assert.equal(w.status, "ok");
  assert.equal(w.usedPercent, null);
  assert.equal(w.remainingPercent, null);
  assert.equal(w.usedTokens, 5_000_000);
});

test("OpenCode tokenWindow: clamps to 100 and computes remaining when capped", () => {
  const w = tokenWindow(2_000_000, 1_000_000);
  assert.equal(w.status, "ok");
  assert.equal(w.usedPercent, 100);
  assert.equal(w.remainingPercent, 0);
  assert.equal(w.usedTokens, 2_000_000);
});

test("mapCursorPeriod maps totalPercentUsed to month; 5h/week unavailable", () => {
  const windows = mapCursorPeriod({
    billingCycleEnd: "1785835631000",
    planUsage: { totalPercentUsed: 23.276923076923076 },
  });
  assert.equal(windows.five_hour.status, "unavailable");
  assert.equal(windows.week.status, "unavailable");
  assert.equal(windows.month.status, "ok");
  assert.equal(windows.month.usedPercent, 23.3);
  assert.equal(windows.month.remainingPercent, 76.7);
  assert.equal(windows.month.resetsAtIso, new Date(1785835631000).toISOString());
});

test("mapCursorPeriod marks month unavailable when planUsage missing", () => {
  const windows = mapCursorPeriod({});
  assert.equal(windows.month.status, "unavailable");
  assert.ok(windows.month.reason);
});

test("parseCursorTimestamp accepts ms strings and second numbers", () => {
  assert.equal(parseCursorTimestamp("1785835631000"), new Date(1785835631000).toISOString());
  assert.equal(parseCursorTimestamp(1785835631), new Date(1785835631 * 1000).toISOString());
  assert.equal(parseCursorTimestamp(null), null);
});

test("fixture Cursor month is ok; 5h/week unavailable", () => {
  const resp = buildFixtureResponse();
  const cursor = resp.providers.find((p) => p.provider === "cursor");
  if (!cursor) throw new Error("cursor provider missing from fixture");
  assert.equal(cursor.windows.five_hour.status, "unavailable");
  assert.equal(cursor.windows.week.status, "unavailable");
  assert.equal(cursor.windows.month.status, "ok");
  assert.equal(cursor.windows.month.remainingPercent, Math.max(0, 100 - cursor.windows.month.usedPercent!));
});

test("buildCursorBilling maps Total / First-party / API like Cursor bill UI", () => {
  const billing = buildCursorBilling(
    {
      billingCycleEnd: "1785835631000",
      planUsage: {
        totalPercentUsed: 23.276,
        autoPercentUsed: 12.86875,
        apiPercentUsed: 98.97,
        limit: 7000,
      },
      displayMessage: "You've hit your usage limit",
    },
    "pro_plus",
  );
  assert.equal(billing.planLabel, "Included in Pro+");
  assert.equal(billing.totalPercentUsed, 23);
  assert.equal(billing.autoPercentUsed, 13);
  assert.equal(billing.apiPercentUsed, 99);
  assert.equal(billing.remainingPercent, 77);
  assert.match(billing.apiNote ?? "", /\$70/);
});

test("formatPlanLabel maps membership types", () => {
  assert.equal(formatPlanLabel("pro_plus"), "Included in Pro+");
  assert.equal(formatPlanLabel("pro"), "Included in Pro");
  assert.equal(formatPlanLabel(null), "Included in plan");
});

test("fixture Cursor includes billing breakdown", () => {
  const resp = buildFixtureResponse();
  const cursor = resp.providers.find((p) => p.provider === "cursor");
  if (!cursor?.billing) throw new Error("cursor billing missing from fixture");
  assert.equal(cursor.billing.planLabel, "Included in Pro+");
  assert.equal(cursor.billing.totalPercentUsed, 23);
  assert.equal(cursor.billing.autoPercentUsed, 13);
  assert.equal(cursor.billing.apiPercentUsed, 99);
});
