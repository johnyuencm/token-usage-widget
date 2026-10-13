/**
 * Shared reset-time formatting for dashboard + widget.
 * UMD: browser → globalThis.TokenUsageFmt; Node → module.exports.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.TokenUsageFmt = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  /**
   * @param {string | null | undefined} iso
   * @param {number} [nowMs]
   * @returns {string}
   */
  function formatReset(iso, nowMs = Date.now()) {
    if (!iso) return "";
    const then = new Date(iso);
    const t = then.getTime();
    if (Number.isNaN(t)) return "";
    const diff = t - nowMs;
    if (diff <= 0) return "Resets now";

    // Round once to whole minutes, then split, so 59.6 min reads "1 hour".
    const totalMin = Math.round(diff / 60000);
    const days = Math.floor(totalMin / (60 * 24));
    const hours = Math.floor((totalMin % (60 * 24)) / 60);
    const mins = totalMin % 60;
    const parts = [];
    if (days > 0) parts.push(`${days} day${days === 1 ? "" : "s"}`);
    if (hours > 0) parts.push(`${hours} hour${hours === 1 ? "" : "s"}`);
    if (days === 0 && mins > 0) parts.push(`${mins} minute${mins === 1 ? "" : "s"}`);
    const text = diff < 60000 ? "<1 minute" : parts.join(" ");

    const when = formatResetWhen(iso);
    return when ? `Resets in ${text} · ${when}` : `Resets in ${text}`;
  }

  /**
   * Compact countdown for the corner widget (e.g. "3d 5h", "2h 15m", "now").
   * @param {string | null | undefined} iso
   * @param {number} [nowMs]
   * @returns {string}
   */
  function formatResetShort(iso, nowMs = Date.now()) {
    if (!iso) return "";
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) return "";
    const diff = t - nowMs;
    if (diff <= 0) return "now";

    const totalMin = Math.max(0, Math.round(diff / 60000));
    const days = Math.floor(totalMin / (60 * 24));
    const hours = Math.floor((totalMin % (60 * 24)) / 60);
    const mins = totalMin % 60;
    if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
    if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
    return `${mins}m`;
  }

  /**
   * Locale absolute reset time for tooltips (e.g. "Jul 23, 2:00 PM").
   * @param {string | null | undefined} iso
   * @returns {string}
   */
  function formatResetWhen(iso) {
    if (!iso) return "";
    const then = new Date(iso);
    if (Number.isNaN(then.getTime())) return "";
    return then.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }

  return { formatReset, formatResetShort, formatResetWhen };
});
