# Ripple Remote — native iOS app and desktop sessions (2026-10-12)

Status: decided 2026-10-12 (주군): native app, iOS first, TestFlight for personal use. Public
App Store release is a later decision. The web app stays as is (fallback; the relay keeps serving it).

## Why

- A Home Screen web app on iOS keeps storage apart from Safari: pairing from a scanned QR never
  reached it (fixed with paste-to-pair, 52d9eec/ac6c3c6, but clumsy). Web push on iOS only works
  from the Home Screen app and is fragile.
- The phone shows only sessions the host started; the Mac's existing Claude sessions are missing.

## Part A — desktop sessions on the phone (host + web)

Read-only first (docs/specs/2026-10-11-ripple-remote.md §"Desktop-app sessions"): two writers on
one transcript is unmeasured, so **no "continue here" in this round**.

- Source: Claude Code transcripts `~/.claude/projects/<project>/<session-id>.jsonl` (top level
  only; `subagents/` and other subfolders are not sessions). Recent first by mtime, at most 50,
  last 14 days. Skip transcripts the host itself drives (its records' `sdkSessionId`).
- Summary: id (session id), title (the transcript's own title/summary entry if present, else the
  first real user prompt, trimmed), cwd (from the records' `cwd`), updatedAt (mtime), model
  (last assistant record's model), `origin: "desktop"`, `readOnly: true`.
- Timeline: converted to the existing `EventBody` kinds (user, assistant with tool summaries,
  tool_result ok/failed, result) and served through the existing paged history path under the
  same frame cap. Large texts become blobs like host sessions. Parse defensively: unknown record
  types are skipped, a malformed line never fails the listing.
- Read lazily: listing reads only file heads/tails, never whole transcripts.
- Web app: home shows host sessions first, then a "Mac 세션" section; a desktop session opens
  read-only (no composer; one line says it is read-only).

## Part B — native iOS app

- Location `apps/ripple-remote/` (outside the npm workspaces, own node_modules; not in the npm
  package `files`). Expo SDK 56 + expo-router, TypeScript — same stack as DayRipple.
- Bundle id `com.clauderipple.remote`, EAS owner `rippleworks`, name "Ripple Remote".
- **Shared code, not copies:** protocol types, `conn.ts` (Link, liveness), `secure.ts` + `e2ee.ts`
  (relay E2EE), `timeline.ts`, i18n strings are imported from `packages/remote` via Metro
  `watchFolders`. If a module touches the DOM it is split so the platform-neutral part is
  shared. tweetnacl needs a PRNG: `react-native-get-random-values` (or expo-crypto) polyfill.
- Relay only (no LAN direct mode in the app).
- Pairing: in-app QR scanner (expo-camera) and paste-link fallback; the same `#pair=…&server=…&hpk=…`
  link. Token and relay keys in expo-secure-store. Unpair in settings.
- Screens: pair, sessions (host + Mac sessions), session timeline with composer, permission
  approve/deny, new session (folder + model + effort), settings. Copy: Korean 합니다체, reuse the
  web strings; English as second language like the web.
- Push: expo-notifications → Expo push token → host (new client op, stored per clientId like
  web push subscriptions) → host sends through the Expo Push API. Same three moments and the
  same "nobody looking" rule as `src/push.ts`. **Payload carries no prompt or output text**
  (it passes Expo and Apple): a fixed line per moment ("승인을 기다립니다" / "작업을 마쳤습니다" /
  "작업이 실패했습니다") plus the session id in `data` for deep-linking. 404-equivalents
  (`DeviceNotRegistered`) drop the token.

## Windows host (deferred to the Windows release — decided 2026-10-12)

The phone app, relay, E2EE and transcript handling are OS-neutral. These host parts are macOS-only
today and need a Windows path before Ripple Remote ships on Windows:

| Part | macOS now | Windows needs |
|---|---|---|
| Resident host | launchd (`src/service.ts`) | Task Scheduler or a service |
| Claude login token for Remote Control | keychain `security find-generic-password -s "Claude Code-credentials"` (`src/bridge-client.ts`) | where Windows Claude Code keeps it — verify |
| Handoff to the desktop app | `/usr/bin/script` pty around `claude --desktop --resume` (`src/handoff.ts`) | ConPTY |
| Live-session check | `~/.claude/sessions/<pid>.json` (shared) + `ps` fallback (`src/desktop.ts`) | replace the `ps` fallback |

First confirm the Windows Claude app writes the same session registry and supports Remote Control.

**Measured 2026-10-22 (issue #70), Windows 11 arm64 VM, Claude app 2.42304.0 (Store), CLI 2.1.299:**
the registry is the same file with the same keys, except `procStart` is a FILETIME string (100 ns
ticks since 1601 UTC) that equals `Win32_Process.CreationDate` exactly, and `pidDomain` is
`win32:<hex>`. `bridgeSessionId` is written only when the app's Remote Control is on (a session
opened with it off had none; one opened after turning it on had one). The app-started CLI's command
line carries no session id for a new session, so the registry, not the command line, identifies
it. With only the app in use there is no `~/.claude/.credentials.json`; the bridge then uses the
router's observed login. Sending through the bridge from the VM put the message into the app
session's transcript under its uuid and the session answered. Ported: the live-session check and the
bridge login (`desktop.ts`, `bridge-client.ts`, `processes.ts`'s cached snapshot). Ported since: handoff
(`conhost.exe --headless`, `src/handoff.ts`) and the desktop sidebar (`windowsSidebarRoot`, `src/sidebar.ts`).
Still macOS-only: away detection (`src/away.ts`). Linux has no Claude app to hand off to; see
ARCHITECTURE.md section 10.
Verify in the Parallels VM (prlctl exec).

## Acceptance

- Part A: unit tests for transcript parsing (fixtures, malformed lines); the phone lists today's
  Mac sessions and opens one read-only.
- Part B: typecheck; iOS simulator build runs, pairs with the live relay by pasted link, lists
  sessions, opens one, sends a prompt in a host session. TestFlight build only after 주군 confirms.
