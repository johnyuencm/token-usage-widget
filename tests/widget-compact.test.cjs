const { test } = require("node:test");
const assert = require("node:assert/strict");
const { providerLine, providerTitle, wrapProviderLine, maxCharsForWidth } = require("../public/widget-compact.js");

test("codex compact line uses remaining % (matches Codex Analytics)", () => {
  const line = providerLine({
    provider: "openai",
    windows: {
      five_hour: { status: "unavailable", usedPercent: null, remainingPercent: null },
      week: { status: "ok", usedPercent: 47, remainingPercent: 53 },
      month: { status: "unavailable", usedPercent: null, remainingPercent: null },
    },
  });
  assert.equal(line, "codex: Week 53%");
});

test("cursor compact line matches dense format", () => {
  const line = providerLine({
    provider: "cursor",
    billing: {
      totalPercentUsed: 23,
      autoPercentUsed: 13,
      apiPercentUsed: 99,
    },
  });
  assert.equal(line, "cursor: total 23% first party 13% API 99%");
});

test("opencode compact includes rolling/week/month when ok", () => {
  const line = providerLine({
    provider: "opencode",
    windows: {
      five_hour: { status: "ok", usedPercent: 0 },
      week: { status: "ok", usedPercent: 100 },
      month: { status: "ok", usedPercent: 50 },
    },
  });
  assert.equal(line, "opencode: rolling 0%, week 100%, month 50%");
});

test("opencode missing-auth shows NA when nothing is ok", () => {
  const line = providerLine({
    provider: "opencode",
    error: "Set auth cookie (OPENCODE_GO_AUTH_COOKIE) to load live OpenCode Go meters.",
    windows: {
      five_hour: { status: "unavailable", usedPercent: null },
      week: { status: "unavailable", usedPercent: null },
      month: { status: "unavailable", usedPercent: null },
    },
  });
  assert.equal(line, "opencode: error");
});

test("openrouter compact shows dollar balance remaining", () => {
  const line = providerLine({
    provider: "openrouter",
    balance: { currency: "USD", remaining: 12.34 },
  });
  assert.equal(line, "openrouter: $12.34 left");
});

test("claude compact shows used percent windows", () => {
  const line = providerLine({
    provider: "claude",
    windows: {
      five_hour: { status: "ok", usedPercent: 42 },
      week: { status: "ok", usedPercent: 61 },
      month: { status: "unavailable", usedPercent: null },
    },
  });
  assert.equal(line, "claude: 5h 42%, Week 61%");
});

test("claude compact shows dollar spend when windows are NA", () => {
  const line = providerLine({
    provider: "claude",
    windows: {
      five_hour: { status: "unavailable", usedPercent: null },
      week: { status: "unavailable", usedPercent: null },
      month: { status: "unavailable", usedPercent: null },
    },
    balance: { currency: "USD", used: 3.64, total: 9, remaining: 5.36 },
  });
  assert.equal(line, "claude: $3.64/$9.00 (40%)");
});

test("claude compact shows rate limit hint instead of bare error", () => {
  const line = providerLine({
    provider: "claude",
    error: "Claude usage rate limited (retry in ~42m)",
    windows: {
      five_hour: { status: "unavailable", usedPercent: null },
      week: { status: "unavailable", usedPercent: null },
      month: { status: "unavailable", usedPercent: null },
    },
  });
  assert.equal(line, "claude: rate limited ~42m");
});

test("claude compact week-only display pref", () => {
  const line = providerLine(
    {
      provider: "claude",
      windows: {
        five_hour: { status: "ok", usedPercent: 12 },
        week: { status: "ok", usedPercent: 34 },
      },
    },
    { display: { claude: { fiveHour: false, week: true, spend: false } } },
  );
  assert.equal(line, "claude: Week 34%");
});

