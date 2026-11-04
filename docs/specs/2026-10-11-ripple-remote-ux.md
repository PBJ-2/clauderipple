# Ripple Remote — UX (2026-10-11)

Status: **M1 built** on `feat/remote-app` (`packages/remote`). Facts marked *measured* have a
source; the rest are decisions and say so. Companion to
[2026-10-11-ripple-remote.md](2026-10-11-ripple-remote.md) (architecture, market, milestones).

## Why it exists

A Claude-app user cannot use ClaudeRipple from the phone:

1. **The mobile model picker is Claude-only.** A session cannot be *started* on GPT, DeepSeek,
   Gemini or GLM from the phone.
2. **The phone cannot open a new session in an arbitrary folder on the Mac.** Remote Control only
   continues sessions the Mac already has.
3. **Remote Control drops and stays dropped** (≈30 min offline for an interactive session, ≈10 min
   for server mode, per code.claude.com/docs/en/remote-control, read 2026-10-11).

An app is only worth it if it is *easier* than all of that. The owner's bar: the UI must be
absurdly easy. Every decision below is judged by "how many touches, and where is the thumb".

## Principles

1. **Type first.** The most common action — start work — is: open, type, send. Folder and model are
   pre-filled with the last choice and sit as two chips right above the composer.
2. **Bottom third only for actions.** Composer, Send/Stop, folder and model chips, permission
   Allow/Deny, sheet confirm buttons. The top is for reading (where am I, what state, figures).
3. **Never lie about state.** Every number and state is either live, or visibly "as of hh:mm".
   Nothing shows as sent before the host acknowledges it. A ticking timer never runs on a guess.
4. **One look, two seconds.** Home answers "does anything need me?" before anything else.
5. **The mascot is for empty and broken moments only** (pairing, no sessions, lost link, offline,
   unpaired). Working screens stay quiet.

## Flows

### Open → resume or new

Home = the session list with a **new-session composer docked at the bottom**
(`home-light.png`). No separate "new session" screen.

- Sections, in this order: **내 확인이 필요해요** (open permission requests, count badge, warm
  border), **진행 중**, **최근**. Each row: title (first prompt), folder · model · relative time,
  and a state ring (dashed = working, warm with dot = needs you, green = done, faint = paused).
- Tap a row → the session. Type in the composer → a new session starts in the chip's folder on
  the chip's model; the app moves into it at once, showing the message as "sending" until the host
  acks it (`create` is idempotent on the phone's message id, so a resend after a drop cannot start
  two sessions).

### New session: folder

Folder chip → bottom sheet (`folder-light.png`): filter field, **최근 쓴 폴더** (this host's
sessions plus the folders Claude Code itself worked in, from the SDK's `listSessions`; worktrees and
temp dirs left out; *measured* 166 ms for 200 sessions / 26 folders here), then **찾아보기** with a
breadcrumb, "상위 폴더", and sub-folders. The sticky bottom button "이 폴더에서 시작" always shows the
path it will use. Recent first because almost every session is in one of a handful of repos.

### New session: model + effort

Model chip → bottom sheet (`model-light.png`): **최근** (last 3 used), then every routable model
grouped by provider exactly as the router reports them (`GET /api/mod-options` + `/api/effort-levels`
on the admin port, read-only; judge-only models such as Jev left out, ARCHITECTURE §3b). Providers
the router marks unusable are greyed with "로그인 필요" instead of hidden — hiding would make a
model "disappear" with no reason. The effort ladder is the model's own (DeepSeek low/high/max,
GPT low…max), sticky at the bottom next to the confirm button, default high.

The same sheet changes the model of a running session (header subtitle is the button). A routed
model's effort rides on `model@level`, which the router reads (ARCHITECTURE §3a), so that switch is
live; a Claude model's effort is a process option, so it applies from the next turn (the query is
closed after this turn and resumed). The timeline says "모델을 바꿨어요".

### Streaming

