const WINDOW_META = {
  five_hour: { label: "5-Hour Window", short: "5h" },
  week: { label: "Weekly Window", short: "7d" },
  month: { label: "Monthly Window", short: "30d" },
};

const OPENCODE_WINDOW_META = {
  five_hour: { label: "Rolling Usage", short: "5h" },
  week: { label: "Weekly Usage", short: "7d" },
  month: { label: "Monthly Usage", short: "30d" },
};

const DEFAULT_UI = {
  refreshIntervalSec: 60,
  pollIntervalSec: { claude: 300 },
  display: {
    claude: { fiveHour: true, week: true, spend: true },
    cursor: { total: true, auto: true, api: true },
  },
};

let uiSettings = structuredClone(DEFAULT_UI);
let refreshTimer = null;

const providersEl = document.getElementById("providers");
const footerStatus = document.getElementById("footer-status");
const footerHint = document.getElementById("footer-hint");
const refreshClock = document.getElementById("refresh-clock");
const refreshPulse = document.getElementById("refresh-pulse");
const fixtureBadge = document.getElementById("fixture-badge");
const providerTemplate = document.getElementById("provider-template");
const windowTemplate = document.getElementById("window-template");
const cursorBillTemplate = document.getElementById("cursor-bill-template");
const balanceTemplate = document.getElementById("balance-template");
const settingsForm = document.getElementById("settings-form");
const settingsStatus = document.getElementById("settings-status");
const viewDashboard = document.getElementById("view-dashboard");
const viewSettings = document.getElementById("view-settings");
const navLinks = document.querySelectorAll(".site-nav-link");

function fmtPct(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `${Number(value).toFixed(1)}%`;
}

function fmtPctWhole(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `${Math.round(Number(value))}%`;
}