test("cursor compact hides API when display pref off", () => {
  const line = providerLine(
    {
      provider: "cursor",
      billing: { totalPercentUsed: 10, autoPercentUsed: 5, apiPercentUsed: 99 },
    },
    { display: { cursor: { total: true, auto: true, api: false } } },
  );
  assert.equal(line, "cursor: total 10% first party 5%");
});

test("codex compact maps token-expired error to not signed in", () => {
  const line = providerLine({
    provider: "openai",
    error: "Codex token expired. Run: `codex login`",
    windows: {
      five_hour: { status: "unavailable", usedPercent: null, remainingPercent: null },
      week: { status: "unavailable", usedPercent: null, remainingPercent: null },
      month: { status: "unavailable", usedPercent: null, remainingPercent: null },
    },
  });
  assert.equal(line, "codex: not signed in");
});

test("codex compact appends short reset per ok window", () => {
  const now = Date.parse("2026-07-20T12:00:00.000Z");
  const weekReset = new Date(now + (3 * 24 * 3600 + 5 * 3600) * 1000).toISOString();
  const line = providerLine(
    {
      provider: "openai",
      windows: {
        five_hour: { status: "unavailable", usedPercent: null, remainingPercent: null },
        week: { status: "ok", usedPercent: 47, remainingPercent: 53, resetsAtIso: weekReset },
        month: { status: "unavailable", usedPercent: null, remainingPercent: null },
      },
    },
    { nowMs: now },
  );
  assert.equal(line, "codex: Week 53% (3d 5h)");
});

test("cursor compact appends cycle reset countdown", () => {
  const now = Date.parse("2026-07-20T12:00:00.000Z");
  const cycleReset = new Date(now + 12 * 24 * 3600 * 1000).toISOString();
  const line = providerLine(
    {
      provider: "cursor",
      billing: {
        totalPercentUsed: 23,
        autoPercentUsed: 13,
        apiPercentUsed: 99,
        resetsAtIso: cycleReset,
      },
    },
    { nowMs: now },
  );
  assert.equal(line, "cursor: total 23% first party 13% API 99% · 12d");
});

test("maxCharsForWidth scales with widget width", () => {
  assert.equal(maxCharsForWidth(320), 44);
  assert.ok(maxCharsForWidth(220) < maxCharsForWidth(320));
  assert.ok(maxCharsForWidth(220) >= 16);
});

test("wrapProviderLine keeps short lines on one row", () => {
  assert.deepEqual(wrapProviderLine("codex: error", 40), ["codex: error"]);
});

test("wrapProviderLine splits long lines at word boundaries", () => {
  const line = "cursor: total 26% first party 19% API 100% · 21d";
  assert.deepEqual(wrapProviderLine(line, 36), [
    "cursor: total 26% first party 19%",
    "API 100% · 21d",
  ]);
});

test("wrapProviderLine prefers comma breaks over orphaning the next word", () => {
  const line = "opencode: rolling 0% (5h), week 100% (15h 53m), month 50% (27d 1h)";
  const rows = wrapProviderLine(line, 32);
  assert.equal(rows[0], "opencode: rolling 0% (5h),");
  assert.match(rows[1], /^week /);
});

test("wrapProviderLine hard-splits a token longer than max chars", () => {
  assert.deepEqual(wrapProviderLine("abcdefghijklmnopqrstuvwxyz", 12), [
    "abcdefghijkl",
    "mnopqrstuvwx",
    "yz",
  ]);
});

test("providerTitle uses human-readable dates, not raw ISO", () => {
  const title = providerTitle({
    billing: { resetsAtIso: "2026-08-04T09:27:11.000Z" },
    windows: {
      week: { resetsAtIso: "2026-07-26T17:16:26.000Z" },
    },
  });
  assert.match(title, /^cycle /);
  assert.match(title, / · week /);
  assert.doesNotMatch(title, /T\d{2}:\d{2}:\d{2}/);
  assert.doesNotMatch(title, /\.000Z/);
});
