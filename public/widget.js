const bodyEl = document.getElementById("body");
const statusEl = document.getElementById("status");
const fixtureEl = document.getElementById("fixture");
const { providerLine, providerTitle, wrapProviderLine, maxCharsForWidth } =
  globalThis.TokenUsageCompact;

let uiSettings = null;
let refreshTimer = null;
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

function fitToContent() {
  requestAnimationFrame(() => {
    const root = document.documentElement;
    const height = Math.ceil(Math.max(root.scrollHeight, root.getBoundingClientRect().height));
    window.widgetBridge?.fitContent?.({ height });
  });
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

function renderAll(data) {
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
  fitToContent();
  scheduleRefresh();
}

function scheduleRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  const sec = uiSettings?.refreshIntervalSec ?? 60;
  refreshTimer = setInterval(refresh, Math.max(30, sec) * 1000);
}

async function loadUsage() {
  const res = await fetch("/api/usage", { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
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

window.addEventListener("resize", () => {
  if (!lastData) return;
  const width = document.documentElement.clientWidth || window.innerWidth || 0;
  if (Math.abs(width - lastWrapWidth) < 2) return;
  if (wrapResizeTimer) clearTimeout(wrapResizeTimer);
  wrapResizeTimer = setTimeout(() => {
    wrapResizeTimer = null;
    if (lastData) renderAll(lastData);
  }, 50);
});

refresh();
