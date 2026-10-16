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
  nearestDockEdge,
  dockBlockers,
  dockedBounds,
  lerpBounds,
  boundsContainPoint,
  hoverTargetBounds,
  MIN_WIDTH,
  MIN_HEIGHT,
  DEFAULT_WIDTH,
  DEFAULT_HEIGHT,
  DOCK_PEEK_PX,
} = require("../desktop/widget-bounds.cjs");

test("loadBounds returns null when missing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "widget-bounds-"));
  assert.equal(loadBounds(dir), null);
});

test("saveBounds round-trips and clamps", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "widget-bounds-"));
  const saved = saveBounds(dir, { width: 400, height: 180 });
  assert.deepEqual(saved, { width: 400, height: 180 });
  assert.deepEqual(loadBounds(dir), { width: 400, height: 180 });
  const clamped = saveBounds(dir, { width: 10, height: 9000 });
  assert.equal(clamped.width, MIN_WIDTH);
  assert.ok(clamped.height <= 640);
  const tooSmall = saveBounds(dir, { width: 400, height: 10 });
  assert.equal(tooSmall.height, MIN_HEIGHT);
});

test("cornerPlacement pins bottom-right", () => {
  const p = cornerPlacement(
    { width: DEFAULT_WIDTH, height: 172 },
    { x: 0, y: 0, width: 1920, height: 1080 },
    16,
  );
  assert.equal(p.x, 1920 - DEFAULT_WIDTH - 16);
  assert.equal(p.y, 1080 - 172 - 16);
});

test("resizeBottomRight keeps bottom-right anchor", () => {
  const next = resizeBottomRight({ x: 100, y: 200, width: 320, height: 172 }, 280, 150);
  assert.equal(next.width, 280);
  assert.equal(next.height, 150);
  assert.equal(next.x, 100 + 320 - 280);
  assert.equal(next.y, 200 + 172 - 150);
});

test("saveBounds round-trips x/y with size", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "widget-bounds-"));
  const saved = saveBounds(dir, { x: 40, y: 24, width: 240, height: 140 });
  assert.deepEqual(saved, { x: 40, y: 24, width: 240, height: 140 });
  assert.deepEqual(loadBounds(dir), { x: 40, y: 24, width: 240, height: 140 });
});

test("saveBounds keeps userSized after a later save omits the flag", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "widget-bounds-"));
  const saved = saveBounds(dir, { x: 40, y: 24, width: 240, height: 140, userSized: true });
  assert.deepEqual(saved, { x: 40, y: 24, width: 240, height: 140, userSized: true });
  assert.deepEqual(loadBounds(dir), { x: 40, y: 24, width: 240, height: 140, userSized: true });
  const later = saveBounds(dir, { x: 48, y: 30, width: 260, height: 160 });
  assert.deepEqual(later, { x: 48, y: 30, width: 260, height: 160, userSized: true });
  assert.deepEqual(loadBounds(dir), { x: 48, y: 30, width: 260, height: 160, userSized: true });
  const raw = JSON.parse(fs.readFileSync(path.join(dir, "widget-bounds.json"), "utf8"));
  assert.equal(raw.userSized, true);
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

test("dockedBounds parks a bottom-right widget on the bottom edge", () => {
  const workArea = { x: 0, y: 0, width: 1920, height: 1080 };
  const rest = cornerPlacement({ width: DEFAULT_WIDTH, height: 172 }, workArea, 16);
  assert.equal(nearestDockEdge(rest, workArea), "bottom");
  const parked = dockedBounds(rest, workArea);
  assert.equal(parked.edge, "bottom");
  assert.equal(parked.x, rest.x);
  assert.equal(parked.y, workArea.height - DOCK_PEEK_PX);
  assert.equal(parked.width, rest.width);
  assert.equal(parked.height, rest.height);
});

test("dockedBounds parks toward the nearest side", () => {
  const workArea = { x: 0, y: 0, width: 1920, height: 1080 };
  const left = dockedBounds({ x: 8, y: 400, width: 320, height: 172 }, workArea);
  assert.equal(left.edge, "left");
  assert.equal(left.x, DOCK_PEEK_PX - 320);
  const right = dockedBounds({ x: 1500, y: 200, width: 320, height: 172 }, workArea);
  assert.equal(right.edge, "right");
  assert.equal(right.x, 1920 - DOCK_PEEK_PX);
  const top = dockedBounds({ x: 400, y: 4, width: 320, height: 172 }, workArea);
  assert.equal(top.edge, "top");
  assert.equal(top.y, DOCK_PEEK_PX - 172);
});

test("dockedBounds skips an edge that covers the taskbar or another display", () => {
  // The layout of the machine that found the bug: a 48 px bottom taskbar,
  // one display below the primary and one to its right.
  const primary = {
    id: 1,
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1032 },
  };
  const below = { id: 2, bounds: { x: 384, y: 1080, width: 1536, height: 960 } };
  const right = { id: 3, bounds: { x: 1920, y: 267, width: 1536, height: 961 } };
  const rest = cornerPlacement({ width: 221, height: 141 }, primary.workArea, 16);

  const alone = dockedBounds(rest, primary.workArea, DOCK_PEEK_PX, dockBlockers(primary, [primary]));
  assert.equal(alone.edge, "right");
  assert.equal(alone.x, 1920 - DOCK_PEEK_PX);

  const boxed = dockedBounds(
    rest,
    primary.workArea,
    DOCK_PEEK_PX,
    dockBlockers(primary, [primary, below, right]),
  );
  assert.equal(boxed.edge, null);
  assert.deepEqual({ x: boxed.x, y: boxed.y, width: boxed.width, height: boxed.height }, rest);
});

test("lerpBounds reaches the parked point and the home point", () => {
  const from = { x: 100, y: 200, width: 320, height: 172 };
  const to = { x: 100, y: 900, width: 320, height: 172 };
  assert.deepEqual(lerpBounds(from, to, 0), from);
  assert.deepEqual(lerpBounds(from, to, 1), to);
});

test("hover target keeps the edge strip while the widget is open", () => {
  const workArea = { x: 0, y: 0, width: 1920, height: 1080 };
  const rest = { x: 1584, y: 892, width: 320, height: 172 };
  const parked = dockedBounds(rest, workArea);
  const openTarget = hoverTargetBounds({
    rest,
    current: rest,
    workArea,
    hidden: false,
    applying: false,
  });
  const edgePoint = { x: rest.x + 10, y: workArea.height - 2 };
  assert.equal(boundsContainPoint(openTarget, edgePoint), true);
  assert.equal(boundsContainPoint(rest, edgePoint), false);
  const parkedTarget = hoverTargetBounds({
    rest,
    current: parked,
    workArea,
    hidden: true,
    applying: false,
  });
  assert.equal(boundsContainPoint(parkedTarget, edgePoint), true);
  assert.equal(boundsContainPoint(parkedTarget, { x: rest.x + 10, y: rest.y + 10 }), false);
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
