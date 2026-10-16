"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_WIDTH = 320;
const DEFAULT_HEIGHT = 140;
const MIN_WIDTH = 220;
// Compact floor from the minimized widget: header plus the provider rows,
// short enough that wrapped lines scroll instead of stretching the window.
const MIN_HEIGHT = 140;
const MAX_WIDTH = 900;
const MAX_HEIGHT = 640;
/** Visible strip left on the nearest screen edge while the widget is parked. */
const DOCK_PEEK_PX = 32;
const DOCK_EDGE_PREFERENCE = ["bottom", "right", "left", "top"];

function clamp(n, lo, hi) {
  const x = Number(n);
  if (!Number.isFinite(x)) return lo;
  return Math.min(hi, Math.max(lo, Math.round(x)));
}

function boundsFile(userDataDir) {
  return path.join(userDataDir, "widget-bounds.json");
}

function readFinite(n) {
  const x = Number(n);
  return Number.isFinite(x) ? Math.round(x) : null;
}

/**
 * @param {string} userDataDir
 * @returns {{ width: number, height: number, x?: number, y?: number, userSized?: true } | null}
 */
function loadBounds(userDataDir) {
  try {
    const raw = fs.readFileSync(boundsFile(userDataDir), "utf8");
    const j = JSON.parse(raw);
    if (!j || typeof j !== "object") return null;
    const out = {
      width: clamp(j.width, MIN_WIDTH, MAX_WIDTH),
      height: clamp(j.height, MIN_HEIGHT, MAX_HEIGHT),
    };
    const x = readFinite(j.x);
    const y = readFinite(j.y);
    if (x !== null && y !== null) {
      out.x = x;
      out.y = y;
    }
    if (j.userSized === true) out.userSized = true;
    return out;
  } catch {
    return null;
  }
}

/**
 * @param {string} userDataDir
 * @param {{ width?: number, height?: number, x?: number, y?: number, userSized?: boolean }} size
 */
