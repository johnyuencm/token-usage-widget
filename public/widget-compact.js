/**
 * Compact one-line summaries for the corner widget.
 * UMD: browser → TokenUsageCompact; Node → module.exports.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.TokenUsageCompact = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function pct(v) {
    if (v === null || v === undefined || Number.isNaN(Number(v))) return null;
    return `${Math.round(Number(v))}%`;
  }

  function fmtApi() {
    if (globalThis.TokenUsageFmt) return globalThis.TokenUsageFmt;
    // Node tests may load this module before fmt.js sets the global.
    if (typeof require === "function") {
      try {
        return require("./fmt.js");
      } catch {
        return null;
      }
    }
    return null;
  }

  function shortReset(iso, nowMs) {
    return fmtApi()?.formatResetShort?.(iso, nowMs) || "";
  }

  function whenReset(iso) {
    return fmtApi()?.formatResetWhen?.(iso) || "";
  }

  /** Null when the window has nothing useful to show (skip NA bits). */
  function winPart(label, win, mode = "used", nowMs) {
    if (!win || win.status !== "ok") return null;
    const raw = mode === "remaining" ? win.remainingPercent : win.usedPercent;
    if (raw === null || raw === undefined || Number.isNaN(Number(raw))) return null;
    const base = `${label} ${pct(raw)}`;
    const reset = shortReset(win.resetsAtIso, nowMs);
    return reset ? `${base} (${reset})` : base;
  }

  function money(n) {
    if (n === null || n === undefined || Number.isNaN(Number(n))) return null;
    return Number(n).toFixed(2);
  }

  function withCycleReset(line, iso, nowMs) {
    const reset = shortReset(iso, nowMs);
    return reset ? `${line} · ${reset}` : line;
  }

  function windowBits(labels, p, mode, nowMs) {
    const bits = [];
    for (const [label, id] of labels) {
      const part = winPart(label, p.windows?.[id], mode, nowMs);
      if (part) bits.push(part);
    }
    return bits;
  }

  /** USD spend line when used+total known; else remaining-left. */
  function usdSpendBit(balance) {
    if (!balance || balance.currency !== "USD") return null;
    const used = money(balance.used);
    const total = money(balance.total);
    if (used !== null && total !== null) {
      const usedPct =
        balance.total > 0 && balance.used !== null && balance.used !== undefined
          ? pct((Number(balance.used) / Number(balance.total)) * 100)
          : null;
      return usedPct ? `$${used}/$${total} (${usedPct})` : `$${used}/$${total}`;
    }
    const rem = money(balance.remaining);
    return rem !== null ? `$${rem} left` : null;
  }

  const DEFAULT_DISPLAY = {
    claude: { fiveHour: true, week: true, spend: true },
    cursor: { total: true, auto: true, api: true },
  };

  function resolveDisplay(opts) {
    const d = opts?.display ?? DEFAULT_DISPLAY;
    return {
      claude: { ...DEFAULT_DISPLAY.claude, ...(d.claude || {}) },
      cursor: { ...DEFAULT_DISPLAY.cursor, ...(d.cursor || {}) },
    };
  }

  /** Short label for compact widget when providerLine would otherwise show "error". */
  function compactErrorLabel(err) {
    if (!err) return "error";
    const rateMatch = err.match(/rate limited \(retry in ~(\d+)m\)/i);
    if (rateMatch) return `rate limited ~${rateMatch[1]}m`;
    if (/rate limit/i.test(err)) return "rate limited";
    if (/credentials|logged in|sign in|token expired|auth login/i.test(err)) return "not signed in";
    const httpMatch = err.match(/HTTP (\d{3})/i);
    if (httpMatch) return `HTTP ${httpMatch[1]}`;
    return "error";
  }

  /**
   * @param {{ provider: string, label?: string, windows?: any, billing?: any, balance?: any, error?: string }} p
   * @param {{ nowMs?: number }} [opts]
   */
  function providerLine(p, opts) {
    const nowMs = opts?.nowMs ?? Date.now();
    const display = resolveDisplay(opts);
    const name =
      p.provider === "openai"
        ? "codex"
        : p.provider === "opencode"
          ? "opencode"
          : p.provider === "cursor"
            ? "cursor"
            : String(p.provider || "provider").toLowerCase();

    if (p.error && p.provider !== "cursor") {
      // Prefer window/balance lines when present; only collapse when empty.
      if (!p.windows && !p.balance) return `${name}: ${compactErrorLabel(p.error)}`;
    }

    if (p.provider === "cursor") {
      const b = p.billing;
      const show = display.cursor;
      if (!b) {
        const m = p.windows?.month;
        const total = `${name}: total ${m?.status === "ok" ? pct(m.usedPercent) ?? "NA" : "NA"}`;
        return withCycleReset(total, m?.resetsAtIso, nowMs);
      }
      const parts = [];
      if (show.total && b.totalPercentUsed !== null && b.totalPercentUsed !== undefined) {
        parts.push(`total ${pct(b.totalPercentUsed) ?? "NA"}`);
      }
      if (show.auto && b.autoPercentUsed !== null && b.autoPercentUsed !== undefined) {
        parts.push(`first party ${pct(b.autoPercentUsed)}`);
      }
      if (show.api && b.apiPercentUsed !== null && b.apiPercentUsed !== undefined) {
        parts.push(`API ${pct(b.apiPercentUsed)}`);
      }
      if (!parts.length) return `${name}: NA`;
      return withCycleReset(`${name}: ${parts.join(" ")}`, b.resetsAtIso, nowMs);
    }

    if (p.provider === "openrouter") {
      const rem = money(p.balance?.remaining);
      const base = rem !== null ? `openrouter: $${rem} left` : "openrouter: NA";
      return withCycleReset(base, p.balance?.resetsAtIso, nowMs);
    }

    if (p.provider === "claude" || p.provider === "kimi" || p.provider === "zai") {
      const claudeLabels = [];
      if (p.provider === "claude") {
        if (display.claude.fiveHour) claudeLabels.push(["5h", "five_hour"]);
        if (display.claude.week) claudeLabels.push(["Week", "week"]);
      } else {
        claudeLabels.push(["5h", "five_hour"], ["Week", "week"], ["Month", "month"]);
      }
      const bits = windowBits(claudeLabels, p, "used", nowMs);
      if (p.provider === "claude" && display.claude.spend) {
        const spend = usdSpendBit(p.balance);
        if (spend) bits.push(spend);
      }
      if (!bits.length) {
        if (p.error) return `${name}: ${compactErrorLabel(p.error)}`;
        return `${name}: NA`;
      }
      return withCycleReset(`${name}: ${bits.join(", ")}`, p.balance?.resetsAtIso, nowMs);
    }

    if (p.provider === "grok") {
      const rem = p.balance?.remaining;
      if (rem !== null && rem !== undefined && !Number.isNaN(Number(rem))) {
        return withCycleReset(`grok: ${Math.round(Number(rem))} credits left`, p.balance?.resetsAtIso, nowMs);
      }
      const mPart = winPart("month", p.windows?.month, "used", nowMs);
      if (mPart) return `grok: ${mPart}`;
      return "grok: NA";
    }

    // Codex Analytics shows "% remaining" — match that number for openai.
    // OpenCode Go meters are usage/% used.
    const mode = p.provider === "openai" ? "remaining" : "used";
    const labels =
      p.provider === "opencode"
        ? [
            ["rolling", "five_hour"],
            ["week", "week"],
            ["month", "month"],
          ]
        : [
            ["5h", "five_hour"],
            ["Week", "week"],
            ["Month", "month"],
          ];

    const bits = windowBits(labels, p, mode, nowMs);
    if (!bits.length) {
      if (p.error) return `${name}: ${compactErrorLabel(p.error)}`;
      return `${name}: NA`;
    }
    return `${name}: ${bits.join(", ")}`;
  }

  /** @param {{ windows?: any, billing?: any, balance?: any, error?: string }} p */
  function providerTitle(p) {
    if (p.error) return p.error;
    const labels = [
      ["cycle", p.billing?.resetsAtIso],
      ["balance", p.balance?.resetsAtIso],
      ["5h", p.windows?.five_hour?.resetsAtIso],
      ["week", p.windows?.week?.resetsAtIso],
      ["month", p.windows?.month?.resetsAtIso],
    ];
    const resets = [];
    for (const [label, iso] of labels) {
      const when = whenReset(iso);
      if (when) resets.push(`${label} ${when}`);
    }
    return resets.join(" · ");
  }

  return { providerLine, providerTitle, pct, winPart, DEFAULT_DISPLAY, resolveDisplay };
});
