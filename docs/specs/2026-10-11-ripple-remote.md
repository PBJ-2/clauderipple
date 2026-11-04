# Ripple Remote — design draft (2026-10-11)

Status: **draft; M1 (host + LAN PWA), M2 (relay + E2EE, not deployed) and M3 push + launchd agent
built (2026-10-12)**, see [2026-10-11-ripple-remote-ux.md](2026-10-11-ripple-remote-ux.md) "Built"
and "Not built / open". Facts marked *measured* have a source; everything else is a
decision or an open question and says so. Paseo and Happy are behavioral references only — no
code is copied from them (project CLAUDE.md).

## Why (the thesis)

A user whose daily driver is the Claude desktop app cannot use ClaudeRipple from a phone today:

1. **The mobile model picker is Claude-only.** A session already open on the Mac can still be told
   "run this on GPT" (markers, workers), but a session cannot be *started* on GPT, DeepSeek, Gemini
   or GLM from the phone. Desktop picker mode works by intercepting the claude.ai bootstrap in the
   Electron renderer (ARCHITECTURE §3); the mobile app is not ours to intercept, and nothing
   suggests Anthropic will open it.
2. **The phone cannot open a new session in an arbitrary local folder.** Remote Control continues
   sessions the Mac already has.
3. **Remote Control drops and stays dropped.** Per the official docs
   (code.claude.com/docs/en/remote-control, read 2026-10-11): an interactive session that cannot
   reach the Remote Control server for about 30 minutes disconnects and needs `/remote-control`
   again; `claude remote-control` (server mode) exits after about 10 minutes of network outage;
   a session taken by another device, or older than the 18-hour trusted-device check, does not
   come back on its own. This Mac does not sleep (Amphetamine), so the drops seen here are network
   changes, not sleep. The router itself has caused such drops before (ARCHITECTURE §5, the DNS row).