function saveBounds(userDataDir, size) {
  const prev = loadBounds(userDataDir) || { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
  const next = {
    width: clamp(size.width ?? prev.width, MIN_WIDTH, MAX_WIDTH),
    height: clamp(size.height ?? prev.height, MIN_HEIGHT, MAX_HEIGHT),
  };
  const x = readFinite(size.x ?? prev.x);
  const y = readFinite(size.y ?? prev.y);
  if (x !== null && y !== null) {
    next.x = x;
    next.y = y;
  }
  if (size.userSized === true || prev.userSized === true) next.userSized = true;
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(boundsFile(userDataDir), `${JSON.stringify(next)}\n`, "utf8");
  return next;
}

/**
 * @param {{ width: number, height: number }} size
 * @param {{ x: number, y: number, width: number, height: number }} workArea
 * @param {number} margin
 */
function cornerPlacement(size, workArea, margin) {
  const width = clamp(size.width, MIN_WIDTH, MAX_WIDTH);
  const height = clamp(size.height, MIN_HEIGHT, MAX_HEIGHT);
  return {
    width,
    height,
    x: Math.round(workArea.x + workArea.width - width - margin),
    y: Math.round(workArea.y + workArea.height - height - margin),
  };
}

/**
 * Keep the bottom-right corner fixed while changing size (corner widget).
 * @param {{ x: number, y: number, width: number, height: number }} bounds
 * @param {number} width
 * @param {number} height
 */
function resizeBottomRight(bounds, width, height) {
  const w = clamp(width, MIN_WIDTH, MAX_WIDTH);
  const h = clamp(height, MIN_HEIGHT, MAX_HEIGHT);
  return {
    x: Math.round(bounds.x + bounds.width - w),
    y: Math.round(bounds.y + bounds.height - h),
    width: w,
    height: h,
  };
}

/**
 * @param {{ x?: number, y?: number, width?: number, height?: number }} bounds
 * @param {{ x: number, y: number, width: number, height: number }} workArea
 */
function clampBoundsToWorkArea(bounds, workArea) {
  const width = clamp(bounds.width, MIN_WIDTH, MAX_WIDTH);
  const height = clamp(bounds.height, MIN_HEIGHT, MAX_HEIGHT);
  const minX = workArea.x;
  const minY = workArea.y;
  const maxX = workArea.x + Math.max(0, workArea.width - width);
  const maxY = workArea.y + Math.max(0, workArea.height - height);
  const x = readFinite(bounds.x);
  const y = readFinite(bounds.y);
  return {
    width,
    height,
    x: Math.round(Math.min(Math.max(x === null ? minX : x, minX), maxX)),
    y: Math.round(Math.min(Math.max(y === null ? minY : y, minY), maxY)),
  };
}

/**
 * Pick the screen edge the parked widget slides toward.
 * Equal distances use bottom, then right, then left, then top.
 * @param {{ x: number, y: number, width: number, height: number }} bounds
 * @param {{ x: number, y: number, width: number, height: number }} workArea
 */
function nearestDockEdge(bounds, workArea) {
  const distances = {
    left: bounds.x - workArea.x,
    right: workArea.x + workArea.width - (bounds.x + bounds.width),
    top: bounds.y - workArea.y,
    bottom: workArea.y + workArea.height - (bounds.y + bounds.height),
  };
  let best = DOCK_EDGE_PREFERENCE[0];
  for (const edge of DOCK_EDGE_PREFERENCE) {
    if (distances[edge] < distances[best]) best = edge;
  }
  return best;
}

function intersects(a, b) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * Rectangles a parked widget must not cover: every other display, and the
 * strips of its own display outside the work area (the taskbar).
 * @param {{ id?: number, bounds: { x: number, y: number, width: number, height: number }, workArea: { x: number, y: number, width: number, height: number } }} display
 * @param {Array<{ id?: number, bounds: { x: number, y: number, width: number, height: number } }>} displays
 */
function dockBlockers(display, displays = []) {
  const d = display.bounds;
  const w = display.workArea;
  const strips = [
    { x: d.x, y: d.y, width: d.width, height: w.y - d.y },
    { x: d.x, y: w.y + w.height, width: d.width, height: d.y + d.height - (w.y + w.height) },
    { x: d.x, y: d.y, width: w.x - d.x, height: d.height },
    { x: w.x + w.width, y: d.y, width: d.x + d.width - (w.x + w.width), height: d.height },
  ].filter((r) => r.width > 0 && r.height > 0);
  const others = displays.filter((o) => o.id !== display.id).map((o) => o.bounds);
  return [...strips, ...others];
}

/**
 * Park the widget so only a strip remains on the nearest edge.
 * A corner widget may use either edge of its corner: edges within one strip
 * of the nearest count. An edge whose parked rectangle covers a blocker
 * (another display, the taskbar) is skipped. No free edge: `edge` is null
 * and the bounds stay as they are, so the widget stays open.
 * @param {{ x: number, y: number, width: number, height: number }} bounds
 * @param {{ x: number, y: number, width: number, height: number }} workArea
 * @param {number} [peek]
 * @param {Array<{ x: number, y: number, width: number, height: number }>} [blocked]
 */
function dockedBounds(bounds, workArea, peek = DOCK_PEEK_PX, blocked = []) {
  const lip = Math.max(1, Math.round(peek));
  const base = {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
  };
  const distances = {
    left: bounds.x - workArea.x,
    right: workArea.x + workArea.width - (bounds.x + bounds.width),
    top: bounds.y - workArea.y,
    bottom: workArea.y + workArea.height - (bounds.y + bounds.height),
  };
  const nearest = Math.min(...Object.values(distances));
  const edges = [...DOCK_EDGE_PREFERENCE]
    .filter((edge) => distances[edge] <= nearest + lip)
    .sort((a, b) => distances[a] - distances[b]);
  for (const edge of edges) {
    const next = { ...base };
    if (edge === "left") next.x = Math.round(workArea.x - next.width + lip);
    if (edge === "right") next.x = Math.round(workArea.x + workArea.width - lip);
    if (edge === "top") next.y = Math.round(workArea.y - next.height + lip);
    if (edge === "bottom") next.y = Math.round(workArea.y + workArea.height - lip);
    if (!blocked.some((r) => intersects(next, r))) return { ...next, edge };
  }
  return { ...base, edge: null };
}

/**
 * @param {{ x: number, y: number, width: number, height: number }} from
 * @param {{ x: number, y: number, width: number, height: number }} to
 * @param {number} t
 */
function lerpBounds(from, to, t) {
  const u = Math.min(1, Math.max(0, Number(t) || 0));
  const mix = (a, b) => Math.round(a + (b - a) * u);
  return {
    x: mix(from.x, to.x),
    y: mix(from.y, to.y),
    width: mix(from.width, to.width),
    height: mix(from.height, to.height),
  };
}

/**
 * @param {{ x: number, y: number, width: number, height: number }} a
 * @param {{ x: number, y: number, width: number, height: number }} b
 */
function unionBounds(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

/**
 * @param {{ x: number, y: number, width: number, height: number }} bounds
 * @param {{ x: number, y: number }} point
 */
function boundsContainPoint(bounds, point) {
  return (
    point.x >= bounds.x &&
    point.x < bounds.x + bounds.width &&
    point.y >= bounds.y &&
    point.y < bounds.y + bounds.height
  );
}

/**
 * Hover target. A parked widget uses its visible strip only.
 * An open widget also includes the strip, so the pointer can rest on the edge.
 * @param {{ rest: { x: number, y: number, width: number, height: number } | null, current: { x: number, y: number, width: number, height: number }, workArea: { x: number, y: number, width: number, height: number } | null, hidden: boolean, applying: boolean, peek?: number, blocked?: Array<{ x: number, y: number, width: number, height: number }> }} input
 */
function hoverTargetBounds({ rest, current, workArea, hidden, applying, peek = DOCK_PEEK_PX, blocked = [] }) {
  if (!current) return null;
  if (!rest || !workArea || (hidden && !applying)) return current;
  return unionBounds(rest, dockedBounds(rest, workArea, peek, blocked));
}

/**
 * Restore a saved rectangle when x/y exist; otherwise pin to the bottom-right.
 * @param {{ width?: number, height?: number, x?: number, y?: number } | null} saved
 * @param {{ x: number, y: number, width: number, height: number }} workArea
 * @param {number} margin
 * @param {{ width: number, height: number }} fallbackSize
 */
function restorePlacement(saved, workArea, margin, fallbackSize) {
  const size = {
    width: saved?.width ?? fallbackSize.width,
    height: saved?.height ?? fallbackSize.height,
  };
  const x = readFinite(saved?.x);
  const y = readFinite(saved?.y);
  if (x !== null && y !== null) {
    return clampBoundsToWorkArea({ ...size, x, y }, workArea);
  }
  return cornerPlacement(size, workArea, margin);
}

module.exports = {
  DEFAULT_WIDTH,
  DEFAULT_HEIGHT,
  MIN_WIDTH,
  MIN_HEIGHT,
  MAX_WIDTH,
  MAX_HEIGHT,
  DOCK_PEEK_PX,
  clamp,
  boundsFile,
  loadBounds,
  saveBounds,
  cornerPlacement,
  resizeBottomRight,
  clampBoundsToWorkArea,
  nearestDockEdge,
  dockBlockers,
  dockedBounds,
  lerpBounds,
  unionBounds,
  boundsContainPoint,
  hoverTargetBounds,
  restorePlacement,
};
