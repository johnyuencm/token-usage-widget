"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createWidgetDock } = require("../desktop/widget-dock.cjs");
const { DOCK_PEEK_PX } = require("../desktop/widget-bounds.cjs");

const workArea = { x: 0, y: 0, width: 1920, height: 1080 };
const home = { x: 1584, y: 892, width: 320, height: 172 };

function harness() {
  let current = { ...home };
  const sets = [];
  const pending = [];
  const dock = createWidgetDock({
    hideDelayMs: 25,
    slideMs: 0,
    schedule: (fn, ms) => {
      const item = { fn, ms, cancelled: false };
      pending.push(item);
      return item;
    },
    cancel: (item) => {
      item.cancelled = true;
    },
    every: (fn) => {
      const item = { fn, cancelled: false, kind: "every" };
      pending.push(item);
      return item;
    },
    cancelEvery: (item) => {
      item.cancelled = true;
    },
    getBounds: () => ({ ...current }),
    setBounds: (bounds) => {
      current = { ...bounds };
      sets.push({ ...bounds });
    },
    workAreaFor: () => workArea,
  });
  dock.setRest(home);
  return {
    dock,
    sets,
    pending,
    pos: () => ({ ...current }),
    flush() {
      const item = pending.find((entry) => entry.kind !== "every" && !entry.cancelled && !entry.ran);
      if (!item) return false;
      item.ran = true;
      item.fn();
      return true;
    },
  };
}

test("the widget parks on the bottom strip and slides home on hover", () => {
  const box = harness();
  box.dock.notePointer(false);
  assert.equal(box.flush(), true);
  assert.equal(box.pos().y, workArea.height - DOCK_PEEK_PX);
  assert.equal(box.pos().x, home.x);
  assert.deepEqual(box.dock.getRest(), home);

  box.dock.notePointer(true);
  assert.deepEqual(box.pos(), home);
  assert.equal(box.dock.isHidden(), false);

  box.dock.notePointer(false);
  assert.equal(box.pos().y, home.y);
  assert.equal(box.flush(), true);
  assert.equal(box.pos().y, workArea.height - DOCK_PEEK_PX);
  assert.deepEqual(box.dock.getRest(), home);
});

test("a hover during the hide delay keeps the widget open", () => {
  const box = harness();
  box.dock.reveal();
  const hide = box.pending.find((entry) => entry.kind !== "every" && !entry.cancelled);
  box.dock.notePointer(true);
  assert.equal(hide.cancelled, true);
  assert.equal(box.flush(), false);
  assert.deepEqual(box.pos(), home);
});

test("retarget keeps a parked widget on the strip after the home moves", () => {
  const box = harness();
  box.dock.notePointer(false);
  box.flush();
  const moved = { x: 700, y: 800, width: 240, height: 140 };
  box.dock.setRest(moved);
  box.dock.retarget();
  assert.equal(box.pos().x, moved.x);
  assert.equal(box.pos().y, workArea.height - DOCK_PEEK_PX);
  assert.equal(box.dock.getRest().y, moved.y);
});
