# 2026-10-16 logic hunt: feedback loops and broken logic

Status: in progress. Desktop part done. Backend, adapters, CLI and UI parts run in separate agents and are added here when they finish.

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
