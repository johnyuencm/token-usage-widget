# 2026-10-16 logic hunt: feedback loops and broken logic

Status: in progress. Desktop, adapter and backend parts done. The CLI and UI part runs in an agent and is added here when it finishes.

The D0 fix is in the working tree, not committed yet (desktop/main.cjs, desktop/widget-dock.cjs, tests/server-launch.test.cjs). The owner decides on the commit.


Probe: a scratch probe (not in the repo) runs the real `runWidgetMain` with a scratch userData dir and a fake cursor.

## D0 (fixed in working tree) Widget grows 1.25x at each start on a 125% monitor
- desktop/main.cjs createWindow: `new BrowserWindow({x,y,width,height})` returns 280x178 for 221x141. App saved getBounds() as truth.
- Evidence: 3 real starts saved 221 -> 280 -> 352 -> 440. After fix: 4 starts keep 221x141.

## D1 CONFIRMED Fit to content never changes the height
- public/widget.js fitToContent: `Math.max(root.scrollHeight, rect.height)`. The root scrollHeight is never smaller than the viewport.
- desktop/main.cjs fitWindowToContent: `Math.min(b.height, ceil(h))` refuses to grow.
- Evidence: seed 320x400, userSized false. Renderer: inner 400, scrollH 400, rectH 123. Window stays 401 px.
- Result: a widget that is too tall keeps empty space. A widget that is too short clips rows (html overflow hidden, no scroll without user-sized).
- Fix idea: measure `document.body.getBoundingClientRect().height`; let main grow and shrink within MIN/MAX and the work area.

## D2 CONFIRMED A parked widget slides onto the next monitor, or over the taskbar
- desktop/widget-bounds.cjs nearestDockEdge/dockedBounds use only the current work area. They ignore a neighbor display and the taskbar.
- Evidence: default corner (primary bottom-right) parks to y=1000..1141. Screenshot (taken 2026-10-16, not in the repo): the whole widget stays visible, covers the tray icons and clock, and shows on the monitor below.
- Primary right edge parks to x=1888..2110, which is on the 125% monitor to the right.
- Fix idea: skip an edge when the parked rectangle meets another display or leaves the work area into the taskbar; if no edge is free, do not park.

## D3 CONFIRMED A monitor that goes away moves the saved home for good
- desktop/main.cjs reanchorWindow clamps `dock.getRest()` into the remaining display and stores it as the new rest. Quit saves it.
- Evidence: rest on the 125% monitor (3235,882). Simulated display-removed then display-added. Saved file after quit: x=1699 (primary). The widget does not go back.
- This machine uses Modern Standby, so monitors drop at sleep.
- Fix idea: keep the user home separate from the clamped placement; on display-added, restore the home when its display is back.

## Adapters and widget line (agent hunt)

Spot-checked by commander: A2 (claude.ts:292,302 read back) and A9 (fmt.js:53 read back). Both hold.

Codex "Month 0%" answer: the value is correct, but its label misleads. Raw Codex data: `usedPercent: 100`, `rateLimitReachedType: "rate_limit_reached"`, window 43200 min, limits `planType: "free"` while the account `planType` is `"plus"`. The dashboard shows 100% used. The 25d 23h reset is correct.

| id | file:line | defect | verdict |
|----|-----------|--------|---------|
| A1 | public/widget-compact.js:184,41 | Codex "N%" means left; every other provider "N%" means used. No word shows which. Live: `codex: Month 0%` = quota empty. | CONFIRMED (live) |
| A2 | src/adapters/claude.ts:90-94,292,302 | On 429, 5xx or network error, the adapter returns old `cachedOk` with no age limit and no `error`. Repro: 6 h later shows `claude: 5h 95% (now)`, error undefined. | CONFIRMED |
| A3 | public/widget-compact.js:122,143,149,180 | Error guard `!p.windows && !p.balance` is never true (adapters always return windows). cursor, openrouter, grok show `NA` instead of `HTTP 401` / `not signed in`. | CONFIRMED |
| A4 | src/adapters/cursor.ts:109-150, public/app.js:204-207 | Live Cursor says "You've hit your usage limit" (spend 54570 of limit 7000 cents, `remainingBonus: false`). Widget shows `total 42%`; the message shows nowhere. | PLAUSIBLE |
| A5 | src/adapters/kimi.ts:140,178-187 | The kimi-cli payload shape (`usage`/`limits`) maps to no window: `kimi: NA`, no error. Shape from memory; no live key. | PLAUSIBLE |
| A6 | src/adapters/zai.ts:96 | Every `TOKENS_LIMIT` entry maps to `five_hour`; a weekly entry overwrites the 5h value. Live shape not verified. | PLAUSIBLE |
| A7 | public/widget-compact.js:12, src/adapters/cursor.ts:49-51,141 | `Math.round` turns 99.6% used into "100%" and "0% left". | CONFIRMED |
| A8 | src/adapters/grok.ts:59, src/adapters/openrouter.ts:42 | `Number(null)` is 0: null becomes `0 credits left` / `$0.00 left`. | PLAUSIBLE |
| A9 | public/fmt.js:53,59 | Short reset text shows `0m` when less than 30 s are left. | CONFIRMED |
| A10 | src/adapters/claude.ts:192-194 | When `seven_day` is null, the first Opus/Sonnet sub-limit is labelled "Week" (repro: Week 0% while Sonnet is 88%). | PLAUSIBLE |

