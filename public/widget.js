const bodyEl = document.getElementById("body");
const statusEl = document.getElementById("status");
const fixtureEl = document.getElementById("fixture");
const { providerLine, providerTitle } = globalThis.TokenUsageCompact;

let uiSettings = null;
let refreshTimer = null;

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

function renderAll(data) {
  if (data.ui) uiSettings = data.ui;
  const opts = lineOpts();
  const lines = (data.providers || [])
    .map((p) => {
      const line = providerLine(p, opts);
      const title = providerTitle(p);
      const cls = p.error ? "line line--err" : "line";
      const tip = title ? ` title="${escapeHtml(title)}"` : "";
      return `<div class="${cls}"${tip}>${escapeHtml(line)}</div>`;
    })
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

refresh();
