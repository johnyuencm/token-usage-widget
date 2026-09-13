const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  loadBounds,
  saveBounds,
  cornerPlacement,
  resizeBottomRight,
  clampBoundsToWorkArea,
  restorePlacement,
  MIN_WIDTH,
  DEFAULT_WIDTH,
  DEFAULT_HEIGHT,
} = require("../desktop/widget-bounds.cjs");

test("loadBounds returns null when missing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "widget-bounds-"));
  assert.equal(loadBounds(dir), null);
});

test("saveBounds round-trips and clamps", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "widget-bounds-"));
  const saved = saveBounds(dir, { width: 400, height: 120 });
  assert.deepEqual(saved, { width: 400, height: 120 });
  assert.deepEqual(loadBounds(dir), { width: 400, height: 120 });
  const clamped = saveBounds(dir, { width: 10, height: 9000 });
  assert.equal(clamped.width, MIN_WIDTH);
  assert.ok(clamped.height <= 640);
});

test("cornerPlacement pins bottom-right", () => {
  const p = cornerPlacement(
    { width: DEFAULT_WIDTH, height: 96 },
    { x: 0, y: 0, width: 1920, height: 1080 },
    16,
  );
  assert.equal(p.x, 1920 - DEFAULT_WIDTH - 16);
  assert.equal(p.y, 1080 - 96 - 16);
});

test("resizeBottomRight keeps bottom-right anchor", () => {
  const next = resizeBottomRight({ x: 100, y: 200, width: 320, height: 172 }, 280, 96);
  assert.equal(next.width, 280);
  assert.equal(next.height, 96);
  assert.equal(next.x, 100 + 320 - 280);
  assert.equal(next.y, 200 + 172 - 96);
});

test("saveBounds round-trips x/y with size", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "widget-bounds-"));
  const saved = saveBounds(dir, { x: 40, y: 24, width: 240, height: 140 });
  assert.deepEqual(saved, { x: 40, y: 24, width: 240, height: 140 });
  assert.deepEqual(loadBounds(dir), { x: 40, y: 24, width: 240, height: 140 });
});

test("restorePlacement uses saved top-left instead of default corner", () => {
  const workArea = { x: 0, y: 0, width: 1920, height: 1080 };
  const restored = restorePlacement(
    { x: 40, y: 24, width: 240, height: 140 },
    workArea,
    16,
    { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT },
  );
  assert.deepEqual(restored, { x: 40, y: 24, width: 240, height: 140 });
});

test("restorePlacement falls back to bottom-right when position is missing", () => {
  const workArea = { x: 0, y: 0, width: 1920, height: 1080 };
  const restored = restorePlacement(
    { width: 240, height: 140 },
    workArea,
    16,
    { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT },
  );
  assert.deepEqual(restored, cornerPlacement({ width: 240, height: 140 }, workArea, 16));
});

test("clampBoundsToWorkArea pulls off-screen windows back into view", () => {
  const clamped = clampBoundsToWorkArea(
    { x: 5000, y: -40, width: 240, height: 140 },
    { x: 0, y: 0, width: 1920, height: 1080 },
  );
  assert.equal(clamped.x, 1920 - 240);
  assert.equal(clamped.y, 0);
  assert.equal(clamped.width, 240);
  assert.equal(clamped.height, 140);
});