Fix ideas: A1 add "left" or show used for all. A2 drop windows whose reset passed, mark stale, cap cache age. A3 `p.error ? compactErrorLabel(p.error) : "NA"`. A4 show "limit hit" when `totalSpend >= limit && !remainingBonus`. A7 floor used, ceil remaining. A8 `num(v)` helper returning null for null/undefined/"". A9 `if (diff < 60000) return "<1m"`. A10 map only `seven_day` to Week.

Repro files are in a scratch folder, not in the repo.

## Backend: server, cache, config, settings (agent hunt)

Spot-checked by commander: B1 (server.ts:49), B2 (poll-cache.ts:18) and B5 (settings-api.ts:37) read back. All hold.

| id | file:line | defect | verdict |
|----|-----------|--------|---------|
| B1 | src/server.ts:49 | Top-level `fetchedAt` is always "now", and the UI reads only that field. Cached data shows as fresh (live: response now, Claude data 110 s old). Fix S8 does not reach the UI. | CONFIRMED (live) |
| B2 | src/providers/poll-cache.ts:18 | Cache TTL equals the widget refresh period. A tick 1 ms early gets data one period old (sim: 12 ticks, 5 stale). | CONFIRMED |
| B3 | src/ui-settings.ts:90,136; public/app.js:351,378 | An interval that the `<select>` does not list shows blank; the form sends 0 and the server saves 30 s (Claude 3600 s becomes 30 s, then 429). | CONFIRMED |
| B4 | src/config.ts:210 | `loadConfig` swallows a JSON parse error. The widget shows "No providers" with no error; PUT /api/settings gives 400. | CONFIRMED |
| B5 | src/settings-api.ts:37; poll-cache.ts:9-12,33 | Each settings save clears the cache and calls every provider again (bypasses the Claude 300 s guard). Clearing `inflight` mid-fetch lets the old `finally` delete the newer in-flight entry. | CONFIRMED |
| B6 | src/config.ts:34-43 | The "one-time" migration runs on every request. A deleted user config comes back from the checkout `./config.json`, with the old opencode cookie (fix S7 incomplete). | CONFIRMED |
| B7 | src/ui-settings.ts:141-146 | A partial display patch resets the sibling display flags to defaults. | CONFIRMED (low) |
| B8 | src/providers/poll-cache.ts:29 | One upstream error replaces the last good entry for the full poll interval. | CONFIRMED |
| B9 | src/server.ts:45; src/fixtures.ts:167 | Fixture response has no `ui`, so the widget ignores settings in fixture mode. | CONFIRMED (low) |
| B10 | src/config.ts:180,205 | `PORT=abc` also disables the config port; `PORT=" "` gives a random port. | CONFIRMED (low) |
| B11 | src/login-launch.ts:194,215-227 | macOS: a repeated install skips bootout but runs bootstrap, which fails; a repeated `tuw setup` fails. | PLAUSIBLE |
| B12 | src/config.ts:206; desktop/main.cjs:42-43 | Server binds config `server.host`; desktop checks 127.0.0.1. With a LAN IP the widget never connects. | PLAUSIBLE |

Fix ideas: B1 send the oldest provider `fetchedAt`, or show age per provider. B2 TTL margin (`< minMs - 5_000`). B3 ignore non-positive values and keep the current one; add the current value as an option. B4 surface `configError`. B5 delete the `resetPollCache()` call. B6 migrate only when the user-data folder is new, and write through `parseConfigText` + `writeConfigFile`. B8 keep the last good entry when the new result has an error, or give errors a short TTL.
