const WINDOW_META = {
  five_hour: { label: "5-hour window", short: "5h" },
  week: { label: "Weekly window", short: "7d" },
  month: { label: "Monthly window", short: "30d" },
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
/** Open/closed state of the Cursor billing details; it outlives each redraw. */
let cursorBillExpanded = true;
/** fetchedAt of the last good load, so a failed poll can say how old the shown data is. */
let lastLoadedAt = null;
/** The running /api/usage request; a timer tick or a second click joins it. */
let refreshInFlight = null;

const providersEl = document.getElementById("providers");
const statusEl = document.getElementById("status");
const refreshButton = document.getElementById("refresh-now");
const fixtureBadge = document.getElementById("fixture-badge");
const providerTemplate = document.getElementById("provider-template");
const windowTemplate = document.getElementById("window-template");
const cursorBillTemplate = document.getElementById("cursor-bill-template");
const balanceTemplate = document.getElementById("balance-template");
const settingsForm = document.getElementById("settings-form");
const settingsStatus = document.getElementById("settings-status");
const settingsSave = document.getElementById("settings-save");
const viewDashboard = document.getElementById("view-dashboard");
const viewSettings = document.getElementById("view-settings");
const navLinks = document.querySelectorAll(".tabs .tab");

function fmtPct(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `${Number(value).toFixed(1)}%`;
}

/** Whole %, but never full or empty early: 99.6% used is 99%, 0.4% left is 1%. */
function fmtPctWhole(value, mode = "used") {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  const x = Number(value);
  let n = Math.round(x);
  if (mode === "remaining" && x > 0 && n === 0) n = 1;
  if (mode !== "remaining" && x < 100 && n === 100) n = 99;
  return `${n}%`;
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
  const plural = (n, unit) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  return sec >= 60 && sec % 60 === 0 ? plural(sec / 60, "minute") : plural(sec, "second");
}

function setRefreshInterval(sec) {
  if (refreshTimer) clearInterval(refreshTimer);
  const ms = Math.max(30, sec) * 1000;
  refreshTimer = setInterval(refresh, ms);
}

function fmtTime(iso) {
  const d = iso ? new Date(iso) : new Date();
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** One status line for the whole page: freshness, or what failed and what to do. */
function setStatus(text, tone = "") {
  statusEl.textContent = text;
  statusEl.dataset.tone = tone;
}

/** A first-load state (empty or error) in place of the provider grid. */
function showGridState(text, tone = "") {
  providersEl.innerHTML = "";
  providersEl.removeAttribute("aria-busy");
  const p = document.createElement("p");
  p.className = tone ? `state state--${tone}` : "state";
  p.textContent = text;
  providersEl.appendChild(p);
}

function renderWindow(parent, winId, win, providerId) {
  const meta = WINDOW_META[winId];
  const node = windowTemplate.content.cloneNode(true);
  const article = node.querySelector(".window");
  article.dataset.status = win.status;
  article.dataset.window = winId;

  node.querySelector(".window-label").textContent = meta.label;
  node.querySelector(".window-reset").textContent =
    win.status === "ok" ? fmtReset(win.resetsAtIso) : win.reason || "";

  const meter = node.querySelector(".meter");
  const fill = node.querySelector(".meter-fill");
  const used = win.status === "ok" ? win.usedPercent : null;
  fill.style.width = used !== null ? `${Math.min(100, Math.max(0, used))}%` : "0%";
  fill.dataset.tone = toneFor(used, win.status);
  article.dataset.tone = fill.dataset.tone;
  meter.setAttribute("aria-label", `${meta.label} used`);
  if (used !== null) meter.setAttribute("aria-valuenow", String(Math.round(used)));

  // The share left is the number people act on, so it is the large one.
  const pctFmt = providerId === "cursor" ? fmtPctWhole : fmtPct;
  const hasLeft = win.remainingPercent !== null && win.remainingPercent !== undefined;
  node.querySelector(".window-left").textContent = hasLeft
    ? `${pctFmt(win.remainingPercent, "remaining")} left`
    : "No cap";
  node.querySelector(".stat-used").textContent = `${pctFmt(win.usedPercent)} used`;
  node.querySelector(".stat-tokens").textContent =
    win.usedTokens !== null && win.usedTokens !== undefined ? `${fmtTokens(win.usedTokens)} tokens` : "";

  parent.appendChild(node);
}

const isNum = (v) => v !== null && v !== undefined && !Number.isNaN(Number(v));

function fmtAmount(v, currency) {
  return currency === "USD" ? `$${Number(v).toFixed(2)}` : String(Math.round(Number(v)));
}

/**
 * The amount left is the large number, as in the widget ("$12.34 left").
 * "$7.66 of $20.00 used" goes under it. Without a remaining amount, the used line is the large one.
 */
function renderBalance(parent, balance) {
  const node = balanceTemplate.content.cloneNode(true);
  const cur = balance.currency;
  node.querySelector(".balance-label").textContent = balance.label || "Balance";
  const usedOfTotal =
    cur === "USD" && isNum(balance.used) && isNum(balance.total)
      ? `${fmtAmount(balance.used, cur)} of ${fmtAmount(balance.total, cur)} used`
      : "";
  const value = node.querySelector(".balance-remaining");
  const unit = node.querySelector(".balance-unit");
  const detail = node.querySelector(".balance-used");
  if (isNum(balance.remaining)) {
    value.textContent = fmtAmount(balance.remaining, cur);
    unit.textContent = cur === "credits" ? "credits left" : "left";
    detail.textContent = usedOfTotal;
  } else {
    value.textContent = usedOfTotal || "—";
    unit.textContent = "";
    detail.textContent = "";
  }
  node.querySelector(".balance-reset").textContent = balance.resetsAtIso ? fmtReset(balance.resetsAtIso) : "";
  parent.appendChild(node);
}

function renderCursorBilling(parent, billing, error, display) {
  const node = cursorBillTemplate.content.cloneNode(true);
  const card = node.querySelector(".cursor-bill");
  const show = display ?? uiSettings.display.cursor;

  node.querySelector(".bill-plan").textContent = billing.planLabel || "Included in plan";
  if (show.total) {
    node.querySelector(".bill-total-pct").textContent = fmtPctWhole(billing.totalPercentUsed);
    setBillMeter(node.querySelector(".bill-total"), billing.totalPercentUsed);
  } else {
    node.querySelector(".bill-total").hidden = true;
  }

  const auto = billing.autoPercentUsed;
  const api = billing.apiPercentUsed;
  const summary = node.querySelector(".bill-summary-text");
  const summaryParts = [];
  if (show.auto && auto !== null && auto !== undefined) summaryParts.push(`${fmtPctWhole(auto)} First-party models`);
  if (show.api && api !== null && api !== undefined) summaryParts.push(`${fmtPctWhole(api)} API`);
  // A hit limit blocks requests even when the included % looks low, so say it first.
  const limit = billing.limitHit ? `${billing.displayMessage || "You've hit your usage limit"}. ` : "";
  if (summaryParts.length) {
    summary.textContent = `${limit}${summaryParts.join(" and ")} used`;
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
      ? `${fmtPctWhole(billing.remainingPercent, "remaining")} remaining this cycle`
      : "";

  if (error) {
    const err = node.querySelector(".bill-error");
    err.textContent = error;
    err.hidden = false;
  }

  const toggle = node.querySelector(".bill-summary");
  const details = node.querySelector(".bill-details");
  function setExpanded(open) {
    cursorBillExpanded = open;
    details.hidden = !open;
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    card.dataset.expanded = open ? "true" : "false";
  }
  // Each poll draws a new card: keep the user's open/closed choice.
  if (show.auto || show.api) setExpanded(cursorBillExpanded);
  toggle.addEventListener("click", () => setExpanded(details.hidden));

  parent.appendChild(node);
}

function setBillMeter(root, usedPercent) {
  const fill = root.querySelector(".meter-fill");
  const pct = usedPercent === null || usedPercent === undefined ? null : Math.min(100, Math.max(0, usedPercent));
  fill.style.width = pct !== null ? `${pct}%` : "0%";
  fill.dataset.tone = billTone(pct);
}

function renderProvider(p) {
  const node = providerTemplate.content.cloneNode(true);
  node.querySelector(".provider-title").textContent = p.label;
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
    // Never an empty card: give the window's own reason, or say that Settings hid the meters.
    if (!p.error && windowsEl.childElementCount === 0) {
      // Only windows the settings allow; Claude's month window is always "unavailable" with a reason.
      const reason = windowIds.map((id) => p.windows?.[id]).find((w) => w && w.status !== "ok" && w.reason)?.reason;
      const d = uiSettings.display.claude;
      const hidBySettings = p.provider === "claude" && !(d.fiveHour && d.week && d.spend);
      const note = document.createElement("p");
      note.className = "provider-note";
      note.textContent =
        reason || (hidBySettings ? "No meters to show. Turn some on in Settings." : "No usage data yet.");
      windowsEl.appendChild(note);
    }
  }
  providersEl.appendChild(node);
}

function renderAll(data) {
  // Apply the settings first, so this render already uses a display change.
  if (data.ui) {
    uiSettings = mergeUi(data.ui);
    setRefreshInterval(uiSettings.refreshIntervalSec);
    // Fill the form only once here (when loadSettings failed); a poll must not
    // overwrite unsaved edits. loadSettings and saveSettings fill it otherwise.
    if (!settingsFormFilled) populateSettingsForm();
  }
  // A redraw replaces the Cursor toggle; keep keyboard focus on it.
  const hadToggleFocus = document.activeElement?.classList?.contains("bill-summary") === true;
  providersEl.innerHTML = "";
  providersEl.removeAttribute("aria-busy");
  const providers = data.providers || [];
  for (const p of providers) renderProvider(p);
  if (!providers.length) {
    showGridState("No providers are on. Run tuw setup in a terminal to turn on the agents on this computer.");
  }
  if (hadToggleFocus) providersEl.querySelector(".bill-summary")?.focus();
  fixtureBadge.hidden = !data.fixture;
}

/** Plain words for a failed request: what happened and what to do. */
function loadErrorText(err) {
  return String(err?.message || err);
}

/** fetch, but a network failure (not a code bug later on) says what to do. */
async function fetchServer(url, init) {
  try {
    return await fetch(url, init);
  } catch {
    throw new Error("The usage server does not answer. Start it with tuw start, or restart the widget.");
  }
}

async function loadUsage() {
  const res = await fetchServer("/api/usage", { cache: "no-store" });
  if (!res.ok) {
    // A bad config.json comes back as a 500 with its message; show that, not the code.
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || `The usage server answered HTTP ${res.status}.`);
  }
  const data = await res.json();
  renderAll(data);
  lastLoadedAt = data.fetchedAt || new Date().toISOString();
  setStatus(`Updated ${fmtTime(lastLoadedAt)}. Refreshes every ${formatRefreshHint(uiSettings.refreshIntervalSec)}.`);
}

/** Single-flight: a timer tick or a second click during a load joins that load. */
function refresh() {
  if (refreshInFlight) return refreshInFlight;
  // aria-busy, not disabled: disabling the focused button would drop keyboard focus.
  refreshButton.setAttribute("aria-busy", "true");
  refreshInFlight = loadUsage()
    .catch((err) => {
      const reason = loadErrorText(err);
      if (lastLoadedAt) {
        setStatus(`Could not refresh at ${fmtTime()}. ${reason} Showing data from ${fmtTime(lastLoadedAt)}.`, "error");
      } else {
        setStatus(""); // The grid shows the one message for this problem.
        showGridState(`${reason} Then select Refresh.`, "error");
      }
    })
    .finally(() => {
      refreshInFlight = null;
      refreshButton.removeAttribute("aria-busy");
    });
  return refreshInFlight;
}

let settingsFormFilled = false;

/**
 * A saved interval with no <option> (e.g. 3600 s from config.json) would show
 * blank and then save as 0. Add an option for it first.
 */
function setSelectSec(select, sec) {
  const value = String(sec);
  if (![...select.options].some((o) => o.value === value)) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = formatRefreshHint(sec);
    select.appendChild(opt);
  }
  select.value = value;
}

