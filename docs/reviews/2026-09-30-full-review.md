# Full review — token-usage-widget — 2026-09-30

## Summary
Healthy localhost-only widget with disciplined credential handling — tokens go only to their own provider APIs, nothing secret is logged/cached/exfiltrated.
Top 5: (1) P2: config.json secrets plaintext + default mode, add 0600; (2) P2: LAN bind exposes unauthenticated /api/usage, guard non-loopback (not on by default); (3) P2: CI `verify` is red on master for both macOS jobs (Start Menu path test) — no PR landed with green CI; (4) P3: Win32 Start Menu path test fails on non-Windows separators (test-only; Windows runtime is correct); (5) no auto-update/signing pipeline (safe default, document manual updates).

## Scope and method
- Repo: johnyuencm/token-usage-widget, worktree /home/user/review-wt/token-usage-widget @ 9856f6bfb19758e8c6fb121d144615dd5a43f944 (2026-09-12), base master.
- Commits: last 15 (2026-08-06..2026-09-12; only 9 in last 30 days so per spec reviewed last 15): 9856f6b, 7ae235d, 87d8c18, 0a583b1, 29ee1db, 3ed493b, eca59a3, a9b8e78, 484787e, 86d4ba7, b9d1045, 871aebd, bee6e6e, d664db9, 20bfe65.
- PRs: 1 total (PR #1, MERGED 2026-07-21, macOS widget parity). Issues: 0 open, 0 closed. In-repo ticket/backlog files: docs/macos-widget/*.md (prd, design, plan, user-story, evidence-index).
- Checks: `npm test` (exit 1; 189 pass, 1 fail — pre-existing Win32 path test, see Tickets/Code; corrected in verification, the earlier "exit 0" was a transcription error), `npm run typecheck` (exit 0). Deps installed via `npm ci` into worktree (git-ignored). Widget NOT run against real credentials. No Windows `.exe` build run (no installer/signing pipeline exists in repo).

## Recent commits
All 15 reviewed via `git show`; no secrets, generated files, or reverts committed. Notable:
- 9856f6b (release v1.2.4, 2 files, version bump only) — clean.
- 7ae235d (e2e fixture isolation, scripts/e2e-evidence.mjs) — small, correct direction: product path no longer inherits USAGE_FIXTURE (desktop/main.cjs:64).
- 87d8c18 (Windows bounds persistence, +236/-30) — largest recent diff; adds desktop/widget-bounds.cjs tests. Risk: Electron-only code has no CI run on Windows for this path (verify.yml runs windows-latest, so covered — see Tickets).
- 0a583b1 (widget line wrap) — UI-only, tested.
- 29ee1db (poll-cache inflight coalescing, src/providers/poll-cache.ts) — 1-file fix at the shared choke point; commit message correctly notes it stops duplicate codex app-server spawns that rotate the ChatGPT refresh token. Good root-cause placement.
- 3ed493b (Codex expiry message, src/adapters/openai.ts:126-150) — maps 401/refresh_token_reused to "run codex login" instead of crash text. Correct.
- eca59a3 (Claude 429 backoff, src/adapters/claude.ts:48-73) — exponential 1m→60m honoring Retry-After; skips Anthropic calls while backed off. Correct.
- a9b8e78 (detect-local agents) — setup --defaults probes CLI/credential presence instead of hardcoding; low risk.
- 484787e (Cursor sqlite via node:sqlite, src/sqlite-scalar.ts) — replaces sqlite3-CLI shell-out with in-process read of a tmp copy; tmp files removed in finally (src/adapters/cursor.ts:177-188). Correct.
- 86d4ba7..20bfe65 (v1.2.3–v1.2.1 range) — settings tab, port fallback, Claude auto-refresh; no anomalies in messages vs diffs. All commits co-authored by Cursor agent with human sign-off; no bypass evidence.

## Pull requests
- PR #1 "macOS widget parity (source-checkout, waived real-Mac evidence)" — MERGED 2026-07-21, +4368/-337, author TheNewBee, reviewDecision empty, Bugbot disabled (no automated review). Single-PR history means all 15 reviewed commits landed via direct push, not PR review. No open PRs.
- Quality note: PR #1's own title waives real-Mac evidence; docs/macos-widget/evidence-index.md is source-checkout review only. Acceptable for a side project but means darwin launch paths (src/login-launch.ts, desktop darwin policy) are untested on real hardware — marked UNVERIFIED where relevant.

## Tickets
- GitHub issues: 0 open, 0 closed (verified via `gh.exe issue list --state all`). Nothing to cross-check.
- In-repo backlog: docs/macos-widget/{prd,design,implementation-plan,user-story,evidence-index}.md. Plan items (tray widget, LaunchAgent install, fixture evidence) are implemented in desktop/ and scripts/e2e-evidence.mjs; no stale/duplicate tickets found.
- De-facto open defect found during this review: `npm test` has 1 failing test at 9856f6b — tests/server-launch.test.cjs:881 "Win32 main preserves tray..." expects `/Start Menu\\Programs\\/` but the code builds `C:\Users\test\AppData\Roaming/Microsoft/Windows/Start Menu/Programs/Token Usage Widget.lnk` (mixed separators). On Windows `path.join` emits all-`\`, so the runtime shortcut is correct and this test passes there; it fails only on POSIX runners. (corrected in verification: originally filed as a Windows-only runtime path bug at P1; it is a test-portability bug and is not Windows-only.)

## Code review
Credential handling (focus area) — traced end to end at 9856f6b:
- Sources: Cursor token from state.vscdb key cursorAuth/accessToken (src/adapters/cursor.ts:190-203); Claude OAuth from ~/.claude/.credentials.json claudeAiOauth.accessToken + refresh (src/adapters/claude.ts:104-135); OpenCode Go auth cookie from Firefox cookies.sqlite host %opencode.ai% name auth (src/adapters/opencode.ts:290-332) or config/env; Grok ~/.grok/auth.json (src/adapters/grok.ts:8-19); Kimi ~/.kimi/credentials/kimi-code.json (src/adapters/kimi.ts:8-19); OpenRouter/Kimi/ZAI/Grok keys via config or env (src/cli/provider-config.ts:33-113). No keychain/Credential-Manager use anywhere — file reads are the design; acceptable for local dashboard but noted in Design.
- Sinks: every token goes only to its own provider API over HTTPS — Cursor api2.cursor.sh (cursor.ts:217-231), Anthropic api.anthropic.com + platform.claude.com refresh (claude.ts:170,344), opencode.ai dashboard/API (opencode.ts:379-429), grok cli-chat-proxy (grok.ts:38), kimi api.kimi.com, zai api.z.ai, openrouter.ai. No third-party hosts, no analytics. `grep fetch src/adapters` confirms provider-owned URLs only (8 hosts, 7 provider orgs; see Verification).
- Logging: no token, cookie, or Authorization header is logged. Grep of console.* in src/ shows only status messages (server.ts:162-181, startup.ts, providers.ts). Error paths return reason strings without secret values (e.g. claude.ts:333-341, openai.ts:130-150); Codex error formatter truncates RPC text to 180 chars (openai.ts:138) and only matches expiry patterns. PASS.
- Caching: poll-cache (src/providers/poll-cache.ts:6-37) caches ProviderUsage objects in memory only — usage percentages, never tokens. Claude module caches last-good usage (claude.ts:38) for 429 fallback, in-memory only. No token written to disk by the widget except: (a) user-pasted secrets into config.json via setup (provider-config.ts:157-163), (b) refreshed Claude access+refresh tokens written back to the user's own ~/.claude/.credentials.json via tmp+rename (claude.ts:146-161). Both are the credential's home location / explicit user config, not a new cache. PASS with one P2: config.json is written with default umask (no 0600) — see actions.
- Temp copies: Cursor state.vscdb and Firefox cookies.sqlite are copied to os.tmpdir() with randomUUID names and removed in finally (cursor.ts:177-188, opencode.ts:308-329). Window: token-bearing tmp file exists during read with default perms; acceptable locally, noted as P3 hardening.
- Findings:
  - P3 (was P1; corrected in verification): Win32 Start Menu path test asserts a Windows separator on POSIX runners (tests/server-launch.test.cjs:881). Evidence: local `npm test` exit 1, actual `C:\Users\test\AppData\Roaming/Microsoft/Windows/Start Menu/Programs/Token Usage Widget.lnk`; the same test is `ok 93` on the windows-latest CI job (run 34736926536), so the runtime shortcut (desktop/main.cjs:291-298, plain `path.join`) is correct on the only platform it runs on. Test-only; no user impact.
  - P2: config.json secrets stored plaintext with default file mode — src/cli/provider-config.ts:157-163 writeFileSync with no mode; src/config.ts has no chmod. Any local process/user can read OPENROUTER_API_KEY etc. pasted via setup. (Plaintext config is arguably by-design for a localhost tool; severity P2 not P0 because host is assumed trusted, but 0600 is one line.)
  - P2: /api/usage and /api/settings served to anyone who can reach the bind socket; host defaults to 127.0.0.1 (src/config.ts:118, config.example.json:41) and is NOT LAN-exposed by default — it is opt-in via config `server.host` only (src/config.ts:209; there is no env override), with no auth token on the API (src/server.ts:138-160). If a user opts into 0.0.0.0, /api/usage returns per-provider quota percentages/balances and /api/settings returns the local `configPath`; no tokens or account identifiers are exposed. Severity kept at P2 because the LAN bind is user-opted-in and the payload is quota metadata, not credentials. Document-or-guard. (severity reviewed in verification: the task flagged this as possibly higher; kept P2 — not a default-exposure and no secret in the payload.)
  - P3: tmp credential copies use default umask in shared /tmp (cursor.ts:178, opencode.ts:308). Pass mode 0o600 to copyFileSync/write or use mkdtemp private dir.
  - P3: error objects from fetch (network errors, non-2xx bodies) are surfaced verbatim into widget/API error strings (e.g. claude.ts:427-436, grok.ts:86-97); provider error bodies could theoretically echo request fragments. No evidence of token echo today; truncate/sanitize as hygiene. UNVERIFIED whether any provider echoes.

## Design review
- API: GET /api/usage returns percentages + error strings, never tokens (src/server.ts:32-52); GET /api/settings returns ui flags + providers + configPath only (src/settings-api.ts:16-24) — no secrets leak through the API. PUT /api/settings accepts only ui patch (settings-api.ts:26-35). Good boundary.
- Polling/backoff: per-provider throttle intervals + inflight coalescing (poll-cache.ts) + Claude exponential backoff to 60m (claude.ts:48-73) is a coherent anti-hammering design; the 29ee1db message documents the refresh-token-rotation hazard it fixes.
- Claude OAuth auto-refresh writes back to the user's credentials file (claude.ts:204-221) — mutating another app's auth file is aggressive but is exactly what `claude auth login` rotation needs; failure mode (write error) is unhandled throw inside ensureFreshClaudeToken → caught by fetchClaudeUsage catch-all → stale-token error. Acceptable; P3: surface "refresh succeeded but save failed" distinctly.
- OpenCode Go session via Firefox cookie scrape + dashboard HTML regex (opencode.ts:290-429) is brittle by necessity (no API yet); code correctly refuses to invent plan % from local DB (opencode.ts:624-627) and gates the local estimate behind OPENCODE_ALLOW_LOCAL_ESTIMATE. Good honesty; regex set is the known ceiling.
- Setup secret flow (provider-config.ts:33-163): detect env/file first, prompt paste, persist to config.json. Sensible; missing 0600 (see P2 above). No secret confirmation/validation call before save — mistyped key persists silently until first poll fails. P3.

## Architecture review
- Structure: src/adapters/* (8 providers, uniform fetch*Usage → ProviderUsage) → src/providers/registry.ts (FETCHERS map) → poll-cache.ts (throttle+coalesce) → server.ts (http, no framework) → public/* + desktop/* (Electron shell). Boundaries clean; adding a provider = 1 adapter + registry row + meta. No layering violations found.
- Data flow: tokens flow file/env → adapter memory → provider HTTPS only; usage flows adapter → in-memory cache → localhost HTTP → renderer. No persistence of usage or tokens besides config.json and Claude refresh write-back. Matches documented localhost-only model (package.json description, README).
- Deploy/release: no auto-update, no installer pipeline, no signing/notarization in repo (grep electron-updater/autoUpdater/update/download/sign/cert: none; .github/workflows/verify.yml runs typecheck+build+test+e2e-evidence on win+mac only). Releases are manual version-bump commits (9856f6b, 86d4ba7...). Update safety: users pull source and rerun — no silent-update channel to hijack, which is the safe default; P3: document the manual-update expectation + verify script in README so users don't run stale-vulnerable Electron.
- Electron hardening: win uses contextIsolation:true / nodeIntegration:false / sandbox:true with minimal preload bridge (main.cjs:387-392, preload.cjs exposes only widget close/open-dashboard/ensure-server/fit-content/quit IPC, no generic fs/shell). Fixture guard refuses fake data in product path (main.cjs:565). Removed in verification (was P2): the `serverEndpoint || {host,port}` fallback at main.cjs:139 cannot cause the window to render a foreign page. `createWindow()` runs only after the whenReady `ensureServer()` + `fetchHealth()` gate succeeds (main.cjs:557-568), which assigns serverEndpoint (main.cjs:103); `currentServerEndpoint()` (main.cjs:115-120) throws if it is still null, so a fallback-rendered foreign page is not reachable. The fallback only feeds the health watchdog's liveness probe. See Verification.
- Drift: docs/macos-widget/*.md describes tray + LaunchAgent login + Intel/Apple-Silicon paths; code matches (login-launch.ts, platform-policy.cjs). No ADRs in repo. README setup instructions match bin/config (detect-local.ts). No drift found.

## Recommended actions
1. P2/S — Write config.json with mode 0o600 when it contains secrets (src/cli/provider-config.ts:157-163) and chmod existing on load. One-line hardening; document that config holds plaintext keys.
2. P2/M — Get CI green: `verify` is red on master for both macOS jobs (`not ok 93` at tests/server-launch.test.cjs:881, runs 34736926536 and 34736586325). Fix the test to use the platform's separator expectation (e.g. assert with `path.join(...)`-derived expectation or accept both), so macOS CI stops failing on a Windows-only assertion. Evidence: `gh.exe run view 34736926536` → macos-15 and macos-15-intel X, windows-latest ✓. (added in verification)
3. P2/S — Guard LAN bind: warn/abort when server.host is non-loopback unless an explicit allow flag is set (src/server.ts:165, src/config.ts:209). /api/usage has no auth. Note: not on by default.
4. P3/S — Make the Win32 Start Menu test portable (tests/server-launch.test.cjs:881): the runtime path (desktop/main.cjs:291-298) is correct; only the assertion is wrong off-Windows. (was P1; corrected in verification)
5. P3/S — Private tmp for credential copies (cursor.ts:178, opencode.ts:308): mkdtemp + 0600, or document acceptance.
6. P3/S — Document manual-update model in README (no auto-update by design; `npm run verify` before `electron .`) since Electron ships Chromium.
7. P3/S — Setup: validate a pasted secret (or warn it is unvalidated) before persisting (provider-config.ts:applySecret); distinguish Claude refresh-save failures (claude.ts:213).

## Verification (2026-09-30)
Verifier: independent agent, different model family (DeepSeek). Method: re-read every cited path:line at 9856f6b, `git blame`, `gh.exe run view`/`pr view`, and one re-run check. No widget run against real credentials.

| Finding | Verdict | One-line evidence |
|---|---|---|
| P1 Win32 Start Menu path (test) | OVERSTATED → P3, corrected | Runtime is `path.join` (main.cjs:291-298) = all-`\` on Windows; same test `ok 93` on windows-latest CI, fails only on POSIX runners. Test-portability bug, no user impact. |
| P2 config.json no 0600 | CONFIRMED | src/cli/provider-config.ts:157-163 `writeFileSync` with no `mode`; src/config.ts has no chmod. |
| P2 LAN bind unauthenticated /api/usage | CONFIRMED (P2 kept) | Default 127.0.0.1 (config.ts:118, config.example.json:41); opt-in `server.host` (config.ts:209, no env override); server.ts:138-160 has no auth. Payload = quota percentages/balances + configPath, no tokens/account ids. |
| P2 Electron revive foreign-page fallback | WRONG → removed | `createWindow()` (and thus loadURL, main.cjs:399) runs only after whenReady `ensureServer()`+health gate (main.cjs:557-568) sets serverEndpoint (main.cjs:103); `currentServerEndpoint()` throws if null (main.cjs:115-120). Fallback (main.cjs:139) only feeds the health probe. |
| P3 tmp credential copies default perms | CONFIRMED | cursor.ts:178, opencode.ts:308: randomUUID name in os.tmpdir(), no `mode`. |
| P3 provider error bodies surfaced | UNVERIFIED | No evidence of token echo; code returns reason strings (claude.ts:333-341, openai.ts:130-150). |
| Credential sinks are provider-only | CONFIRMED | `grep -rhoE https://...` over src/adapters = 8 hosts, all provider-owned (api.anthropic.com, platform.claude.com, api2.cursor.sh, opencode.ai, cli-chat-proxy.grok.com, api.kimi.com, api.z.ai, openrouter.ai). |
| Firefox cookie read scoped to provider | CONFIRMED | opencode.ts:320 `WHERE host LIKE '%opencode.ai%' AND name='auth' ORDER BY expiry DESC LIMIT 1`. |
| No secret logging | CONFIRMED | Only console.* in src are server.ts:162/168/181, opencode.ts:260, setup messages; none interpolate token/cookie/Authorization. |
| PR #1 merged, no review | CONFIRMED | `gh pr view 1`: MERGED 2026-07-21, reviews []. Issues: 0. |
| CI green on master | WRONG → new P2 | `gh run list`: every run in the last 15 commits = failure. 34736926536: macos-15 X, macos-15-intel X, windows-latest ✓ (same `not ok 93`). |

Check re-run: `npm test` → **exit 1** (190 tests, 189 pass, 1 fail; the report's "exit 0 overall" was wrong — corrected above). `npm run typecheck` → exit 0.

Counts: confirmed 7, corrected 3 (P1→P3 Start Menu, P2 Electron removed, LAN severity reviewed/kept), removed 1, added 1 (CI red on master).
