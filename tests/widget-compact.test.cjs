const { test } = require("node:test");
const assert = require("node:assert/strict");
const { providerLine, providerTitle } = require("../public/widget-compact.js");

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