ClaudeRipple already owns the piece that makes 1 possible: every model the router knows can be
the session model when *we* start the CLI with `ANTHROPIC_BASE_URL` pointing at the router (§6:
the base URL cannot be changed inside the app's sessions, but a process we spawn sets its own env).

## Market (GitHub API, 2026-10-11)

| | ★ | License | Notes |
|---|---|---|---|
| slopus/happy | 24.1k | MIT | relay + E2EE, mobile/web/desktop; hosted relay outage ~20h (#1682), empty pushes after it (#1870) |
| getpaseo/paseo | 20.4k | Apache-2.0 | daemon + relay + apps; providers split per agent, not mixed in a session |
| siteboon/claudecodeui | 14.0k | AGPL-3.0 | web UI, paid hosting |
| omnara-ai/omnara | 2.9k | Apache-2.0 | pivoted to a managed agent platform |

Nobody mixes workers inside one Claude session with cache kept, and nobody shows the mod's
figures (effort judge, cache keep-warm, context/limit gauges, compact) remotely. The
complaints in Paseo's 1,170 and Happy's 1,061 open issues cluster on four failures, which become
our requirements below.

Every issue cited here was re-read with `gh api` on 2026-10-11 and is **open**: Paseo #1330
(created 2026-06-04), #2220 (07-19), #2610 (07-29), #5820 (10-01); Happy #988 (04-04), #1208
(05-02), #1682 (08-10), #1870 (10-06).

## How Paseo stays up (read from the installed app, 2026-10-11)

- **The server is the user's own machine.** The daemon runs locally (`127.0.0.1:6767`) and the
  phone reaches it by SSH, Tailscale (direct, `daemon.listen` set to the tailnet IP) or the Paseo
  relay. The relay is **off until the user enables it** (paseo.sh/docs/connectivity, read
  2026-10-11); it is one shared, Paseo-run forwarder of end-to-end-encrypted bytes, not a
  per-user server and not where sessions live. This Mac's `~/.paseo/daemon.log` shows
  `relay_control_*` events, so the relay was enabled here.
- The app spawns the daemon `detached` + `unref()`; a supervisor forks a worker and restarts it on
  crash. By default the daemon still quits with the app (`keepRunningAfterQuit: false`); no login
  item, launchd job or sleep assertion.
- One outbound control WebSocket to `relay.paseo.sh` (Cloudflare Worker + Durable Object), one data
  socket per client connection. WS ping every 10 s, stale after 30 s, ready timeout 8 s, reconnect
  backoff `min(30 s, n × 1 s)` that never gives up. App-level lease 45 s.
- E2EE: daemon X25519 keypair on disk (0600), client ephemeral key, `hello`/`ready` handshake,
  XSalsa20-Poly1305 frames; the relay sees ciphertext. Pairing via QR / URL fragment carrying
  server id, daemon public key and relay endpoint.
- Claude is driven through the Agent SDK `query()` (`includePartialMessages`, `resume`,
  `canUseTool` for remote permission prompts). Stream events carry `seq` + `epoch`; the timeline is
  persisted and a reconnecting client asks for everything after its last `seq`.
- Push through Expo; pushed only when no client was active in the last 180 s, silent when a client
  is focused on that agent.

## Requirements from others' failures

| Observed elsewhere | Requirement here |
|---|---|
| Paseo #2610: history over 8 MB kills the WebSocket (1006); #2220 image-heavy timeline over the relay frame limit | History is paged and chunked; no frame over a fixed cap (e.g. 256 KB); images go as separate blobs fetched on demand. |
| Paseo #5820: replaying subagent history on open crashes the daemon | Subagent transcripts load lazily, per agent, on request. |
| Paseo #1330, Happy #1208: relay data channel drops and the client cannot re-attach | Reconnect never gives up; resume is by `seq`, so a re-attach is cheap and idempotent. A half-open socket is detected by app-level lease, not TCP. |
| Happy #1682/#1870: hosted relay degraded for ~20 h | LAN / Tailscale direct path works with the relay down; the client tries direct first. Relay is stateless beyond pairing so a restart loses nothing. |
| Happy #988: messages arrive in bursts | Partial messages streamed as they come; coalescing only on the client. |
| RC: gives up after 10/30 min | The host never gives up and says on the band and in the tray when it is unreachable. |

## Architecture (decisions; built as listed in the UX doc)

- **Host process `ripple-host`, its own launchd agent** (`com.clauderipple.host`, KeepAlive,
  `ProcessType=Interactive`). Not inside the router: the router is the daily driver and must not
  be restarted to ship host changes (ARCHITECTURE §5). The host talks to the router over loopback
  like any client.
- **Sessions are the host's.** It spawns Claude Code through the Agent SDK with
  `HTTPS_PROXY` + `NODE_EXTRA_CA_CERTS` pointing at the router (ARCHITECTURE §1), any `cwd` the
  phone picks (thesis 2), any model id the router routes (thesis 1). Not `ANTHROPIC_BASE_URL`:
  the router's port answers origin-form requests 405 (*measured* 2026-10-11, see the UX doc).
  The CLI's `unrecognized_model` warning is noise only (§3).
- **Desktop-app sessions:** open question. Resuming a session the desktop app has open would put
  two writers on one transcript. v1 lists them read-only and offers "continue here" only for
  sessions not open in the app. *Not measured.*
- **Transport:** outbound WSS to our relay (Cloudflare Worker + Durable Object), plus direct
  LAN/Tailscale. Same liveness numbers as Paseo (10 s / 30 s / 8 s, capped backoff, never stop).
  Through the relay the phone also sends the relay's plain `ping` every 10 s, which the runtime's
  auto-response answers without waking the room; once host and phone both advertise it, the
  end-to-end check and presence drop to 60 s (`SLOW_PING_MS`) so an idle phone lets the room
  hibernate (2026-11-04).
- **E2EE:** X25519 + XSalsa20-Poly1305 (`tweetnacl`, our own framing). Host key 0600 under
  `~/.clauderipple/`. Pairing by QR from the tray app and the dashboard.
- **Sync:** per-session event log with `seq`/`epoch`, persisted (append-only JSONL, rotated). The
  mod's figures are events in the same log, so the phone shows the same band.
- **Permissions:** `canUseTool` requests are persisted with an id, pushed, and survive a host restart.
- **Sleep:** a power assertion only while a turn runs (`caffeinate -i -w <pid>` child). Idle
  sleep stays the user's choice.
- **Client:** v1 a PWA served by the relay origin (TypeScript, the dashboard's stack; iOS web push
  needs the PWA added to the home screen). A native app (Expo) only if the PWA falls short.

## Milestones

0. **Stopgap (days):** launchd agent running `claude remote-control --spawn worktree`, KeepAlive
   relaunches it after the 10-minute exit, tray shows its state. Uses the official app on the phone.
1. Host + LAN-only PWA: start a session in any folder on any routed model, stream, permissions.
2. Relay + E2EE + pairing.
3. Push + presence rule; mod band on the phone.
4. Native app, if needed.

## Open questions

- The relay is optional by design, as Paseo's is: direct (Tailscale / LAN) needs no server of
  ours. If we run a shared relay it only forwards ciphertext (Cloudflare Worker + Durable Object
  is cheap at this scale); self-hostable from day one so nobody depends on us.
- Desktop-session concurrency (above) — measure before M1.
- ~~Does the Agent SDK accept a non-Claude model id end to end through the router?~~ *Measured*
  2026-10-11: yes through `HTTPS_PROXY` (`deepseek-v4.1-flash` answered), no through
  `ANTHROPIC_BASE_URL` (405). Details in [the UX doc](2026-10-11-ripple-remote-ux.md#measured-does-query-route-a-non-claude-model-end-to-end-2026-10-11).
- App Store review for a native client that runs third-party models.
