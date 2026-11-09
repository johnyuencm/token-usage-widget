# Review: PR #5 (UI/UX polish)

- Reviewer: fresh-context subagent (not the author).
- Base: `master` at `e4c773a`.

## Round 1: head `8c35a27`

Verdict: FAIL (2 medium bugs confirmed in the browser, no high findings).

Passed: scope (only `public/`, `tests/format-reset.test.cjs`, `artifacts/`; no `src/` or `desktop/` change), XSS (text goes through `textContent` or `escapeHtml`), tests (278: 275 pass, 0 fail, 3 skipped), typecheck, old-selector scan, history handling, balance logic, layout at 360 px, reduced motion, focus ring.

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | Medium | `.bill-details { display: flex }` beats `[hidden]`, so the Cursor details never collapse. | Global `[hidden] { display: none !important }`. |
| 2 | Medium | `disabled = true` on the focused Refresh and Save buttons drops keyboard focus. | Use `aria-busy`; the single-flight guards already block a second request. |
| 3 | Medium | The "Turn some on in Settings" note shows when windows are unavailable, and the reason is lost. | Show the window reason; Settings hint only for Claude. |
| 4 | Low | `await refresh()` after save can join a load with the old settings. | Wait for the running load, then load again. |
| 5 | Low | Any `TypeError` maps to "server does not answer". | Map only a failed `fetch`. |
| 6 | Low | First-load error leaves `aria-busy="true"`. | Remove it in `showGridState`. |
| 7 | Low | `.bill-details` fades in on every poll. | Remove the animation. |
| 8 | Low | Edits during a save are overwritten. | Keep them; say that they are not saved yet. |
| 9 | Low | No tests for single-flight or balance display. | Add two tests. |

The author fixed all 9 in `c105a08`. Round 2 found that the fix for finding 3 was incomplete. Browser checks after the fix: details `display: none` after a click and a poll; focus stays on `#refresh-now` and `#settings-save`; 2 Enter presses send 1 request; 2 submits send 1 PUT; an edit during a save is kept; an unavailable window shows its reason. `npm run verify`: exit 0, tests 280 (277 pass, 0 fail, 3 skipped), `E2E PASS`.

## Round 2: head `6a93cc1`

Verdict: FAIL. Findings 1, 2 and 4 to 9 are fixed correctly. Test numbers: 280 (277 pass, 0 fail, 3 skipped). The reviewer broke each new test's logic in a scratch copy, and each test failed.

| # | Severity | Finding | Fix |
|---|---|---|---|
| 10 | Medium | The empty-card reason came from any unavailable window, also windows that are not drawn. The Claude month window is always unavailable, so a Claude card with all meters off showed the month reason, not the Settings hint. | Take the reason only from windows the settings allow. Show the Settings hint when Settings hid Claude meters. Test added; it fails on the round-2 code. |

Passed in round 2: `aria-busy` guards (2 clicks give 1 load, 2 submits give 1 PUT, focus stays), `fetchServer`, `editedDuringSave`, save-then-load order, the `[hidden]` rule (no hidden element still shows).
