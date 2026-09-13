"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_WIDTH = 320;
const DEFAULT_HEIGHT = 96;
const MIN_WIDTH = 220;
const MIN_HEIGHT = 72;
const MAX_WIDTH = 900;
const MAX_HEIGHT = 640;

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
 * @returns {{ width: number, height: number, x?: number, y?: number } | null}
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
    return out;
  } catch {
    return null;
  }
}

/**
 * @param {string} userDataDir
 * @param {{ width?: number, height?: number, x?: number, y?: number }} size
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
  clamp,
  boundsFile,
  loadBounds,
  saveBounds,
  cornerPlacement,
  resizeBottomRight,
  clampBoundsToWorkArea,
  restorePlacement,
};