Text streams into the answer as it comes (the host coalesces deltas ~80 ms; Happy #988 was bursts).
A caret marks the streaming message. Tool calls are one-line rows (icon, tool, mono summary —
command, relative path, pattern) with a status tick; tap to expand the result, which is fetched on
demand if it was too large to inline. Subagents are one card each: "워커 · model · 끝남 · 7단계 ·
description"; their transcripts live in a separate log and load only when the card is opened
(Paseo #5820). Each finished turn ends with a quiet footer: model · effort · duration.

### Permission: one thumb

`permission-light.png`. The request docks **above the composer** — where the thumb already is —
not in a modal at the top. Tool name, the question, the full command / diff / arguments in mono
(5 lines, "전체 보기"), then **거부 | 허용** at 54 px, Allow on the right and wider (a right thumb
reaches it without stretching; a left-handed user still has a full-width-ish target), and "이 세션에서
계속 허용" as a quiet third choice when Claude Code offers a rule. Several open → "1/3", answered in
order. The phone vibrates once when a new request arrives (Android; iOS web has no vibration).
Regions re-render every second, so unchanged markup is never replaced: replacing a button under a
thumb between touch-down and touch-up swallows the tap.

Requests are persisted on the host. If the host restarts, the CLI that asked is gone, so the
request is marked **만료됨 · Mac의 호스트가 다시 시작돼…** — never left looking answerable.

### Interrupt

While a turn runs, the Send button becomes **Stop** in the same spot. Stop is only offered while the
link is up; offline, the button queues a message instead, because a Stop the host cannot hear would
be a lie.

### The mod's figures

A four-cell band under the header (`stream-light.png`): **노력 · 캐시 · 컨텍스트 · 5시간 한도**, with
thin bars on the two that run out. Tap → which other models served this session and how often
(`workers-light.png`), with the 5-hour reset time and "as of". Sources, all from the router's own
records for this session id: effort and cache % from the main model's requests, context % from the
latest completed request over the window the CLI reported, 5 h from the Claude subscription quota.
They are events in the session log, so a reconnecting phone sees the same band. Unknown is "—",
never 0. *Measured* in the end-to-end run below: effort followed the ripple mod's own judgement
(it set xhigh for one prompt), because sessions load the user's settings and with them the mod.

### Reconnect states that never lie

| Situation | What the phone shows |
|---|---|
| Up | Green dot · "연결됨". Nothing else. |
| Down < 30 s | Pill "3초 뒤 다시 연결" counting down; slim line "아래 내용은 16:41 기준이에요"; band, rings and tags dimmed (`reconnecting-light.png`). |
| Down ≥ 30 s | Card with the sleepy mascot: "Mac에 닿지 않아요 · 2분 14초째 답이 없어요. 세션은 Mac에서 계속 돌고 있을 수 있고, 다시 닿으면 놓친 내용을 빠짐없이 받아 와요." + last seen + **지금 다시 시도** (`lost-light.png`). "Working for 0:42" becomes "16:39에 마지막으로 봤을 때 작업 중이었어요". |
| Phone offline | "이 폰이 오프라인이에요" — the phone's fault, said as such (`offline-light.png`). |
| Router down, Mac up | Warm card: the Mac answers, the router does not; new requests fail until it is back. |
| Token refused | "이 폰의 연결이 해제됐어요" — the only state that stops retrying, because retrying a refused token would just say "connecting" forever. |
| Typed while down | Bubble with "연결되면 보내요", kept in localStorage across app restarts, sent on reconnect, idempotent. |

Liveness (same numbers as Paseo, our own code): app-level ping every 10 s, stale after 30 s of
silence, a socket that does not reach `ready` in 8 s is abandoned (from creation, so a hanging
connect after a network switch is caught too), backoff `min(30 s, n × 1 s)` forever, and an
immediate retry on `online` and when the app comes to the front. Since 2026-11-04 a phone on the
relay also pings the relay itself (plain text, answered by the runtime without waking the Durable
Object) every 10 s, and when `hello`'s `slowHeartbeat` feature meets the host's
`capabilities.slowHeartbeat`, the end-to-end check and presence run at 60 s (`SLOW_PING_MS`); the
host sizes that client's stale and visible windows at three beats (`SLOW_STALE_MS`,
`SLOW_VISIBLE_MS`). Older hosts keep the 10 s cadence and older phones keep working as before.

## Comparison: what makes others pleasant or annoying

Product facts are cited; UI impressions are marked as such and were not measured.

| | Pleasant | Annoying | What we take / avoid |
|---|---|---|---|
| Claude mobile + Remote Control | Official, same transcript as the Mac; clean reading typography (impression). | Model picker Claude-only on mobile; no new session in an arbitrary folder; drops after ≈10–30 min offline and needs `/remote-control` again (docs, 2026-10-11). | Take the calm reading layout (assistant text full width, no bubble). Avoid every one of the three gaps — they are why this exists. |
| ChatGPT app | Composer-first; model switch from the header; answers stream smoothly (impression). | Model choice one level deep, effort not visible at the point of sending (impression). | Composer-first home; model *and* effort visible on the chip before you send. |
| Paseo | Daemon on your own machine, relay optional; never-give-up reconnect with ping/stale numbers; seq-based resume (read from the installed app, 2026-10-11). | History over 8 MB kills the socket (#2610); subagent replay crashes the daemon (#5820); relay channel drops and does not re-attach (#1330); providers split per agent. | Same liveness numbers, own implementation; paged history under a 256 KB frame cap; subagents lazy; one session can use every routed model and workers. |
| Happy | E2EE relay, push, multi-device. | Hosted relay degraded ~20 h (#1682) with empty pushes after (#1870); messages in bursts (#988); re-attach failures (#1208). | Direct LAN / Tailscale first, relay later and optional; stream as it comes, coalesce only lightly. |

## Visual system

- Tokens from the mascot sheet (`design-drafts/ripple-char-v2.html`, `packages/mod/hooks/ui/theme.ts`
  values): accent #6a56d6 / #a594f5, warn #b5820a / #e0b436, bad #c73434 / #ef5a5a, ok #1a8a4a /
  #3ecb7d, ink #1d1b26 / #ecebf2, faint track #c9c6d2 / #55535f. Warm neutral surfaces so the accent
  is the only colour that speaks. Light and dark follow the system, or `data-theme`.
- State glyph = the mascot's ring with its wave crest, no face, following the mascot's own prop rule
  (dashed = in progress, solid = finished). Faces appear only on empty/broken screens: calm (pair,
  empty), sleepy (lost, offline), uneasy (router down), sorry (unpaired).
- 16 px body text everywhere input happens (iOS zooms on anything smaller); mono for anything a
  person might copy (commands, paths, model ids); tabular numbers in the band.
- No decorative motion. The caret blinks while streaming and the small ring turns on the
  "working for" line; both stop under `prefers-reduced-motion`.

## Korean first, i18n

All copy lives in `packages/remote/web/i18n.ts`: Korean is the source, English mirrors every key
with the same placeholders (a test checks parity). The language follows the phone (`ko*` → ko,
`en*` → en, otherwise ko); the gear toggles it for now. Industry terms stay (모델, 워커, 컨텍스트,
캐시) per the GUI-copy rule.

## Large history

- The host never sends a frame over 256 KB (`FRAME_CAP`): a page is cut by bytes; any string over
  32 KB leaves the event as a blob fetched in 60 k-char chunks; a stored event line is ≤ 64 KiB.
- Opening a session sends only the tail page; scrolling up pages backwards (`history beforeSeq`).
  A phone that comes back far behind (> 4 frames) gets the tail instead of a replay.
- The client patches the timeline by key (unchanged messages stay in the DOM, so streaming does not
  re-layout the page) and uses `content-visibility: auto` on rows.
- *Measured* (event log test): opening a 200 k-event log 94 ms.

## Measured: does `query()` route a non-Claude model end to end? (2026-10-11)

Agent SDK 0.3.283 (`@anthropic-ai/claude-agent-sdk`), router 0.8.10 live on this Mac, one tiny
prompt "Reply with exactly: pong", `model: "deepseek-v4.1-flash"`:

| Path | Result |
|---|---|
| `ANTHROPIC_BASE_URL=http://127.0.0.1:8791` (what the architecture draft said) | **Fails**: `result.is_error`, "API Error: 405 status code (no body)" in 6.1 s. The router's port is a forward proxy: it answers CONNECT and absolute-form requests and refuses origin-form `POST /v1/messages` (`proxy.ts` `onConnect`). |
| `HTTPS_PROXY=http://127.0.0.1:8791` + `NODE_EXTRA_CA_CERTS=~/.clauderipple/ca.pem` (ARCHITECTURE §1) | **Works**: streamed "pong" in 7.4 s; router record `deepseek-v4.1-flash → opencode-go 200`, session id = the SDK's. The CLI's `unrecognized_model` stderr line appears and is noise only (§3). |

So the host does **not** set `ANTHROPIC_BASE_URL` (it removes one it inherited) and sets the proxy
and CA from the router's `/api/status`. Then, through the host itself (CLI 2.1.296, the user's own
`~/.local/bin/claude`): a new session in a temp folder answered "pong"; after stopping and
restarting the host, a follow-up resumed the same conversation (it remembered the earlier prompt);
a `Write` request reached the phone protocol as a permission, was allowed remotely, and the file was
written. Figures arrived as events (cache 0 → 50 → 75 %, context 9 %, 5 h 7 %).

## Built (M1)

- `packages/remote/src`: host (`main.ts`), Agent SDK sessions with streaming input, resume,
  `canUseTool` → persisted queue (`sessions.ts`, `permissions.ts`), per-session append-only event log
  with seq/epoch and resume-after-seq, paged history, blobs (`eventlog.ts`), one WebSocket with
  request/response for models, folders, browse, blobs and subagent logs (`server.ts`), router admin
  reader (`router.ts`), bind/token/QR (`config.ts`). Bind default 127.0.0.1; `--bind tailscale|lan`
  picks the address (plain http: no service worker, so no push — use the relay).
- `packages/remote/web`: the PWA above; `?demo=<state>&theme=` renders the fixture states the
  screenshots come from (`docs/media/remote/*`, 390×844 CSS px at 2×, rendered with headless Chrome
  for Testing over CDP).
- Run: `npm run remote -- --bind lan` in the checkout, scan the QR (same network only).

## Built (M2 relay, M3 push, daily service — 2026-10-12)

- **Relay** (`packages/remote/relay`): a Cloudflare Worker + one Durable Object per host
  (`worker.ts`, logic in `room.ts`). Host control socket `/ws/host`, one phone socket `/ws/client`
  and one host data socket `/ws/host-data` per phone; frames forwarded untouched, capped at
  `RELAY_FRAME_CAP` (FRAME_CAP + 1 KiB), nothing stored but a hash of the host's secret (the first
  host to use a server id registers it; another secret gets 403). Hibernation API; plain `ping`
  frames from the host's control socket and from a phone socket are answered by
  `setWebSocketAutoResponse` (and by `room.ts` while the object is awake), and a plain `ping`/`pong`
  is never forwarded between phone and host, so an idle room costs no duration. Only after both
  ends advertise the slow cadence do end-to-end check and presence run every 60 s (2026-11-04). The
  PWA is served from
  the same origin as static assets (`build-web.ts` → `dist/`, headers from `dist/_headers`; only
  `/ws/*` runs the worker) — the https origin service workers and web push need. *Measured*
  2026-10-12 with `wrangler dev` 4.142.0: host connected, a headless phone completed the handshake
  and received a seeded session's events; headless Chrome opened the pairing link, registered
  `sw.ts`, connected through the relay and showed the home list and "알림 켜기"; after the relay was
  killed and restarted the host reconnected by itself ("connected again after 4 attempt(s)").
- **E2EE** (`src/e2ee.ts`, shared with the browser): host X25519 key `host-key.json` (0600), phone
  ephemeral key, hello/ready where only the paired host can make a `ready` that opens, then
  XSalsa20-Poly1305 frames under a key from both sides' ephemeral keys, with counted nonces (a
  dropped, repeated, reordered or altered frame closes the link). tweetnacl 1.0.3. The pairing
  link `https://<relay>/#pair=<token>&server=<id>&hpk=<host key>` keeps all three in the fragment;
  the token is checked inside the channel as on the direct path.
