const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { formatReset, formatResetShort, formatResetWhen } = require("../public/fmt.js");

test("formatReset returns empty for null/invalid", () => {
  assert.equal(formatReset(null), "");
  assert.equal(formatReset(undefined), "");
  assert.equal(formatReset(""), "");
  assert.equal(formatReset("not-a-date"), "");
});

test("formatReset past timestamp says Resets now", () => {
  const past = new Date(1_700_000_000_000).toISOString();
  assert.equal(formatReset(past, 1_800_000_000_000), "Resets now");
});

test("formatReset includes relative countdown and absolute local time", () => {
  const now = Date.parse("2026-07-19T12:00:00.000Z");
  const iso = new Date(now + (2 * 3600 + 15 * 60) * 1000).toISOString();
  const out = formatReset(iso, now);
  assert.match(out, /^Resets in 2 hours 15 minutes · /);
  // Absolute portion is locale-dependent; just require a non-empty suffix after the dot.
  const abs = out.split(" · ")[1];
  assert.ok(abs && abs.length >= 4);
});

test("formatReset days path omits minutes", () => {
  const now = Date.parse("2026-07-19T12:00:00.000Z");
  const iso = new Date(now + (2 * 24 * 3600 + 3 * 3600) * 1000).toISOString();
  const out = formatReset(iso, now);
  assert.match(out, /^Resets in 2 days 3 hours · /);
  assert.doesNotMatch(out, /minute/);
});

test("formatResetShort returns compact countdown", () => {
  const now = Date.parse("2026-07-19T12:00:00.000Z");
  assert.equal(formatResetShort(null), "");
  assert.equal(formatResetShort(new Date(now - 1000).toISOString(), now), "now");
  assert.equal(
    formatResetShort(new Date(now + (2 * 24 * 3600 + 3 * 3600) * 1000).toISOString(), now),
    "2d 3h",
  );
  assert.equal(
    formatResetShort(new Date(now + (2 * 3600 + 15 * 60) * 1000).toISOString(), now),
    "2h 15m",
  );
  assert.equal(formatResetShort(new Date(now + 45 * 60 * 1000).toISOString(), now), "45m");
});

test("formatResetWhen returns locale absolute time, not ISO", () => {
  assert.equal(formatResetWhen(null), "");
  assert.equal(formatResetWhen("not-a-date"), "");
  const iso = "2026-08-04T09:27:11.000Z";
  const out = formatResetWhen(iso);
  assert.ok(out.length >= 4);
  assert.doesNotMatch(out, /T\d{2}:\d{2}:\d{2}/);
  assert.doesNotMatch(out, /Z$/);
});

test("formatReset says <1 minute and omits zero parts", () => {
  const now = Date.parse("2026-07-19T12:00:00.000Z");
  const at = (ms) => formatReset(new Date(now + ms).toISOString(), now).split(" · ")[0];
  assert.equal(at(20_000), "Resets in <1 minute");
  assert.equal(at(59_999), "Resets in <1 minute");
  assert.equal(at(90_000), "Resets in 2 minutes");
  assert.equal(at(59.6 * 60_000), "Resets in 1 hour");
  assert.equal(at(3600_000), "Resets in 1 hour");
  assert.equal(at(24 * 3600_000), "Resets in 1 day");
  assert.equal(at(24 * 3600_000 + 30 * 60_000), "Resets in 1 day");
  assert.equal(at(3600_000 + 60_000), "Resets in 1 hour 1 minute");
});
