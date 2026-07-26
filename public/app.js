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

const REFRESH_MS = 60_000;

const providersEl = document.getElementById("providers");
const footerStatus = document.getElementById("footer-status");
const refreshClock = document.getElementById("refresh-clock");
const fixtureBadge = document.getElementById("fixture-badge");
const providerTemplate = document.getElementById("provider-template");
const windowTemplate = document.getElementById("window-template");
const cursorBillTemplate = document.getElementById("cursor-bill-template");
const balanceTemplate = document.getElementById("balance-template");

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

function setBillMeter(root, usedPercent) {
  const fill = root.querySelector(".bill-meter-fill");
  const pct = usedPercent === null || usedPercent === undefined ? null : Math.min(100, Math.max(0, usedPercent));
  fill.style.width = pct !== null ? `${pct}%` : "0%";
  fill.dataset.tone = billTone(pct);
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

  // OpenCode Go dashboard shows whole-number % like Cursor bill.
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
    if (
      used !== null &&
      used !== undefined &&
      total !== null &&
      total !== undefined
    ) {
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

function renderCursorBilling(parent, billing, error) {
  const node = cursorBillTemplate.content.cloneNode(true);
  const card = node.querySelector(".cursor-bill");

  node.querySelector(".bill-plan").textContent = billing.planLabel || "Included in plan";
  node.querySelector(".bill-total-pct").textContent = fmtPctWhole(billing.totalPercentUsed);
  setBillMeter(node.querySelector(".bill-total"), billing.totalPercentUsed);

  const auto = billing.autoPercentUsed;
  const api = billing.apiPercentUsed;
  const summary = node.querySelector(".bill-summary-text");
  if (auto !== null && api !== null) {
    summary.textContent = `${fmtPctWhole(auto)} First-party models and ${fmtPctWhole(api)} API used`;
  } else if (billing.displayMessage) {
    summary.textContent = billing.displayMessage;
  } else {
    summary.textContent = "Usage breakdown unavailable";
  }

  const resetEl = node.querySelector(".bill-reset");
  resetEl.textContent = billing.resetsAtIso ? fmtReset(billing.resetsAtIso) : "";

  node.querySelector(".bill-auto-pct").textContent = fmtPctWhole(auto);
  setBillMeter(node.querySelector(".bill-auto"), auto);
  node.querySelector(".bill-auto-note").textContent =
    billing.autoNote || "Additional usage beyond limits consumes API quota or on-demand spend.";

  node.querySelector(".bill-api-pct").textContent = fmtPctWhole(api);
  setBillMeter(node.querySelector(".bill-api"), api);
  node.querySelector(".bill-api-note").textContent =
    billing.apiNote || "Additional usage beyond limits consumes on-demand spend.";

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

function renderProvider(p) {
  const node = providerTemplate.content.cloneNode(true);
  node.querySelector(".provider-title").textContent = p.label;
  const sub = p.error ? "error" : "live";
  node.querySelector(".provider-sub").textContent = sub;
  const errEl = node.querySelector(".provider-error");
  const windowsEl = node.querySelector(".windows");

  if (p.provider === "cursor" && p.billing) {
    windowsEl.classList.add("windows--billing");
    renderCursorBilling(windowsEl, p.billing, p.error);
    if (p.error) errEl.hidden = true;
  } else {
    if (p.error) {
      errEl.textContent = p.error;
      errEl.hidden = false;
    }
    if (p.balance) {
      windowsEl.classList.add("windows--balance");
      renderBalance(windowsEl, p.balance);
    }
    // Skip empty window meters when provider is balance-only (e.g. OpenRouter).
    const showWindows =
      !p.balance ||
      Object.values(p.windows || {}).some((w) => w && w.status === "ok");
    if (showWindows) {
      for (const winId of ["five_hour", "week", "month"]) {
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

function start() {
  refresh();
  setInterval(refresh, REFRESH_MS);
  setInterval(updateClock, 1000);
}

start();
