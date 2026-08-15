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
