import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyUiPatch,
  DEFAULT_UI,
  mergeUiSettings,
  parseUiPatch,
  resolvePollIntervalSec,
} from "../src/ui-settings.js";

test("mergeUiSettings applies defaults and clamps intervals", () => {
  const ui = mergeUiSettings({
    refreshIntervalSec: 10,
    pollIntervalSec: { claude: 99999 },
    display: { claude: { fiveHour: false } },
  });
  assert.equal(ui.refreshIntervalSec, 30);
  assert.equal(ui.pollIntervalSec.claude, 3600);
  assert.equal(ui.display.claude.fiveHour, false);
  assert.equal(ui.display.claude.week, true);
});

test("resolvePollIntervalSec prefers provider override", () => {
  const ui = mergeUiSettings({ refreshIntervalSec: 120, pollIntervalSec: { claude: 300 } });
  assert.equal(resolvePollIntervalSec("claude", ui), 300);
  assert.equal(resolvePollIntervalSec("cursor", ui), 120);
});

test("applyUiPatch merges display sections", () => {
  const next = applyUiPatch(DEFAULT_UI, parseUiPatch({
    display: { cursor: { api: false } },
  }));
  assert.equal(next.display.cursor.api, false);
  assert.equal(next.display.cursor.total, true);
});

test("a patch interval that is not a positive number keeps the current value (B3)", () => {
  const current = mergeUiSettings({ refreshIntervalSec: 120, pollIntervalSec: { claude: 3600 } });
  const next = applyUiPatch(current, parseUiPatch({ refreshIntervalSec: 0, pollIntervalSec: { claude: 0 } }));
  assert.equal(next.refreshIntervalSec, 120);
  assert.equal(next.pollIntervalSec.claude, 3600);
  // null means "not set" in a patch and in the file alike.
  assert.equal(applyUiPatch(current, parseUiPatch({ refreshIntervalSec: null })).refreshIntervalSec, 120);
  assert.equal(mergeUiSettings({ refreshIntervalSec: null }).refreshIntervalSec, DEFAULT_UI.refreshIntervalSec);
});

test("a partial display patch keeps the sibling flags (B7)", () => {
  const current = mergeUiSettings({ display: { claude: { week: false }, cursor: { auto: false } } });
  const next = applyUiPatch(current, parseUiPatch({ display: { claude: { fiveHour: false } } }));
  assert.equal(next.display.claude.fiveHour, false);
  assert.equal(next.display.claude.week, false);
  assert.equal(next.display.cursor.auto, false);
});
