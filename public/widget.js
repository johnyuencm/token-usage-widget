const bodyEl = document.getElementById("body");
const statusEl = document.getElementById("status");
const fixtureEl = document.getElementById("fixture");
const { providerLine, providerTitle, wrapProviderLine, maxCharsForWidth } =
  globalThis.TokenUsageCompact;

let uiSettings = null;
let refreshTimer = null;
let refreshSec = 0;
let lastData = null;
let lastWrapWidth = 0;
let wrapResizeTimer = null;

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function applyUserSizedClass(result) {
  if (!result || typeof result.locked !== "boolean") return;
  document.documentElement.classList.toggle("user-sized", result.locked);
}

function fitToContent() {
  requestAnimationFrame(() => {
    // The root scrollHeight is never below the window height, so it can not
    // tell main to shrink. The body is as tall as its rows.
    const height = Math.ceil(document.body.getBoundingClientRect().height);
    const pending = window.widgetBridge?.fitContent?.({ height });
    Promise.resolve(pending).then(applyUserSizedClass).catch(() => {});
  });
}

function probeUserSized() {
  const pending = window.widgetBridge?.fitContent?.({ probe: true });
  Promise.resolve(pending).then(applyUserSizedClass).catch(() => {});
}

function lineOpts() {
  return uiSettings?.display ? { display: uiSettings.display } : undefined;
}

function measureMaxChars() {
  const width = document.documentElement.clientWidth || window.innerWidth || 320;
  lastWrapWidth = width;
  const probe = document.createElement("span");
  probe.textContent = "0".repeat(20);
  probe.style.cssText =
    "position:absolute;left:-9999px;top:0;font:inherit;visibility:hidden;white-space:pre";
  document.body.appendChild(probe);
  const ch = probe.getBoundingClientRect().width / 20;
  probe.remove();
  if (!(ch > 0)) return maxCharsForWidth(width);
  return Math.max(16, Math.floor((width - 16) / ch));
}

function lineHtml(p, opts, maxChars) {
  const line = providerLine(p, opts);
  const title = providerTitle(p);
  const cls = p.error ? "line line--err" : "line";
  const tip = title ? ` title="${escapeHtml(title)}"` : "";
  const rows = wrapProviderLine(line, maxChars).map(escapeHtml).join("<br>");
  return `<div class="${cls}"${tip}>${rows}</div>`;
}

function renderAll(data, { fit = true } = {}) {
  lastData = data;
  if (data.ui) uiSettings = data.ui;
  const opts = lineOpts();
  const maxChars = measureMaxChars();
  const lines = (data.providers || [])
    .map((p) => lineHtml(p, opts, maxChars))
    .join("");

  bodyEl.innerHTML = lines || `<div class="line">No providers</div>`;
  fixtureEl.hidden = !data.fixture;
  const t = data.fetchedAt ? new Date(data.fetchedAt).toLocaleTimeString() : "";
  statusEl.textContent = t ? `↻ ${t}` : "";
  statusEl.classList.remove("error");
  statusEl.title = "";
  if (fit) fitToContent();
  scheduleRefresh();
}

/** One interval timer; restart it only when the interval changes. */
function scheduleRefresh() {
  const sec = Math.max(30, uiSettings?.refreshIntervalSec ?? 60);
  if (refreshTimer && sec === refreshSec) return;
  if (refreshTimer) clearInterval(refreshTimer);
  refreshSec = sec;
  refreshTimer = setInterval(refresh, sec * 1000);
}

async function loadUsage() {
  const res = await fetch("/api/usage", { cache: "no-store" });
  if (!res.ok) {
    // A bad config.json comes back as a 500 with its message; show that, not the code.
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || `HTTP ${res.status}`);
  }
  renderAll(await res.json());
}

async function refresh() {
  try {
    await loadUsage();
  } catch (err) {
    statusEl.textContent = `fail`;
    statusEl.classList.add("error");
    statusEl.title = String(err.message || err);
    fitToContent();
    try {
      const revived = await window.widgetBridge?.ensureServer?.();
      if (revived?.ok) await loadUsage();
    } catch (retryErr) {
      statusEl.title = String(retryErr.message || retryErr);
      fitToContent();
    }
  }
}

document.getElementById("btn-hide").addEventListener("click", () => {
  window.widgetBridge?.close?.();
});
document.getElementById("btn-dash").addEventListener("click", () => {
  window.widgetBridge?.openDashboard?.();
});
document.getElementById("btn-quit").addEventListener("click", () => {
  window.widgetBridge?.quit?.();
});

function reportPointer(inside) {
  const pending = window.widgetBridge?.setPointerInside?.(inside);
  Promise.resolve(pending).catch(() => {});
}

document.documentElement.addEventListener("pointerenter", () => reportPointer(true));
document.documentElement.addEventListener("pointerleave", () => reportPointer(false));

window.addEventListener("resize", () => {
  if (wrapResizeTimer) clearTimeout(wrapResizeTimer);
  wrapResizeTimer = setTimeout(() => {
    wrapResizeTimer = null;
    const width = document.documentElement.clientWidth || window.innerWidth || 0;
    if (lastData && Math.abs(width - lastWrapWidth) >= 2) {
      renderAll(lastData, { fit: false });
    }
    probeUserSized();
  }, 50);
});

// Start the timer before the first load, so a failed first load still retries.
scheduleRefresh();
refresh();