- **Host** `--relay <url>` (remembered; `--relay off`): control socket with ping 10 s / stale 30 s /
  ready 8 s / backoff `min(30 s, n × 1 s)` forever (`src/relay.ts`). Direct LAN/loopback still
  works; the PWA uses the relay when it was opened from the relay's origin, the direct socket when
  served by the host itself.
- **Push** (`src/push.ts`, `web/notify.ts`, `web/sw.ts`): VAPID keys made once (`vapid.json`,
  0600), one subscription per device (`push.json`), `web-push` 3.6.7 with aes128gcm. Sent when a
  permission request waits, a turn finishes, or a turn fails — only if no connected phone said
  "visible" in the last 30 s (the app re-reports every 10 s while in front). 404/410 drop the
  subscription. Home shows "알림 켜기" (asks from the tap), or what it takes: add to Home Screen on
  iPhone, an https address, or allowing notifications in Settings.
- **Daily service** (`src/service.ts`): `ripple-host install [--print] | uninstall | status | pair`;
  launchd agent `com.clauderipple.host` (RunAtLoad, KeepAlive, ThrottleInterval 10, ProcessType
  Interactive, log `~/.clauderipple/logs/host.log`, PATH with `claude`'s folder). Under launchd the
  QR is not printed (the log would hold the token); `pair` prints it.
- **Power** (`src/power.ts`): one `caffeinate -i -w <host pid>` while any session is starting,
  running or waiting on a permission; killed when none is.
- Run: `npm run relay:dev` (local relay on 127.0.0.1:8798) and
  `npm run remote -- --relay http://127.0.0.1:8798`, or the deployed relay's https URL.

## Not built / open

- **Desktop-app session concurrency** — not tested on purpose; the host only lists its own
  sessions. Continuing a session the desktop app has open would put two writers on one transcript.
- Relay not deployed; no shared public relay. Rate limits / abuse controls on the relay (anyone
  can open rooms for new server ids) are not built.
- Push not tested against a real push service (APNs / FCM) yet: needs the deployed https relay
  and a phone. Apple's acceptance of the VAPID subject (`mailto:…@clauderipple.invalid` when the
  relay is not https) is unverified; with an https relay the subject is the relay URL.
- Tray/dashboard pairing QR (the terminal prints it), unpair from the phone, key rotation.
- No offline shell: the service worker caches nothing on purpose.
- `host.log` is not rotated.
- Packaging: the published npm package cannot strip types under `node_modules`, so the host is not
  in `clauderipple` yet (`scripts/build-npm.mjs` would need to compile it).
- Settings screen (the gear only toggles ko/en), session archive/delete, image attachments, voice input.
