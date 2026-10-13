# OpenCode Go cookie scrape removed (2026-10-13)

## Why
Bitdefender Advanced Threat Defense flagged the widget as a stealer (`Atc4.Detection`) on 2026-10-13.
It rolled back 907 items on the machine, including `dist/`, `electron.exe` and the Startup shortcut.
The trigger pattern was the widget's credential reads, mainly the copy of Firefox `cookies.sqlite`.

## Decision
- The widget reads no browser cookies and does not scrape the opencode.ai dashboard.
- OpenCode Go uses only the official usage API (`GET /zen/go/v1/usage`) with the `opencode auth` key.
- That API is not live yet, so OpenCode Go shows `unavailable`.
- `OPENCODE_ALLOW_LOCAL_ESTIMATE=1` stays as the opt-in local token count.

## Removed
Firefox discovery, `resolveAuthCookie`, `resolveWorkspaceId`, `scrapeGoDashboard`, dashboard HTML parsers,
config `opencode.go`, `OPENCODE_GO_AUTH_COOKIE`, the setup cookie prompt,
`scripts/save-opencode-cookie.ts`, `scripts/check-opencode-go.ts`.
Old configs with `opencode.go` load without error; the key is ignored.

## Verification
- `npm run typecheck`: exit 0.
- `npm test`: 207 pass, 0 fail, 5 skip (POSIX-only).
- New check: `tests/providers.test.ts` "OpenCode never reads Firefox cookies or scrapes the Go dashboard".

## Open
- Not committed yet (waits for the user).
- Rebuild `dist/` and reinstall Electron before the widget runs again.
- Add a Bitdefender exception for the repo folder. Claude and Cursor adapters still read local tokens and can trigger the detection again.
- Historical docs (`docs/macos-widget/*`, `docs/reviews/2026-09-30-*`) still describe Firefox discovery; they are records and stay unchanged.

## Follow-up: OpenCode provider removed (2026-10-13)
The user asked to remove OpenCode support completely.
- Removed provider id `opencode` from `ProviderId`, `ALL_PROVIDER_IDS`, defaults, registry, fetchers, fixtures, setup detection, the config `opencode` block and `OPENCODE_DB_PATH`.
- Deleted `src/adapters/opencode.ts` (API call, local DB estimate, `OPENCODE_ALLOW_LOCAL_ESTIMATE`).
- Removed OpenCode-only UI code in `public/app.js` and `public/widget-compact.js`, and the README rows.
- Old configs with `providers.opencode` or an `opencode` block load without error; `mergeProviders` reads only known ids.
- Fixture count is now 7 providers.
- Verification: `npm run typecheck` exit 0; `npm test` 197 pass, 0 fail, 5 skip.
- `artifacts/e2e-evidence.md` is an old evidence record and still lists OpenCode; regenerate it with the next e2e run.
- Not committed yet.

## Bitdefender trigger (from its RCA record, 2026-10-13)
- The alert fired on `powershell.exe -NoProfile -File scripts\start-widget.ps1 -InstallStartup` (ATC.Malicious, event score 80). It ran from a Cursor agent shell (`powershell -ExecutionPolicy Bypass -NonInteractive -File %TEMP%\...`), right after `git push`, `gh release create v1.2.6` and `npm publish`.
- Pattern seen by ATC: hidden bypass PowerShell, a Startup shortcut for an unsigned `electron.exe`, and credential/cookie reads.
- Bitdefender set `explorer.exe` as the attack entry. Its cleanup removed widget files, the Startup shortcut, Office DLLs and WPS keys, and broke the HKCU Search key ACL (taskbar crash).
- Open idea (not done): make `-InstallStartup` less malware-like (no hidden PowerShell at logon). Needs a user decision.

## Follow-up: no script window at logon (2026-10-13)
- `desktop/main.cjs` owns both shortcuts (Start Menu, Startup) through `shell.writeShortcutLink`. Target = `electron.exe` with the checkout as argument. No cmd or PowerShell window at logon.
- New flag `electron.exe <checkout> --install-startup`: writes the Startup shortcut, prints the path, exits 0/1, opens no window.
- `tuw startup install` (win32) now runs that flag, then launches via `scripts/start-widget.cjs`. The `powershell -ExecutionPolicy Bypass -File start-widget.ps1 -InstallStartup` path is gone.
- `scripts/start-widget.ps1` no longer writes shortcuts and has no `-InstallStartup` switch.
- On every launch the widget rewrites an older Startup shortcut that still targets `start-widget.cmd`.
- Verification: typecheck 0; `npm test` 198 pass, 0 fail, 5 skip. New checks in `tests/server-launch.test.cjs` and `tests/login-launch.test.ts`.
- Not verified live: `electron.exe` is still missing (Bitdefender quarantine). Run `npm ci` and `tuw startup install` after the Bitdefender exception.

## Live check (2026-10-13 12:05, after Bitdefender exception)
- Restored `electron.exe` with `node node_modules/electron/install.js` (Electron 35.2.1) and rebuilt `dist/`.
- `node bin/tuw.cjs startup install`: Startup and Start Menu shortcuts both target `node_modules\electron\dist\electron.exe` with args `"<checkout>"`. Widget runs; no cmd or PowerShell process involved.
- Bitdefender: no new quarantine records (907 before and after), no new `ctc\rca` incident.
- Note: piping `tuw startup install` output into another command blocks, because the launched widget keeps the inherited stdout open. Run it without a pipe.
- Separate, older issue (not changed): the widget started a second `server.js` at 12:01:02 on fallback port 61567 while the first one (port 4321, same parent) still ran. `token-usage-dashboard-server.log` is overwritten on each start, so the cause is not visible. Worth a follow-up ticket.

## Orphan usage server: root cause and fix (2026-10-13)
- Symptom: two `dist/server.js` processes, both children of one widget (ports 4321 and 61567, second started 12:01:02).
- Cause 1 (leak): `reviveIfNeeded` runs every 15 s. One missed `/api/health` (2 s timeout) calls `ensureServer`; port 4321 is still taken, so `ensureUsageServer` spawns a new server on a free port. `bindOwnedServer` replaced `serverProc` without stopping the old child, and quit stops only the current one.
- Cause 2 (missed health check): the Cursor adapter copied `state.vscdb` (988 MB here) with synchronous `copyFileSync` on every Cursor poll. This blocks the server's event loop (562 ms warm cache; seconds while AV scans the new 1 GB temp file). It also looks like credential theft: at 09:28:21-22 the widget wrote two 1 GB copies to `%TEMP%`, 20 s before Bitdefender's rollback. Bitdefender killed the process before cleanup, so the copies stayed (deleted 12:2x).
- Fix 1: `desktop/main.cjs` `bindOwnedServer` stops the previous owned child before it takes a new one.
- Fix 2: `src/adapters/cursor.ts` reads `state.vscdb` in place (read-only, 6.7 ms); the private copy is only a fallback when the direct read fails.
- Test: `tests/server-launch.test.cjs` "a revive that starts a new server stops the old owned one (no orphan server)". It fails without the guard ("old owned server is stopped"). Harness gained `health` and function-valued `serverResult` options.
- Verification: typecheck 0; `npm test` 199 pass, 0 fail, 5 skip. Live: one server on 4321, `/api/usage` 200, no new `tuw-cursor-*` temp files.
- Not verified: direct read while Cursor is running (Cursor was closed). The copy fallback covers a lock.
