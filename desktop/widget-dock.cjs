"use strict";

const { dockedBounds, lerpBounds } = require("./widget-bounds.cjs");

function sameBounds(a, b) {
  return Boolean(
    a &&
      b &&
      a.x === b.x &&
      a.y === b.y &&
      a.width === b.width &&
      a.height === b.height,
  );
}

/** DIP to pixel rounding on a scaled display moves an edge by up to 2 px. */
function nearBounds(a, b, px = 2) {
  return ["x", "y", "width", "height"].every((k) => Math.abs(a[k] - b[k]) <= px);
}

/**
 * Slide the widget between its home rectangle and the parked strip.
 * Timers are injectable so tests do not wait on the clock.
 */
function createWidgetDock({
  peek,
  hideDelayMs = 400,
  slideMs = 200,
  now = () => Date.now(),
  schedule = (fn, ms) => {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return timer;
  },
  cancel = (timer) => clearTimeout(timer),
  every = (fn, ms) => {
    const timer = setInterval(fn, ms);
    timer.unref?.();
    return timer;
  },
  cancelEvery = (timer) => clearInterval(timer),
  getBounds,
  setBounds,
  workAreaFor,
  blockedFor = () => [],
  onSlideStart,
  onSlideEnd,
  onRest,
} = {}) {
  let rest = null;
  let hidden = false;
  let pointerInside = false;
  let applying = false;
  let hideTimer = null;
  let slideTimer = null;
  let slideToken = 0;

  function remember(bounds) {
    rest = {
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
    };
  }

  function parkedFor() {
    return dockedBounds(rest, workAreaFor(rest), peek, blockedFor(rest));
  }

  /** False when every near edge is blocked; the widget then stays open. */
  function canPark() {
    return Boolean(rest) && parkedFor().edge !== null;
  }

  function targetFor(wantHidden) {
    if (!rest) return null;
    if (!wantHidden) return { ...rest };
    const parked = parkedFor();
    return {
      x: parked.x,
      y: parked.y,
      width: parked.width,
      height: parked.height,
    };
  }

  function stopSlide() {
    slideToken += 1;
    if (slideTimer) cancelEvery(slideTimer);
    slideTimer = null;
  }

  function finishApplying() {
    if (!applying) return;
    applying = false;
    onSlideEnd?.();
  }

  function slide(wantHidden) {
    hidden = Boolean(wantHidden) && canPark();
    if (!rest) return;
    const target = targetFor(hidden);
    const from = getBounds();
    if (!target || !from || sameBounds(from, target)) {
      stopSlide();
      finishApplying();
      return;
    }
    stopSlide();
    const token = slideToken;
    const start = now();
    applying = true;
    onSlideStart?.();
    const step = () => {
      if (token !== slideToken) return;
      const t = slideMs <= 0 ? 1 : Math.min(1, (now() - start) / slideMs);
      const eased = 1 - (1 - t) ** 3;
      setBounds(lerpBounds(from, target, eased));
      if (t < 1) return;
      if (slideTimer) cancelEvery(slideTimer);
      slideTimer = null;
      finishApplying();
    };
    slideTimer = every(step, 16);
    step();
  }

  function clearHide() {
    if (!hideTimer) return;
    cancel(hideTimer);
    hideTimer = null;
  }

  function scheduleHide() {
    clearHide();
    if (pointerInside) return;
    hideTimer = schedule(() => {
      hideTimer = null;
      if (!pointerInside) slide(true);
    }, hideDelayMs);
  }

  return {
    isApplying: () => applying,
    isHidden: () => hidden,
    getRest: () => (rest ? { ...rest } : null),
    setRest(bounds) {
      if (!bounds) return;
      remember(bounds);
    },
    notePointer(inside) {
      const next = Boolean(inside);
      if (next === pointerInside) {
        if (next) return;
        if (hideTimer || hidden || applying) return;
        scheduleHide();
        return;
      }
      pointerInside = next;
      if (pointerInside) {
        clearHide();
        slide(false);
        return;
      }
      scheduleHide();
    },
    reveal() {
      clearHide();
      slide(false);
      scheduleHide();
    },
    cancelPending() {
      clearHide();
      stopSlide();
      finishApplying();
    },
    retarget() {
      if (!rest) return;
      hidden = hidden && canPark();
      const target = targetFor(hidden);
      const from = getBounds();
      if (!target || !from || sameBounds(from, target)) return;
      stopSlide();
      applying = true;
      onSlideStart?.();
      setBounds(target);
      finishApplying();
    },
    noteUserBounds(bounds) {
      if (applying || hidden) return false;
      // Rounding noise is not a user move. Saving it made each start 1 px bigger.
      if (rest && nearBounds(rest, bounds)) return false;
      remember(bounds);
      onRest?.();
      return true;
    },
    dispose() {
      clearHide();
      stopSlide();
      applying = false;
    },
  };
}

module.exports = { createWidgetDock };