function fmtTokens(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function fmtReset(iso) {
  return globalThis.TokenUsageFmt?.formatReset(iso) ?? "";
}

function toneFor(usedPercent, status) {
  if (status !== "ok" || usedPercent === null) return "ghost";
  if (usedPercent >= 85) return "danger";
  if (usedPercent >= 60) return "warn";
  return "ok";
}

function billTone(usedPercent) {
  if (usedPercent === null || usedPercent === undefined) return "ghost";
  if (usedPercent >= 85) return "danger";
  if (usedPercent >= 60) return "warn";
  return "ok";
}

function mergeUi(incoming) {
  const base = structuredClone(DEFAULT_UI);
  if (!incoming || typeof incoming !== "object") return base;
  if (typeof incoming.refreshIntervalSec === "number") base.refreshIntervalSec = incoming.refreshIntervalSec;
  if (incoming.pollIntervalSec && typeof incoming.pollIntervalSec === "object") {
    base.pollIntervalSec = { ...base.pollIntervalSec, ...incoming.pollIntervalSec };
  }
  if (incoming.display?.claude) base.display.claude = { ...base.display.claude, ...incoming.display.claude };
  if (incoming.display?.cursor) base.display.cursor = { ...base.display.cursor, ...incoming.display.cursor };
  return base;
}

function claudeWindowOrder() {
  const d = uiSettings.display.claude;
  const out = [];
  if (d.fiveHour) out.push("five_hour");
  if (d.week) out.push("week");
  return out;
}

function formatRefreshHint(sec) {
  if (sec < 60) return `${sec}s`;
  if (sec % 60 === 0) return `${sec / 60}m`;
  return `${sec}s`;
}

function setRefreshInterval(sec) {
  if (refreshTimer) clearInterval(refreshTimer);
  const ms = Math.max(30, sec) * 1000;
  refreshTimer = setInterval(refresh, ms);
  const label = formatRefreshHint(sec);
  footerHint.textContent = `Auto-refresh ${label}`;
  refreshPulse.title = `Auto-refresh every ${label}`;
}

function renderWindow(parent, winId, win, providerId) {
  const meta =
    providerId === "opencode" ? OPENCODE_WINDOW_META[winId] : WINDOW_META[winId];
  const node = windowTemplate.content.cloneNode(true);
  const article = node.querySelector(".window");
  article.dataset.status = win.status;
  article.dataset.window = winId;

  node.querySelector(".window-label").textContent = meta.label;
  node.querySelector(".window-reset").textContent =
    win.status === "ok" ? fmtReset(win.resetsAtIso) : win.reason || "";

  const fill = node.querySelector(".meter-fill");
  const used = win.status === "ok" ? win.usedPercent : null;
  fill.style.width = used !== null ? `${Math.min(100, Math.max(0, used))}%` : "0%";
  fill.dataset.tone = toneFor(used, win.status);

  const pctFmt = providerId === "opencode" || providerId === "cursor" ? fmtPctWhole : fmtPct;
  node.querySelector(".stat-used").textContent =
    win.status === "ok" ? pctFmt(win.usedPercent) : "Unavailable";
  node.querySelector(".stat-remaining").textContent =
    win.status === "ok" && win.remainingPercent !== null && win.remainingPercent !== undefined
      ? pctFmt(win.remainingPercent)
      : win.status === "ok"
        ? "uncapped"
        : "Unavailable";
  const tokensStat = node.querySelector(".stat--tokens");
  if (providerId === "opencode" && (win.usedTokens === null || win.usedTokens === undefined)) {
    tokensStat.hidden = true;
  } else {
    node.querySelector(".stat-tokens").textContent =
      win.usedTokens !== null && win.usedTokens !== undefined
        ? fmtTokens(win.usedTokens)
        : "—";
  }

  parent.appendChild(node);
}

function fmtBalanceRemaining(balance) {
  if (balance.currency === "USD") {
    const used = balance.used;
    const total = balance.total;
    if (
      used !== null &&
      used !== undefined &&
      !Number.isNaN(Number(used)) &&
      total !== null &&
      total !== undefined &&
      !Number.isNaN(Number(total))
    ) {
      return `$${Number(used).toFixed(2)} of $${Number(total).toFixed(2)}`;
    }
  }
  if (balance.remaining === null || balance.remaining === undefined || Number.isNaN(Number(balance.remaining))) {
    return "—";
  }
  const n = Number(balance.remaining);
  if (balance.currency === "USD") return `$${n.toFixed(2)}`;
  return String(Math.round(n));
}

function renderBalance(parent, balance) {
  const node = balanceTemplate.content.cloneNode(true);
  node.querySelector(".balance-label").textContent = balance.label || "Balance";
  node.querySelector(".balance-remaining").textContent = fmtBalanceRemaining(balance);
  const unit = node.querySelector(".balance-unit");
  if (balance.currency === "USD") {
    const used = balance.used;
    const total = balance.total;
    if (used !== null && used !== undefined && total !== null && total !== undefined) {
      unit.textContent = "";
    } else {
      unit.textContent = "left";
    }
  } else if (balance.currency === "credits") {
    unit.textContent = "credits left";
  } else {
    unit.textContent = "";
  }
  const resetEl = node.querySelector(".balance-reset");
  resetEl.textContent = balance.resetsAtIso ? fmtReset(balance.resetsAtIso) : "";
  parent.appendChild(node);
}

function renderCursorBilling(parent, billing, error, display) {
  const node = cursorBillTemplate.content.cloneNode(true);
  const card = node.querySelector(".cursor-bill");
  const show = display ?? uiSettings.display.cursor;

  if (show.total) {
    node.querySelector(".bill-plan").textContent = billing.planLabel || "Included in plan";
    node.querySelector(".bill-total-pct").textContent = fmtPctWhole(billing.totalPercentUsed);
    setBillMeter(node.querySelector(".bill-total"), billing.totalPercentUsed);
  } else {
    node.querySelector(".bill-total").hidden = true;
    node.querySelector(".bill-plan").textContent = billing.planLabel || "Included in plan";
  }

  const auto = billing.autoPercentUsed;
  const api = billing.apiPercentUsed;
  const summary = node.querySelector(".bill-summary-text");
  const summaryParts = [];
  if (show.auto && auto !== null && auto !== undefined) summaryParts.push(`${fmtPctWhole(auto)} First-party models`);
  if (show.api && api !== null && api !== undefined) summaryParts.push(`${fmtPctWhole(api)} API`);
  if (summaryParts.length) {
    summary.textContent = `${summaryParts.join(" and ")} used`;
  } else if (billing.displayMessage) {
    summary.textContent = billing.displayMessage;
  } else {
    summary.textContent = "Usage breakdown unavailable";
  }

  const resetEl = node.querySelector(".bill-reset");
  resetEl.textContent = billing.resetsAtIso ? fmtReset(billing.resetsAtIso) : "";

  const autoBucket = node.querySelector(".bill-auto");
  const apiBucket = node.querySelector(".bill-api");
  if (show.auto) {
    node.querySelector(".bill-auto-pct").textContent = fmtPctWhole(auto);
    setBillMeter(autoBucket, auto);
    node.querySelector(".bill-auto-note").textContent =
      billing.autoNote || "Additional usage beyond limits consumes API quota or on-demand spend.";
  } else {
    autoBucket.hidden = true;
  }

  if (show.api) {
    node.querySelector(".bill-api-pct").textContent = fmtPctWhole(api);
    setBillMeter(apiBucket, api);
    node.querySelector(".bill-api-note").textContent =
      billing.apiNote || "Additional usage beyond limits consumes on-demand spend.";
  } else {
    apiBucket.hidden = true;
  }

  if (!show.auto && !show.api) {
    node.querySelector(".bill-details").hidden = true;
    node.querySelector(".bill-summary").hidden = true;
  }

  const rem = node.querySelector(".bill-remaining");
  rem.textContent =
    billing.remainingPercent !== null && billing.remainingPercent !== undefined
      ? `${fmtPctWhole(billing.remainingPercent)} remaining this cycle`
      : "";

  if (error) {
    const err = node.querySelector(".bill-error");
    err.textContent = error;
    err.hidden = false;
  }

  const toggle = node.querySelector(".bill-summary");
  const details = node.querySelector(".bill-details");
  toggle.addEventListener("click", () => {
    const open = details.hidden;
    details.hidden = !open;
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    card.dataset.expanded = open ? "true" : "false";
  });

  parent.appendChild(node);
}

function setBillMeter(root, usedPercent) {
  const fill = root.querySelector(".bill-meter-fill");
  const pct = usedPercent === null || usedPercent === undefined ? null : Math.min(100, Math.max(0, usedPercent));
  fill.style.width = pct !== null ? `${pct}%` : "0%";
  fill.dataset.tone = billTone(pct);
}

function renderProvider(p) {
  const node = providerTemplate.content.cloneNode(true);
  node.querySelector(".provider-title").textContent = p.label;
  const sub = p.error ? "error" : "live";
  node.querySelector(".provider-sub").textContent = sub;
  const errEl = node.querySelector(".provider-error");
  const windowsEl = node.querySelector(".windows");

  if (p.provider === "cursor" && p.billing) {
    windowsEl.classList.add("windows--billing");
    renderCursorBilling(windowsEl, p.billing, p.error, uiSettings.display.cursor);
    if (p.error) errEl.hidden = true;
  } else {
    if (p.error) {
      errEl.textContent = p.error;
      errEl.hidden = false;
    }
    const showSpend = p.provider !== "claude" || uiSettings.display.claude.spend;
    if (p.balance && showSpend) {
      windowsEl.classList.add("windows--balance");
      renderBalance(windowsEl, p.balance);
    }
    const windowIds =
      p.provider === "claude"
        ? claudeWindowOrder()
        : ["five_hour", "week", "month"];
    const showWindows =
      !p.balance ||
      p.provider === "claude" ||
      Object.values(p.windows || {}).some((w) => w && w.status === "ok");
    if (showWindows) {
      for (const winId of windowIds) {
        const win = p.windows?.[winId];
        if (!win || win.status !== "ok") continue;
        renderWindow(windowsEl, winId, win, p.provider);
      }
    }
  }
  providersEl.appendChild(node);
}

function renderAll(data) {
  providersEl.innerHTML = "";
  for (const p of data.providers) renderProvider(p);
  fixtureBadge.hidden = !data.fixture;
  if (data.ui) {
    uiSettings = mergeUi(data.ui);
    setRefreshInterval(uiSettings.refreshIntervalSec);
    populateSettingsForm();
  }
}

function updateClock() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  refreshClock.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

async function refresh() {
  try {
    const res = await fetch("/api/usage", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderAll(data);
    footerStatus.textContent = `Last updated ${new Date(data.fetchedAt).toLocaleTimeString()}`;
    document.querySelector(".site-footer").classList.remove("error");
  } catch (err) {
    footerStatus.textContent = `Failed to load: ${err.message}`;
    document.querySelector(".site-footer").classList.add("error");
  }
  updateClock();
}

function populateSettingsForm() {
  if (!settingsForm) return;
  settingsForm.refreshIntervalSec.value = String(uiSettings.refreshIntervalSec);
  settingsForm.pollClaudeSec.value = String(uiSettings.pollIntervalSec.claude ?? 300);
  settingsForm.claudeFiveHour.checked = uiSettings.display.claude.fiveHour;
  settingsForm.claudeWeek.checked = uiSettings.display.claude.week;
  settingsForm.claudeSpend.checked = uiSettings.display.claude.spend;
  settingsForm.cursorTotal.checked = uiSettings.display.cursor.total;
  settingsForm.cursorAuto.checked = uiSettings.display.cursor.auto;
  settingsForm.cursorApi.checked = uiSettings.display.cursor.api;
}

async function loadSettings() {
  const res = await fetch("/api/settings", { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  uiSettings = mergeUi(data.ui);
  populateSettingsForm();
  setRefreshInterval(uiSettings.refreshIntervalSec);
}

function readSettingsFromForm() {
  return {
    refreshIntervalSec: Number(settingsForm.refreshIntervalSec.value),
    pollIntervalSec: { claude: Number(settingsForm.pollClaudeSec.value) },
    display: {
      claude: {
        fiveHour: settingsForm.claudeFiveHour.checked,
        week: settingsForm.claudeWeek.checked,
        spend: settingsForm.claudeSpend.checked,
      },
      cursor: {
        total: settingsForm.cursorTotal.checked,
        auto: settingsForm.cursorAuto.checked,
        api: settingsForm.cursorApi.checked,
      },
    },
  };
}

async function saveSettings(ev) {
  ev.preventDefault();
  settingsStatus.textContent = "Saving…";
  try {
    const ui = readSettingsFromForm();
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ui }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    uiSettings = mergeUi(data.ui);
    setRefreshInterval(uiSettings.refreshIntervalSec);
    settingsStatus.textContent = "Saved";
    await refresh();
  } catch (err) {
    settingsStatus.textContent = `Save failed: ${err.message}`;
  }
}

function showView(name) {
  const dashboard = name !== "settings";
  viewDashboard.hidden = !dashboard;
  viewDashboard.classList.toggle("view--active", dashboard);
  viewSettings.hidden = dashboard;
  viewSettings.classList.toggle("view--active", !dashboard);
  for (const link of navLinks) {
    link.classList.toggle("site-nav-link--active", link.dataset.view === name);
  }
}

function syncViewFromHash() {
  const view = location.hash === "#settings" ? "settings" : "dashboard";
  showView(view);
}

async function start() {
  try {
    await loadSettings();
  } catch {
    setRefreshInterval(DEFAULT_UI.refreshIntervalSec);
  }
  syncViewFromHash();
  window.addEventListener("hashchange", syncViewFromHash);
  settingsForm?.addEventListener("submit", saveSettings);
  refresh();
  setInterval(updateClock, 1000);
}

start();