/** Seconds from a select, or undefined (JSON drops it) for a blank or non-positive value. */
function selectSec(select) {
  const n = Number(select.value);
  return n > 0 ? n : undefined;
}

function populateSettingsForm() {
  if (!settingsForm) return;
  settingsFormFilled = true;
  setSelectSec(settingsForm.refreshIntervalSec, uiSettings.refreshIntervalSec);
  setSelectSec(settingsForm.pollClaudeSec, uiSettings.pollIntervalSec.claude ?? 300);
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
  if (data.configPath) {
    // Local-only: the server omits this field on a non-loopback bind.
    document.querySelectorAll("[data-config-path]").forEach((el) => {
      el.textContent = data.configPath;
    });
  }
  populateSettingsForm();
  setRefreshInterval(uiSettings.refreshIntervalSec);
}

function readSettingsFromForm() {
  const claude = selectSec(settingsForm.pollClaudeSec);
  return {
    refreshIntervalSec: selectSec(settingsForm.refreshIntervalSec),
    pollIntervalSec: claude ? { claude } : undefined,
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

function setSettingsStatus(text, tone = "") {
  settingsStatus.textContent = text;
  settingsStatus.dataset.tone = tone;
}

let saving = false;
/** Set when the person edits the form while a save runs; those edits are not saved yet. */
let editedDuringSave = false;

async function saveSettings(ev) {
  ev.preventDefault();
  if (saving) return;
  saving = true;
  editedDuringSave = false;
  settingsSave.setAttribute("aria-busy", "true");
  setSettingsStatus("Saving…");
  try {
    const ui = readSettingsFromForm();
    const res = await fetchServer("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ui }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `The server answered HTTP ${res.status}.`);
    uiSettings = mergeUi(data.ui);
    // Do not write over edits made during the save.
    if (!editedDuringSave) populateSettingsForm();
    setRefreshInterval(uiSettings.refreshIntervalSec);
    setSettingsStatus(
      editedDuringSave ? "Settings saved. Your newer changes are not saved yet." : "Settings saved.",
      editedDuringSave ? "" : "ok",
    );
    // A load that started before the save carries the old settings; wait for it, then load again.
    if (refreshInFlight) await refreshInFlight;
    await refresh();
  } catch (err) {
    // The form keeps the edits, so a retry is one click.
    setSettingsStatus(`Could not save. ${loadErrorText(err)} Your changes are still here. Try again.`, "error");
  } finally {
    saving = false;
    settingsSave.removeAttribute("aria-busy");
  }
}

function showView(name) {
  const dashboard = name !== "settings";
  viewDashboard.hidden = !dashboard;
  viewSettings.hidden = dashboard;
  for (const link of navLinks) {
    if (link.dataset.view === name) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
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
  // Dashboard and Settings are tabs of one page: replace the history entry, so
  // Back leaves the page and does not walk every tab switch.
  for (const link of navLinks) {
    link.addEventListener("click", (ev) => {
      ev.preventDefault();
      if (location.hash !== link.hash) location.replace(link.hash);
      syncViewFromHash();
      (link.dataset.view === "settings" ? viewSettings : viewDashboard).focus();
    });
  }
  settingsForm?.addEventListener("submit", saveSettings);
  settingsForm?.addEventListener("input", () => {
    if (saving) editedDuringSave = true;
    else setSettingsStatus("Unsaved changes.");
  });
  refreshButton.addEventListener("click", () => refresh());
  refresh();
}

start();
