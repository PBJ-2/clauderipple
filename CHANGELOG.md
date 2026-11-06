# Changelog

## Unreleased

### Added

- **The phone is told when the computer loses its connection while Claude is working.** While a
  turn, an approval or a Claude app conversation is active, the host renews a watch on its relay
  every minute; if the computer sleeps, drops off the network or the host process dies, the relay
  pushes "the PC disconnected" to the phone's Expo devices once per outage, and the host sends "the
  PC is connected again" with the outage length when it is back. The relay holds only the phones'
  Expo tokens, their language and the host's public key for this — no conversation content. An
  expired Claude login while work is active now also reaches the phone (native and web) as its own
  notice. Web push is not part of the relay watch: it needs the host's VAPID signing key.

### Changed

- **Ripple Remote for Android is on Google Play.** The dashboard's phone view shows a Google Play
  button beside the App Store one, instead of the Discord sign-up for the closed test.

### Fixed

- **Hotspot failover leaves macOS's own join alone, and comes back only to a Wi-Fi that is really
  there.** With no Wi-Fi address at all the router now waits a minute before trying the hotspot
  itself, so macOS can wake an iPhone through Instant Hotspot; our `networksetup` join cancelled
  that auto-join and could not wake a hidden phone. A return needs a saved network at -70 dBm or
  better from a scan the radio really ran, not a weak one heard in airportd's cache, and the
  hotspot is rejoined at once when nothing associated within 8 seconds of leaving. A changed Wi-Fi
  address, subnet or network class resets the probe window for 30 seconds, so joining home Wi-Fi no
  longer sends the Mac back to the hotspot.
- **Account limits are read from the provider, not guessed.** A Claude subscription 429 whose unified
  limit headers say the 5-hour or weekly window is spent now rests that account until the stated
  reset instead of retrying it every minute, and the caller is answered with `x-should-retry: false`
  and that reset as `retry-after`. A token refresh no longer brings a resting account back early.
  OpenCode Go's 429 for its own failing upstream (`[prefill_cap_refused]`, `[overloaded]`) is retried
  inside the turn and no longer cools the key, and a Google account banned for a Terms of Service
  violation is parked instead of being refreshed and replayed. After an in-turn retry, the log line
  and `requests.jsonl` name the account that actually answered.

## 0.12.32 — 2026-11-05

### Changed

- **Account tabs in the worker settings.** A provider with several accounts shows "계정 1",
  "계정 2" … tabs on its model list; each tab lists that account's models by name, numbered as in
  the limits pane. The worker ladder menu is grouped the same way.

### Fixed

- **Naming a worker pinned to an account now runs it on that account.** In 0.12.31 the mod could
  not read the provider of these workers, so a task that named one ran on the worker ladder's
  usual pick instead. The ladder could not list them either.
- **No pinned workers for an account that needs signing in again.** Such a worker could only run
  on another account. It comes back on its own once the account is signed in.

## 0.12.31 — 2026-11-05

### Added

- **Choose which account a worker runs on.** When a provider keeps signed-in accounts of its own
  (Claude accounts, ChatGPT accounts, or Google Antigravity accounts), ClaudeRipple now writes one
  worker per model and stored account, named after the account's stable local id (for example
  `claude-opus-5-5-3f2a9c1b`), and the dashboard's worker ladder lists each with its account name.
  A worker started from one of these runs on that account instead of whichever one the usual
  rotation would pick. The name never follows the account's label, so relabelling an account — or
  removing one of two accounts that share a label — cannot point a saved ladder rung, workflow or
  marker at another account. Accounts added or removed in a terminal (`login`, `claude-login`,
  `google-login`, `logout`) are picked up within a few seconds without a restart, and remote hosts
  over SSH tunnels get the new workers too. If the account is paused, rate-limited or removed, the
  turn quietly uses the usual account order rather than failing. They are started like any other
  worker, through a `[[ripple: …]]` marker or as a workflow agent.
- **The "updated" notification opens that version's release notes.** Click it to see what changed.
  After an automatic update the notice now comes from the tray that keeps running, so the click
  still works once the old tray has handed over.

### Fixed

- **The mod band shows each provider's account in use.** Only Claude was narrowed to the account
  being spent; with a second Gemini or ChatGPT account in use, the band kept showing the first.
  The limits pane still lists every account.
- **An open accounts tab in the dashboard follows the router.** It was drawn once, so a Google
  account that started asking for verification kept reading "in use" with no verify button. The
  list now refreshes every 10 seconds while it is open.

## 0.12.30 — 2026-11-05

### Fixed

- **A script's own Anthropic API key is no longer swapped for your Claude login.** Scripts run from
  a Code session's shell inherit its proxy. A `/v1/messages` call on the script's own `x-api-key`
  used to be routed onto your Claude accounts: it was billed to your subscription, and a 429 there
  paused every account for a minute, which made the mod replace named Claude workers with another
  model. Such a request now goes to Anthropic on its own key, unchanged, and its answers no longer
  affect your accounts. Claude Code itself, including on an API key, is unchanged.

## 0.12.29 — 2026-11-05

### Added

- **`#local_…` session links work from the phone.** A desktop session's summary now carries its
  Claude app session id, so Ripple Remote 1.0.11 can follow a link Claude wrote to another Code tab
  session. Older apps ignore the field.

## 0.12.28 — 2026-11-05

### Added

- **Choose the order of the models ClaudeRipple adds to the Claude Desktop picker** (#128, thanks
  @csa906). The Clients screen has an "Order in the picker" card with ↑/↓ buttons; Claude's own
  models keep their place. The order survives provider saves, a provider form no longer brings back
  models you took out of the picker, and two quick picker saves no longer race. Reopen Claude
  Desktop to see a new order.

### Fixed

- **Un-preferring an account moves running conversations back.** Removing the preferred flag used
  to affect new conversations only, so going back from a sub-account to your own login left every
  running session on the sub-account. They now return to the configured order (one cold prompt
  cache each), as choosing a preferred account already did.
- **Ticking a Claude model for the picker no longer hides it from the Model mapping sources** (#128),
  and a model listed twice in `extraModels` shows once.

## 0.12.27 — 2026-11-05

### Fixed

- **ChatGPT image generation works again** (#129). Since 2026-11-04 the hosted image tool reads a
  request's reasoning effort as its new "complexity" setting, which the default image model
  refuses, so every image failed with "Complexity 'low' is not supported". Image requests no longer
  carry a reasoning effort. The subscription backend chooses the image model itself (Images 2.6);
  naming Sunburst or Flare in the request has no effect there.
- **Codex no longer stops with HTTP 400 after a long `exec` that sends `notify()` progress** (#124).
  Codex records two outputs under one call id; they now reach Claude as one tool result.
- **A Windows update no longer leaves the phone host on the old version** (#125). A rename refused
  while another process or a virus scanner held the file is retried, scheduling the host update can
  no longer abort the install, and the router re-requests a host update left at an older version.
- **The current Claude login stays in the account list while the pool uses it** (#123). It used to
  drop out 12 hours after the last un-routed request even when it was serving requests; a 401 still
  drops that exact token. A refused usage lookup keeps the last figures marked stale, and the rate
  limit headers on Claude answers keep them current meanwhile.
- **Old messages no longer pile up on the phone after Remote Control reconnects** (#126). Lines
  Claude Code re-appends under the same ids are recognised and not shown again, also after the host
  restarts, and they no longer disturb running workers or the current plan.
- **Phone photos reach the model in their real format** (#127). The host reads the image type from
  the bytes rather than the phone's label, so a JPEG labelled PNG no longer makes the model refuse
  the turn. The app side of this fix ships with the next Ripple Remote update.

## 0.12.26 — 2026-11-04

### Added

- **The limits pane shows every account you added.** Several Claude accounts each get their own
  numbered tile with the account's name, and the one new requests go to carries an "in use" badge;
  ChatGPT and Gemini accounts are marked the same way. The band's limits row still shows the
  account in use only.

### Fixed

- **A running session moves to the Claude account you make preferred.** A thread continuation
  carried only its new messages, so the pool could not tell which conversation it belonged to: it
  went to the preferred account, failed with `thread_not_found`, and the full replay then stuck to
  the old account. Continuations now follow the conversation that produced them, and changing the
  preferred account moves held conversations onto it (one cold prompt cache each).
- **The Claude limits show the account actually serving requests**, not always the app login, and
  show nothing rather than another account's figures while its usage is unknown.
- **An idle phone no longer keeps the remote relay awake.** With Ripple Remote 1.0.9 (or the web
  remote) the phone proves its connection to the relay with a ping the relay answers without
  waking, and checks the host and reports presence every 60 s instead of every 10 s. Older apps and
  hosts keep the previous behavior.

## 0.12.25 — 2026-11-02

### Added

- **The phone's background-task list names each worker's model**, as the worker's card in the
  conversation does (Ripple Remote 1.0.8 and the web remote). A later update without a model keeps
  the one already known.

## 0.12.24 — 2026-11-02

### Added

- **Red-team reviews have their own worker ladder.** Beside Frontend & design and Backend, the
  dashboard's task domains now include Red team & review, with its own ordered models for light and
  heavy work, so a review falls back to the next model when the first is out of quota. A delegation
  marked `[[ripple: hard review]]` (or `redteam`, `red-team`) uses it; with none saved, the general
  ladder runs. The mod's settings format moved to version 2, so a Claude session still running the
  previous mod cannot save settings until it reloads the mod.

### Fixed

- **Codex tools reach Claude again with Codex 0.166** (#122, thanks @justzz). Codex now declares its
  tools inside the request's input instead of the top-level list; those declarations were dropped, so
  Claude printed `<invoke …>` calls as text instead of running them.
- **The phone's "login was refused" banner clears when the Claude login recovers** (#121, thanks
  @Lahai-Roi). A router check that overlapped the recovery could put the old banner back until the
  host restarted, and could hide a new one the same way.
- **A worker's background commands leave the Agents pane's running list when the worker ends**, as in
  the Claude app.

## 0.12.23 — 2026-11-01

### Added

- **The Compact card lets you choose the summary model for one press.** The dashboard can offer the
  saved compaction model and up to four more. Claude Code's own compactor now handles every choice,
  keeping its recent messages and reattached files; if the chosen model fails before answering, the
  original request is sent unchanged. Automatic and typed compactions use the saved choice.
- **Claude and OpenAI API keys have their own provider options.** A Claude API key serves its own
  named workers, while ordinary Claude traffic stays on the app's sign-in. The OpenAI API preset
  supplies the endpoint and sends a conversation cache key; it has not yet been checked with a live
  key. Metered workers are named separately so a bare model id does not displace a subscription.
- **The remote effort picker can return to Auto** (#120). The phone and browser can turn the mod's
  automatic effort setting back on; choosing a level turns Auto off. An older host does not offer
  the new choice.
- **Windows can set the router's CPU priority in the dashboard** (#117, thanks @115dkk). The router
  and phone host now start at Normal instead of inheriting Below Normal, so other busy processes are
  less likely to delay them. The About page offers four levels and asks for confirmation before High.
- **The tray explains why an update or setup failed** (#116, thanks @115dkk). The dialog names the
  problem and offers an appropriate next step where one is available; the full output stays under
  Details and can be copied.

### Changed

- **The dashboard and tray use reviewed Korean wording.** The dashboard's other five languages and
  the tray translations follow the revised text, and the phone-key rotation warning says that
  notifications end too.

### Fixed

- **The Agents pane stays visible with a long list, and ended commands stop showing as running.**
  It draws at most thirty cards, preferring running work, and reports how many records are left out.
  A background command's end notice in a worker's own conversation now settles its card at once.
- **Native Claude workers use the model IDs Claude Code advertises** (#115, thanks @RedBoardDev).
  Family aliases resolve to their concrete models, and a direct marker no longer sends an `@level`
  suffix as part of the Anthropic model name. Explicit model versions and resumed runs are left alone.
- **Codex custom and namespaced tools reach Claude with their identities intact.** Tool choices and
  results survive translation, while tools unavailable on the current turn cannot be returned as
  executable calls. Supported tool-result images reach native Anthropic; invalid or unsupported
  images are omitted instead of failing the whole turn.
- **A routed conversation's context count no longer jumps while an answer streams.** The router
  scales its estimate using that conversation's last measured input, even when the request shrinks.
  The Context pane labels routed counts as estimates rather than offering a misleading precise count.
- **A picker model's context window can be edited over the Codex catalogue.** A saved choice now
  takes effect; clearing it returns to the catalogue, and an explicit route window still takes
  precedence.
- **The remote shows progress narration and pending settings accurately.** Sentences Claude Code
  writes between tool calls appear in the conversation, and a model or effort change waiting for
  the current answer is reported as pending rather than failed.
- **Windows session images and scratchpad files no longer fail over equivalent temp paths** (#98,
  thanks @115dkk). Short and long path spellings are treated alike, and a folder owned by a trusted
  elevated administrator is accepted; access and ownership checks still apply.
- **Windows purge and tray replacement are safer under load** (#98, thanks @115dkk). The deferred
  purge waits longer for its cleaner and retries receipt reads and writes, avoiding false failures.
  A tray replacement also refuses to overwrite an existing backup.
- **Clicking the macOS app icon opens the dashboard and brings it forward.** A running app now
  handles the reopen, and an unfocused dashboard gets a second chance to come to the front.
- **The laptop page warns when an AlDente setting can make a closed Mac sleep.** AlDente's
  "Disable Sleep until Charge Limit" can clear the same sleep setting ClaudeRipple holds; the warning
  points to "Stop Charging when Sleeping" as an alternative.
- **A chat's cache stays warm across a session-process restart.** The last reply and cache timing
  are restored for the same session and model while the cache is still valid; a clear or model
  change drops the saved state.
- **Auto mode's classifier prompt reaches translated providers unchanged** (#98, thanks @115dkk).
  Provider identity and image hints were being added to its security prompt. A saved route to a
  provider that cannot take routed requests now also produces a warning instead of failing silently.

## 0.12.22 — 2026-10-29

### Added

- **The Auto mode classifier's two stages can each take their own model** (#91, thanks @115dkk).
  The dashboard shows a row for the first stage and one for the rest; a setting with a single target
  keeps working as before. A choice still being saved stays on screen through the five-second status
  refresh, so the last choice is the one stored.
- **Gemini 4 Argon through Antigravity** (#106, thanks @csa906). Cloud Code Assist lists and serves
  Argon only to the Antigravity CLI client, so Argon alone is asked for and called with the CLI's
  User-Agent; every other model and call keeps the IDE profile. Antigravity's terms warning still
  applies.

### Fixed

- **Gemini 4 Argon's separate weekly quota shows in the limits** (#107, thanks @csa906). The quota
  summary under the CLI profile carries Argon's own weekly bucket, which the IDE profile leaves out,
  so the limits no longer show Gemini quota as available once Argon's week is spent.
- **A failed Antigravity CLI model lookup is logged.** When the CLI-profile lookup fails or is cut
  off, the IDE list still answers and Argon used to vanish from the model list without a trace; the
  router now logs the host and the reason (no body or credential).

## 0.12.21 — 2026-10-29

### Changed

- **The limits pane says exactly when each window resets, in the mod's own look.** It was a bare
  table of shares and short reset hints ("6시간 뒤", "수 15:35"). It now sits in the same graphite
  capsule as the context pane: a gauge of the window closest to its cap and how many are at 80% or
  more, then a card per provider account with a bar per window, the reset as a full local date and
  time ("10월 12일 (월) 오후 6:20 초기화") and the time left ("5시간 남음"), refreshed while open. A
  window past its reset, one with no reset time, and Claude's save mode each say so in a sentence.
  The terminal draws the same content as text.

### Fixed

- **The band's limits row lights under the pointer like its other buttons.** Its highlight was an
  empty overlay box, which the app does not draw; the row now uses the same hover style as the
  effort and context chips.
- **The mod preview draws each picture at the size laid out for it**, so the band's controls no
  longer overlap there.

## 0.12.20 — 2026-10-29

### Fixed

- **A recovered provider no longer receives thinking signed by its fallback** (#89, #94).
  Native Anthropic and Anthropic-compatible targets drop signed thinking and redacted-thinking
  blocks known to belong only to another provider, even when the request is no longer rerouted.
  Unknown origins remain unchanged on ordinary requests; reroutes still keep only target-owned
  blocks. Replayed history stays stable across recovery turns and a later fallback keeps its own blocks.

## 0.12.19 — 2026-10-29

### Fixed

- **Windows install, start and repair no longer stop on `Cannot read properties of null (reading
  'pid')`** (#110, #62). Right after the scheduled task was registered, the router lookup printed
  `null` when no router had started yet, and the pid was read off it. An update could leave the router
  off until the next reboot.
- **A worker name keeps the model's capitals as lower case** (#111).
  `deepseek-ai/DeepSeek-V4.1-Flash-1017` is now `deepseek-ai-deepseek-v4-1-flash-1017`, not
  `deepseek-ai--eep-eek--4-1--lash-1017`. Ladder rungs and allow lists saved under the old name move to
  the new one, a marker that still says the old name resolves to the same model, and the old generated
  worker file is removed. A hand-written worker that happens to use an old name, and a name that is
  some declared model's id, are left alone.
- **`wire: google` models use the provider's key pool** (#112). They sent the first key only, so a
  spent key answered 429 to every turn. Keys are now picked and rotated like every other wire, with
  `KEY`/`RETRY` lines and the `credential` field. Google's invalid-key 400 also rotates, the last key's
  `Retry-After` is kept, and every key sent on a request (and Antigravity's tokens) is masked in
  streamed errors, logs, exceptions and the request record. Single-key providers send what they sent.
- **Responses-wire reasoning that arrives only as text is passed back** (#109). Reasoning without
  `encrypted_content`, and a completed item addressed by `output_index` alone, were not carried to the
  next turn. A `content[].thinking must be passed back` 400 now logs the assistant turns' block kinds
  and counts (no content) and tells the client not to retry it.
- **A retired model is skipped instead of picked again** (#94). An explicit `ModelDeprecated` / "has
  been deprecated" 404 or 410 marks that provider's model unusable, the ladder skips it with
  `model_deprecated`, and `/api/status` shows it. A config change for the provider or a success from
  the model clears it.
- **A running worker moves to the next rung of its ladder when its provider is exhausted** (#89).
  After the router records the worker's target as exhausted or retired, the worker's next request goes
  to the next usable rung of the same tier, logged as `LADDER pick=… A → B reason=…`. Only the ladder
  snapshot the mod writes at the start of the spawn prompt is read, and every fallback must still be on
  the saved ladder. Thinking blocks another provider signed are not forwarded on a reroute; the target's
  own are kept. A fresh key added to an exhausted provider clears its exhaustion.
- **The Desktop handoff waits for running background workers** (#114). Handing a session to the app
  stopped the host's SDK and killed a worker still running; the handoff and settings restarts now wait
  for the live query's background tasks, and a worker the app reports `stopped` shows as stopped on the
  phone.
- **The phone no longer shows a stored permission mode as the app's** (#113). After a handoff the
  mode is omitted rather than claimed, `/clear` and `/new` keep the session's own choice (a desktop
  session's latest one), and a model or effort change waiting on a background task is reported as
  pending instead of applied.
- **A question card no longer reaches the phone ahead of the text before it.** The Remote Control
  permission stream could beat the transcript watcher, so the assistant's preamble arrived after the
  card.

### Known

- When a provider recovers after a reroute, thinking the fallback signed may still be sent back to the
  original provider. This predates 0.12.19 and is fixed in 0.12.20.

## 0.12.18 — 2026-10-28

### Fixed

- **A model saved with `"contextWindow": null` gets its catalogue window too.** The catalogue
  backfill and the new-provider check filled only a missing field, so a config that stored the blank
  as `null` (Hive's models in a real config) kept running on the 258,400 fallback after 0.12.17.

## 0.12.17 — 2026-10-28

### Fixed

- **A routed model compacts within its own window, not at the global setting.** With
  `autoCompactWindow` set in settings.json, Claude Code used it for every model and treated the
  per-model windows the router sends at bootstrap as defaults only: a slot routed to GPT-6.1 Sol
  (475K) compacted at 600K, past what Sol accepts. The router now writes
  `modelSettings.<model>.autoCompactWindow` for each routed model, the smaller of the model's window
  and the global setting, which Claude Code honours over the global value. Native Claude models are
  left to the global setting. An entry the person wrote themselves is never touched, entries for
  models no longer routed are removed, and uninstall removes only the unchanged entries it wrote.
  Changes to the global setting are picked up within 15 seconds.
- **The phone and the band show the window the session actually compacts at.** The phone showed a
  1M Claude session against 1M while the Desktop app said 600K, and the band's fallback used the
  global setting for every model. Both now read the router's per-model effective window from
  `/api/context-windows` (`compactWindow`); the band still prefers `/context`'s own figure.
- **A provider that does not report context sizes gets them from the model catalogue.** Hive's
  `/models` lists ids alone, so its models fell back to `cli.autoCompactWindow` (258,400) even where
  the same model has a published window. A blank window is now filled from models.dev when the id,
  without its organisation prefix and, failing that, its build stamp, matches a catalogue model
  exactly; where providers disagree the smallest window is taken, since a reseller may serve less.
  A value set by the person or the vendor is never replaced.

### Added

- **The Models tab says when a model's context size is unknown** and which fallback it runs on.

## 0.12.16 — 2026-10-28

### Added

- **A session the phone creates on a folder saved as an environment now starts in the Claude app**
  (#102). Such a session ran its first turn on the host and was then handed to the app with
  `--desktop --resume`, which the app imports with Remote Control off, so every later turn stayed
  invisible in the app until a restart. When the folder is one the person saved as an environment, the
  host now creates the session on that environment as Claude's own phone app does: the app picks it up
  in about three seconds, starts it and attaches Remote Control, and the first message goes through
  the bridge once the worker has attached. Only a definite refusal (no matching environment, no login,
  a 4xx) falls back to the old path; a lost answer, a 5xx or an attach timeout holds the first message
  as failed rather than risking a second session.
- **A phone message to a session the app holds runs in the app, and its turn shows on the phone**
  (#102). A session open in the app without Remote Control answered every phone message with "turn on
  Remote Control", and a handed-off session ran the message on the host, where the app never showed it
  until a restart. The host now offers plain text to the mod inside the app's own CLI process, which
  types it in as the person's prompt, and tails the transcript whenever it is not running the session,
  so turns typed in the app reach the phone too and the mod's prompt shows once whichever arrives
  first. Attachments, slash commands and interrupts still get the blocked answer, a claimed message is
  never also run on the host, and a claim that never arrives is reported failed after two minutes,
  with a notice that says to resend or delete the message.
- **The phone's model and effort are kept as the app's own record for the session.** The app keeps each
  session's model and effort in its own record and re-applies it when the session is opened, while a
  phone's `set_model`, effort control or in-session `/model` changed only the running CLI, so a
  phone-picked model was lost the moment the session was opened on the Mac. A phone change now also
  asks for the app's record to change, through a job the mod in another app session claims and applies
  with the app's own tools, and only while that session is in bypassPermissions since the app would
  otherwise ask the person to approve. A change made in the app shows on the phone at the next poll, a
  phone change still on its way is not undone by the app's older value, and when the app could not be
  changed the phone keeps its choice and says what to check in the app. A Mac, whose sidebar names no
  root, now builds the record reader anyway, so the sync is no longer off in production.
- **The tray sets the laptop's stay-awake mode.** Changing the mode or the hotspot failover meant
  opening the window and going to Laptop settings, which is what people skip on their way out. The tray
  now reads `GET /api/power` with each healthy poll and shows a submenu with the current mode in its
  label: the three modes as radio items, the hotspot switch and a shortcut to the Laptop page, or to
  setup when the sudoers rule is missing. A mode picked there has no end time, so it clears one set in
  the dashboard; routers without the API and Linux show nothing.

### Changed

- **A model id can name the provider that should serve it, and a shared id no longer deletes
  workers** (#94). When two providers declared the same vendor id, the router wrote one worker per id,
  so adding a second provider deleted the first's worker, and a bare duplicate gave no way to say
  which subscription should pay. A `<provider>:<modelId>` marker now selects that provider only when
  the prefix is a configured provider that declares the remaining id, and the upstream receives only
  the model id; anything else stays a model id, so Ollama's `qwen3:8b` is unchanged. The first
  outbound provider in config order keeps the plain worker name and later ones take
  `<name>-<provider>`, every duplicate worker carries a qualified `model:`, single-owner files stay
  byte-identical, and quota is checked by the worker's own provider and id, so a spent Google key
  falls through to the OpenCode Go worker for the same model. A duplicate that stays ambiguous is
  refused with its qualified alternatives rather than guessed or sent to Anthropic.

### Fixed

- **An interrupted worker stops showing as running** (#108). A background agent stopped during a tool
  call can leave no task notification, so the phone kept its card running forever. The worker's own
  complete transcript now supplies an exact final interruption marker as proof of stopped, background
  history is reconciled, and parent and nested snapshots refresh when a worker's record changes, while
  a normal final answer still completes as before. Nothing is inferred from elapsed time, a parent's
  interruption or completion, a missing inventory or a failed Task Stop, and a partial append, quoted
  marker or resumed transcript stays nonterminal, preferring a missed stop to a false one.
- **A Windows update no longer takes its own router for another installation** (#100). The headless
  scheduled task starts conhost before PowerShell, so the router is a grandchild rather than a direct
  child, and the identity check found no router of its own. The lookup now walks the launcher's whole
  subtree from one process snapshot, without weakening task ownership or accepting an unrelated
  shared-runtime router; an unreadable PID discovery still yields nothing.
- **A Codex request to a Claude model no longer needs a Claude Code version the router never saw**
  (#103). The fallback `user-agent` was pinned to `claude-cli/2.1.266`, and Anthropic refuses a model
  to a client below a version floor it raises over time, so Opus 5.5 answered "version 2.1.280 or
  newer is required" on a machine whose Code tab never passed through the router. The fallback now
  takes the newest version the machine can vouch for: a recent observed Claude Code request, else the
  newest CLI the Desktop app has cached, else a constant updated to 2.1.304. Headers from an observed
  request are still replayed exactly.
- **Codex's `/compact` reaches a Claude model as a request it accepts** (#104). The remote-compaction
  body ends with a control item that the OpenAI ingress dropped as unknown, so the assistant's turn
  stayed last and Anthropic answered "This model does not support assistant message prefill." The
  trigger now becomes the user turn that asks for the summary, with every earlier item passed through
  unchanged, and a transcript that ends with the assistant for any other reason gets one short
  "Continue." turn. Both land before the cache breakpoint is placed, and the Claude Code path is
  untouched. Codex then expects exactly one `compaction` item back: the summary now comes back as
  that item, in a format only the router reads, and when Codex sends it with the next turn the
  router restores it as user text in place, so the conversation carries on from the summary. A
  compaction item that OpenAI produced is still dropped, now with a warning in the log.
- **Workers on one account no longer pile onto one key, and the log names the key that answered**
  (#101). Every worker of one person injected the same opening text, so the conversation key collided
  and one secondary key's claim was renewed indefinitely; the key is now captured before routing so
  agents, sessions and full opening messages separate, while metadata-less side requests keep their
  shared affinity. A healthy conversation stays on its key rather than switching back when an earlier
  key recovers, since a warm cache is worth more than config order. The credential records the
  responder's label or ordinal, an OAuth account by ordinal rather than its email, selection reasons
  and retries are logged without runtime ids or tokens, and the measured relay `server_error` "Global
  regions" 400 is read as a workspace-key refusal, rested briefly and tried on another key while
  ordinary 400s still stop.
- **A Claude worker whose prompt starts with a delegation marker still passes through** (#94).
  Refusing ambiguous markers on Claude requests dropped the old rule that a `claude-*` request is
  never refused, so a worker whose prompt began with `[[ripple: standard]]` or `[[ripple: opus@high]]`
  was answered "not an alias and not an agent name". A Claude request now passes through unless its
  marker names a model two providers declare.
- **A handed-off phone session keeps going while the app is idle** (#102). After the app adopted a
  phone session for its list, every next phone message waited for Remote Control, which the app never
  turns on for a session it adopted, and the session had forked once when a host process kept between
  turns answered from its own last line while the person typed in the app. The host now resumes a
  session it started and handed off when the app's registry entry, read fresh, says idle, and queues
  the message with its own notice while the app runs a turn, across host restarts. It lets its SDK
  process go after each turn while the app holds the session, so every phone turn resumes from the
  transcript.
- **A phone message runs with the settings picked before it, and a late change cannot undo a newer
  pick.** A message sent right after a model or permission pick could run with the old one, "send now"
  could wait for changes picked after it, and a change that hung held every later one forever. Each
  session now has one queue in which every setting change, direct send, "send now" and queue drain
  takes one place with one deadline of fifteen seconds from when it starts; an expired place lets the
  queue move on and invalidates its token, checked before every outgoing call, so an overtaken change
  never reaches the session. A message already handed on still records its receipt after the deadline,
  and a Stop, a removal or the app taking the message during a wait is reported rather than passed
  over.
- **A handed-off session's queue settles once the app has answered** (#102). A mod-delivered message
  left an "awaiting" mark that only a result event clears, and an app-run turn writes none to the
  host's log, so the next message sat in the queue while the app was idle and pressing send ran it on
  the host. The mark is now dropped, the host writes the app's own running, waiting and idle state for
  a handed-off session it follows so the phone shows when the app is working, and a short app turn
  between two polls no longer leaves a stale mark, which also clears old ones left by an earlier
  build. A stop from the phone on a session the app is running now says to stop it in the app instead
  of reporting a stop that never happened.
- **A page of history belongs to the log it was read from, and a rebuilt log gets a fresh tail.** A
  phone or browser asked for the page before a sequence number of one epoch, the host rebuilt the log
  as another meanwhile, and it answered with the new log's page, so the reader merged its past under
  the old recent events; the web client also lost a stretch of history for good after a fresh tail and
  dropped loaded pages whenever a same-epoch tail arrived. The request now names its epoch and the
  answer names the one the host read, a mismatch gets no page and a fresh tail, and a read that
  rebuilds the log tells every attached reader. A phone's cursor carries its epoch, so a rebuilt log
  sends the new tail with `hasOlder` instead of a slice of it, and a phone already at the last
  sequence gets an empty frame so its saved copy knows it is current.
- **A slow connection no longer queues a tail for every update.** Ten desktop updates on a slow link
  queued ten 260 KB tails, and eight session lists grew the buffer from 1 MiB to 2.1 MiB while the
  held tail never left. A tail now waits until the buffer drains, one per session, and the newest
  snapshot goes out then; a backed-up connection gets only the newest list once it drains. A detach or
  close clears what was waiting.
- **A Code tab plan finishes when its turn wraps up.** The Code tab checks its task list off when a
  turn calls `wrap_up`, so a turn may end without a last advance, and the phone kept such a plan at
  "step 1 in progress, 0/3" after the turn had ended. A successful `wrap_up` now completes the
  per-turn plan; session-scoped `TaskCreate` and `TodoWrite` lists are left alone, and a `wrap_up`
  from a retired turn cannot finish the next turn's plan.
- **A released closed lid sleeps again.** Releasing the lid-closed hold ran `pmset sleepnow` whenever
  `ioreg` said a closed lid causes sleep, which on 2026-10-26 overrode an Amphetamine session and audio
  playing at the desk; the first fix left the Mac to idle sleep when another process held a
  system-sleep assertion, but Amphetamine's indefinite session and powerd's "display is on" were taken
  as such holds though they do not stop lid-close sleep, so on 2026-10-28 the Mac ran on battery from
  55% to 11%. Only `PreventSystemSleep` now counts as another process's hold, the closed Mac driving a
  TV is caught by reading attached external displays from `ioreg`'s framebuffers instead, and battery,
  heat and a failed guard read still sleep the lid.
- **The band leaves room for other mods and loads under strict plugin validation.** The dashboard
  band, the alert cards and the settings and setup cards returned their own tree without asking for
  what another mod drew above the prompt, so that drawing vanished; every path now asks for it once
  and puts ours under it, and the engine's bare answer is left out so the band looks the same when no
  other mod draws. Claude Code 2.1.310's strict plugin validation also rejects an inline import in the
  state contract, which is now named from the surrounding module scope instead.

## 0.12.15 — 2026-10-26

### Added

- **The band's Compact has the chat tidy up before it summarises.** The press sends a turn of its
  own that asks the chat to say what it has done and what is left, note its decisions and update any
  handoff or memory file; the prompt and the answer stay in the transcript and the summary is built
  from them. The switch beside Compact is on until turned off, and with it off the chat compacts at
  once as before. The prompt reaches the model as the person's own words rather than as a message
  from the plugin, a press whose prompt was dropped sends it again instead of leaving the button
  dead, and a turn that is stopped or fails compacts nothing and says so.
- **The limits row opens a pane that says when each plan window resets.** The row is a button now,
  lit under the pointer, and the pane lists every provider account's windows with the share used and
  when each resets: the time left while a window is close ("2시간 뒤"), else the weekday and the
  local clock ("목 09:00"), and "초기화 중" once it has passed. Pressed again or closed, it goes,
  and its press takes no width from the row; each window's own hover tip gave way to the row's one
  hint.
- **A Fast request is marked FAST in the band's log and the dashboard** (#97). Telling which GPT
  requests burn the subscription faster meant opening `requests.jsonl`, since a Fast request looked
  like any other row. The band's log shows FAST in the accent colour after the effort on a row's
  second line, the dashboard puts an outlined FAST badge after the provider and a "requested tier /
  served tier" line in the expanded detail, and the mark follows the requested tier because the
  ChatGPT sign-in often serves "default" for a Fast request.
- **The dashboard's Status page names each problem and the step that clears it.** Readiness listed
  codes only the tray explained, so an untrusted certificate or a missing Desktop proxy entry looked
  like a dead router. The page now words each problem, including a config that failed validation and
  was adopted anyway (status carries the errors and `/readyz` answers 503), and offers a diagnostic
  copy of versions, states and provider names that never carries a key or a header. Provider calls
  bypass a company proxy in the environment, so diagnostics name the proxy variables that are set
  without their values and say upstream connections ignore them. An update that started and failed
  now shows its reason with a retry, modal dialogs keep Tab inside and put focus back where it was,
  and every dashboard language carries every key.
- **The browser remote's session list folds, pins and searches its projects.** Sections fold to
  their name and count (the archive starts folded and opens in place), pinning lifts the Desktop
  app's stars and this device's own pins into a section of their own, and a search reaches every
  segment of a session's working directory. One page of rows draws at a time with a "show more" row,
  and each row's menu offers archive, pin and mark unread, disabled with a reason while the computer
  is away. A search with no list to look at says so, and is never shown as "nothing matched".
- **The browser remote shows what a session changed, and asks for uncommitted work or the branch.**
  The session header opens the same pane the phone has: the uncommitted/branch switch where the host
  offers it, each file with its line counts, and one file's whole patch over the list with git's
  headers left out and copy of just the change. Previous and next walk only the files that have a
  patch and are disabled at the ends; the list and the open file keep their scroll, and Escape
  returns focus to the header button it was opened from.
- **A session's folder can be read from the phone, one small file at a time.** A new pair of request
  ops lists the folder and reads one file of at most 1 MB, always resolved against the session's own
  cwd: absolute paths, `..` and symlinks that lead outside are refused after realpath, a larger file
  is reported with its size, dotfiles are left out, and the host advertises the capability so an
  older app sees nothing new. The folder sheet now lists the drives at the top of every browse
  (leaving out the one being browsed, cached for half a minute) and takes a typed path, so a folder
  that no longer exists comes back as an error instead of an empty list.
- **The browser remote keeps your place in a conversation as it grows.** Answers can be copied from
  a control named for screen readers, an answer the host moved into a blob is read to its last page
  first, and a refused clipboard names the browser's refusal instead of claiming a copy. A selection
  made while the answer streams is carried across the redraw by character offsets, an opened thinking
  block or tool detail stays open when its row is redrawn, earlier pages load by themselves one at a
  time with a deadline, a refusal or a dropped connection offers the reader's own retry, an empty page
  ends the asking, and a conversation opens again where it was left rather than at its end.
- **The phone and the browser draw a command, a finished turn and a decided plan as what they are.**
  Compaction, a fresh start and a rewind are drawn as their state — running until the turn they
  started ends, then done or failed — in one quiet row with no control on it, while an unknown slash
  command is left to the host and drawn as words. A finished turn names itself ("턴 3"), but only
  where the conversation's first page is loaded. A completed plan card reopens read-only, a late or
  replayed acknowledgement from an old turn no longer restores a plan, and Code and provider plans,
  TodoWrite and TaskCreate/Update/List now share one successful-result reducer, so a reconnect or a
  completed turn no longer hides outstanding work.
- **A question with several parts keeps your drafts and submits once.** The browser's sequential
  prompts became navigable question cards with full option previews: drafts are scoped to the
  session's epoch, custom input is kept exactly, single and multi-select contracts are enforced, an
  incomplete or duplicate decision is blocked, fields being edited stay stable while chrome updates,
  and keyboard focus returns after a selection.
- **Background work and worker conversations stay visible on the phone and the browser.** Commands,
  monitors and scheduled wakeups left running while the main turn is idle are listed with SDK Stop
  inventories (PR and CI subscriptions included), stopped and failed workers are told apart, and an
  unknown state is kept when no authoritative inventory exists. A worker's open conversation follows
  its steps, asking only for what came after the last one and reading the launch instruction once,
  and a nested worker keeps a return path with its frame's position and tool state.

### Changed

- **The Logs summary counts a period's tokens once per conversation.** Adding every request inflated
  the total, and subtracting cached input failed after a cache loss or a provider translation. The
  summary now has a tokens chip counted the way the Agents card counts — the last whole prompt per
  conversation plus every output in the period, from persisted conversation identities —
  while the input and output chips keep the split and the request-volume counters are unchanged;
  older logs fall back to independent-request counts. The request row reads the whole prompt in its
  input cell with the cache's share on a pill and the output in a cell of its own. Usage is read only
  from the response's own top-level object, so usage embedded in a tool input or in response text
  cannot inflate a count.
- **The Agents card reads like the app's task list and counts tokens as the app does.** Every step
  re-sends the whole conversation, so summing each step's input ran to millions; a worker's tokens
  are now the last response's whole prompt plus every response's output, and a finished worker takes
  the larger of that and its last response's own count. The card is a one-line title the engine cuts
  with an ellipsis, with the time and a chevron at its end, then the model's name with its effort,
  then tokens, cache and tool count; the time's colour carries the state, a four-digit tool count
  reads 1.2k, the cached share rounds down so 99.96% reads 99%, a whole card opens its conversation,
  and a background task's card follows the same layout. The empty pane now says that background
  commands and watches appear there too.
- **Every pull request is typechecked and tested on macOS, Linux and Windows.** Linux and Windows
  run non-blocking until they pass, since the suite has only been run on macOS. CI also parses every
  mod file, resolves its relative imports and checks that `hooks.json` and `plugin.json` name files
  that exist, without executing the mod or fetching the engine, and the publish workflow packs the
  tarball, installs it into an empty prefix with scripts disabled and checks the files an install
  runs, so a missing `dist/` cannot ship.

### Fixed

- **Claude Code's mid-conversation system messages are folded for compatible vendors** (#92,
  OpenRouter). Claude Code 2.1.308+ puts SessionStart hook context and deferred-tool deltas in
  messages with role "system" carrying `tool_addition` and `tool_removal` blocks; only top-level
  fields were cleaned, so a vendor's Anthropic skin refused every turn with a 400 once a hook or a
  deferred MCP tool was in play. Such a message becomes a user turn with its text byte-for-byte; a
  `tool_addition`'s definition joins tools through the same loop declared tools get and is appended
  after them so the cached tool prefix does not move, a `tool_removal` goes with its block, and the
  request log counts each fold.
- **OpenCode Go's spent plan is read as a spent plan, and delegation skips it** (#95). The service
  answers a used-up subscription window with a 429 whose body says "Go usage limit exceeded" and no
  retry header, which the classifier read as a temporary rate limit: the worker retried the same 429
  for minutes and the next delegation chose the same provider. The pattern now carries the plan's
  own phrase with a per-minute/hour guard, and the ladder leaves out a provider whose every key has
  a window at 100%, naming its reset as `exhaustedUntil`, so the next delegation does not spend a
  429 on it.
- **OpenCode Go's `gemini-4-argon` runs on its Google wire** (#94, in part). The listing no longer
  carries `gemini-4-argon-contributor` and carries `gemini-4-argon` instead, but a model picked from
  the listing saves only its id and name, so without a preset row it inherited the preset's
  Responses wire and the vendor refused it with "Model does not support this protocol". The row is
  written out as the wire is published per model, not per family.
- **A session read on the phone no longer keeps its unread dot** (#96). The dot comes from the
  Claude app's own Local Storage, which the host only read; clearing attention never told the list
  the phone had read the session, so a session opened on the phone stayed unread forever. The host
  now records the activity the phone read per session and reports unread false once that record
  reaches the sidebar's last activity; anything newer is unread again, mark-unread forgets the
  record, and records for sessions that left the list are pruned. Writes stay rare: only a dot
  actually shown is recorded.
- **A web search the router serves itself is logged under its own model with usage.** It was logged
  with the target's name and no usage, so the model table showed a phantom model with zero tokens
  (126 requests in a week). The record now names the model the search ran on, keeps purpose
  "web-search" and carries the backend's usage; the model table and recent requests key rows by
  purpose, tag them "web search" with the help note worded as the page's other notes, read older
  provider/model records with no tokens as the same row, and hourly buckets write purpose.
- **The tray stops replacing itself, and an update leaves the dashboard as you left it** (#93).
  Started as `electron main.js`, the tray read Electron's own version instead of its package's, so it
  saw a newly updated router on every poll and replaced itself about every two seconds; the version
  now comes from one function, and a pair that never converges is counted in
  `~/.clauderipple/tray-replacement.json` — after three launches the tray stays up and says why once.
  A replacement is now started as a login launch and shows the window only when it was up before, so
  an automatic update no longer brings a closed dashboard to the front, and `clauderipple update`
  refreshes the fetched Electron into a staging folder before moving it over.
- **A pinned ClaudeRipple shows our icon instead of Electron's.** macOS keeps a Dock pin by bundle
  path and draws that bundle while the app is not running, so the running tray could only paint our
  icon over Electron's atom. macOS now runs `tray-runtime/ClaudeRipple.app`, a copy of the fetched
  Electron with our name, identifier, icon and an ad-hoc signature, rebuilt on every refresh and
  falling back to plain Electron if the build fails. A pin that already points at Electron.app
  cannot be rewritten by code: unpin it and pin the new bundle.
- **The tray waits for a slow but valid answer and labels a quota by its real period.** After a TCP
  connection it took any quiet moment for a dead router, and every primary quota window was labelled
  weekly. Readiness now uses the router's own answer, and a quota window is labelled by the period it
  actually covers.
- **Uninstalling a second installation no longer takes the real install's setup.** The release check
  installs under its own home and port, but its uninstall removed the Claude Desktop proxy and the
  Codex provider whatever they pointed at, deleted the keychain's CA by name (the real install's has
  the same one) and removed worker files the real install had written. A home other than
  `~/.clauderipple` now removes only its own: the proxy and the Codex provider when they point at
  its port, its CA by fingerprint, and worker files the default home's manifest does not record;
  `picker off` and `direct on` follow the same rule, and `direct on` keeps a Desktop proxy the
  person wrote instead of refusing it.
- **Install and uninstall act only on what this home recorded.** Every install on an account shares
  one launchd label, systemd unit and task name, so a definition is not proof of ownership: acting on
  one now requires the home it records, an unreadable one is preserved and reported, and a launcher
  that records this home is adopted while a malformed marker stays unknown. A service that is already
  stopped reads as removed rather than a permission error, a control that fails leaves the definition
  in place, and the Windows phone host is started and stopped through its own runtime home with only
  an explicit success counted. A value in `~/.claude/settings.json` is removed only when this home
  recorded it and no other home records the same value, a file that is not a JSON object is refused
  so its other keys are never dropped, and a worker file is removed only after every shared claim was
  read. A legacy entry an older version wrote without a marker is taken over only on independent
  evidence that it is this home's, and an ambiguous or unreadable one stays untouched and reported.
  A restart also waits for the relaunched router to answer before judging it, so a healthy restart is
  no longer reported as unverified.
- **A direct switch keeps what it can prove and refuses the rest.** A direct transition accepts
  Claude Code's own opus, sonnet and haiku aliases and refuses a shared routed slot before changing
  either client, so a preserved model cannot become a broken direct connection. CA removal fails
  closed when its fingerprint or the trust store cannot be read, and a certificate whose trust
  settings outlived it in the keychain no longer reads as trusted.
- **Uninstall removes this installation's phone host and says what it cannot take back.** The phone
  host is a second account-wide service, and uninstalling left it running against files about to
  disappear; it is now read first and stopped and removed only when its definition records this
  installation's home, while another home's host, or one that records none, is reported and left
  alone (an explicit `remote uninstall` may still take an unrecorded one). Uninstall names the
  sudoers grant `awake setup` installed, the PATH line the installer added to the profile and any
  remote SSH hosts still configured, and the context cap it wrote is claimed like a model slot so it
  takes back exactly its own value.
- **An interrupted install keeps the old runtime, the command and its lock.** `install.sh` deleted
  the runtime folder before unpacking Node into it, so a failed download, extraction or a full disk
  left neither; the archive is now unpacked beside it and swapped with two renames, the previous
  runtime is put back if the swap fails, the command wrapper is renamed over instead of removed
  first, a backup that cannot be deleted is reported while the run continues, and Node is rolled
  back until npm and its wrapper succeed. Service locks are claimed with an atomic directory holding
  its owner's identity, published only once that owner exists, and reclaimed only after that exact
  process exits — a failed process lookup is not read as one — so a crashed controller no longer
  blocks every later run; empty or damaged legacy locks are kept and their manual recovery is named.
- **An Ollama model takes its thinking levels and context window from `/api/show`.** Its
  OpenAI-compatible surface reports ids alone and ignores `reasoning_effort`, so the probe measured
  every thinking model as taking none, wrote `[]` to the config where an empty ladder means a
  decision, and the model kept showing no effort steps and no context window. Providers on
  ollama.com or the local daemon are measured through `/api/show` first, an empty ladder on Ollama
  is treated as blank rather than settled, and a ladder someone set is never replaced.
- **A cancelled turn is not counted against the provider, and a finished stream ends at once.** A
  person's cancellation was recorded as an upstream failure and interrupted delivery as a completed
  one; cancellation is now kept out of global upstream health, interrupted delivery is recorded as
  aborted, and a translated stream completes at its protocol terminal with the usage before it
  instead of waiting for EOF.
- **A macOS host no longer stalls for seconds on every session list.** `Sessions.list` asked whether
  each closed Claude app session was open, and on macOS each ask ran a synchronous `ps -axo
  pid,command` — dozens per list, every poll and every phone update, stalling the host for 5 to 14
  seconds: phone pushes went out late, relay pings ran late, and Remote Control state reads and the
  away probe timed out behind them. macOS now reads one snapshot at start and refreshes it in the
  background every five seconds, as Windows already did.
- **A session's folder and times read as the phone shows them.** A Windows host's cwd was split on "/"
  alone, so a session row showed the whole path instead of the folder, and a home folder was only
  abbreviated when the string matched exactly; both separators and drive-letter case are handled now.
  The clock follows the phone's 12/24-hour and language settings (HH:MM only as a fallback), and file
  sizes read in KB/MB with a decimal only where it distinguishes something.
- **A phone message arrives whole, once, and from the computer that owns it.** A long host message is
  transported in bounded UTF-8 chunks and reassembled before delivery while older clients keep
  their wire contract, an attachment up to 8 MiB is validated with bounded checks instead of
  recursive matching, and a reused message id carrying other words or attachments is refused with a
  sentence the phone can show instead of being answered as a success that never ran. A handoff input
  is kept in the host queue with its original id and photo bytes until a session can receive it,
  recovered across a restart without a second writer and retried within the existing three attempts,
  while an explicit Stop still holds. Queues are bound to the pairing identity so a replacement host
  does not receive the previous one's unsent messages, refused originals stay readable and copyable,
  and a native push now names the sending host so a tap cannot open a session in the wrong pairing.
- **A phone's connection recovers once, and its figures follow the model it is routed to.** A socket
  left healthy after a background suspension was replaced on every foreground, and a probe that went
  unanswered left the phone waiting. Healthy sockets are kept, recovery starts within three seconds
  of an unanswered probe, there is one retry and countdown chain, and superseded sockets and stale
  callbacks are closed so a stop cannot revive an old timer. A turn's text now closes at response,
  approval and lifecycle boundaries, so a later running turn cannot revive an old cursor; a
  session's context capacity comes from the routed model rather than a stale SDK cache and is
  dropped on a model or epoch change; a conversation started after `/clear` keeps its title, stale
  attention is retired when desktop work resumes, and a failed desktop credential read is retried
  only within its window.
- **The band draws at the app's own type again.** Since the app's newer type sets a cell at about
  8.8 px, pictures sat in gaps wider than themselves, the sea ended short of the capsule's right
  edge, fewer facts fit and the route shrank to "Op…". Each picture now fills the cells laid out for
  it whatever px a cell is, icon slots are the pictures' exact width, the facts and Handoff pill sit
  half a cell from what they show, and a counted icon draws its badge only while it has a count. The
  work current runs along the capsule's true bottom and no longer restarts on a redraw, and the
  limits row keeps its height under the pointer.
- **The Agents pane keeps live workers and stops re-reading what cannot change.** The forty-record
  limit applied to running workers too, cutting live cards off from their counts and usage; it now
  bounds only finished ones. A long command stays in the running state instead of turning amber
  after eight seconds, queued coordinator follow-ups are shown in the agent's conversation, the
  instruction is recorded beside its delivery so a slow read cannot delay it, `/clear` no longer
  empties the Agents list, a finished conversation is read once per state instead of on every
  redraw, an open conversation no longer redraws on the clock, a tool-run line presses and lights
  along its whole width without flicker, and an agent's page keeps its head at the top while
  scrolling.
- **A worker runs on the definition and policy it was prepared with.** Switching auto to
  general-purpose discarded the Agent tool restriction, so the registered definition is kept and
  only its model is overridden, with the picked effort applied to the executor too. A managed worker
  whose routing policy cannot be prepared is refused rather than run on unchecked input, engine-owned
  agents stay independent, and an empty or incomplete rule reason is refused. A current router
  outage now shows over historical routes, and context counts are bound to the model, capacity and
  context generations so a late response cannot overwrite them after a clear, resume or compaction.
- **A Handoff answer from a chat that was cleared is dropped.** A fork outlives `/clear`, so its
  answer came back to the new chat and opened a session there with the old chat's note. Each press
  now carries a run id and the chat generation it started in, and an answer that lands elsewhere is
  dropped without a toast or a failed card.
- **The dashboard keeps your edits and clears what a removal leaves behind.** Removing a provider
  left the web search, the Auto-mode classifier and other routes' fallbacks pointing at a provider
  that no longer existed, which the config check refuses; the removal now clears them, the provider
  page lists every place it is named, and the confirm says what else will go, while the Clients page
  shows each route's fallback chain. A config or catalogue change rebuilt the picker rows and
  replaced a context window being typed: typed text is carried over the rebuild with its caret and
  saved on the next change, a Grok model typed before the first listing is no longer unticked, only
  edited mapping rows are rebased, changed controls are no longer rebuilt during status polling, and
  a success notice no longer masks a partial-save warning.

## 0.12.14 — 2026-10-24

### Added

- **The band's Handoff is back as one button.** The session's own model writes the resume note in a
  fork, so nothing is sent to this chat and it is never cleared. A new Code session then opens in
  the same folder with the note in its prompt box, waiting for Enter; a note past about 12,000
  characters goes to `~/.clauderipple/handoffs` and the box says to read it. A fork that fails says
  so, and the advice judge and settings removed earlier stay removed.
- **Delegation no longer uses a second model to choose the worker** (#90). The session writes the
  tier and domain on the first line and the owner's ladder names the model, while the effort judge
  stays. A model is named only with a `Model reason: user "…"` or `Model reason: rule <file>` line,
  which the mod checks and never reads as language: a missing reason, a quote the owner did not say
  or an unknown name is refused and the session is told why, and the reason line never reaches the
  worker. Nothing usable on the rung or the one above is refused with a toast instead of running on
  the session's own model. With the takeover set to ripple:auto, a worker called by name, or
  general-purpose on a model, runs as called; only All spawns checks those calls for a reason. The
  dashboard's help for the setting now says so.
- **A model pinned in the owner's own words stays for the session.** "앞으로 솔로" or "솔로 고정"
  adds a top row to the band, "위임 고정: Sol", with the sentence that pinned it and 해제 at the
  end; the hover card is gone since the reason is now in view. A sentence that only mentions a
  model no longer pins or unpins, an exact id beats a family word, and a family alone takes the
  generated worker, else the newest version. The owner's words for this task outrank a pin, and a
  pin outranks a written rule.
- **A ladder's rows mean difficulty again, and `ui` is asked for only where it is needed.** Light
  and standard run on the light row, hard and plan on the heavy one, and rows stored under either
  split read right. The `ui` domain word is for visual design, a new screen's layout or UX
  decisions; restoring, porting, wiring or translating existing UI code takes no domain word. The
  dashboard folds and edits the rows the same way, and its hints say so.
- **The Agents pane lists background commands and watches beside the agents.** A command left
  running, one that times out and a Monitor watch each get a tile in the same capsule, with what it
  runs and how long, and end with their status and exit code; TaskStop ends one at once. An agent's
  card asks for the Claude app's own agent view where the host draws one and, on the desktop, opens
  the pane's conversation, now in the app's layout: the prompt in a grey card, words as paragraphs,
  each run of tool calls one quiet line worded as the app words it. The tile list keeps the
  capsule's totals and figures, and the phone words the same run the same way.
- **Pressing the band's context chip opens a context breakdown pane.** The grid and legend are
  measured against Claude Code's compaction window rather than the model's, then memory files, MCP
  tools by server, skills and agents follow, each capped with a "more" toggle. It opens on the local
  estimate, "다시 계산" recounts with the token-count API, and Escape or another press closes it.
  The chip's tip now carries the same press, the chip lights under the pointer, and the band's
  share is the pane's own figure.
- **The dashboard chooses the compaction model and Claude Code's compaction point.** Any Claude or
  router model, with its effort, can write the summary instead of only Haiku or the app's own
  compactor, and `autoCompactWindow` takes 400k, 500k, 600k, the model default or a custom value.
  `settings.json` stays that value's one home; a per-model value `/autocompact` saved is read, and
  a dashboard save drops it, since it would outrank the top-level one. The band's heavy mark is a
  fixed 80% of that window, so `swampAt` is gone.
- **A phone session's settings are confirmed, and always-allow is scoped to the session.** An HTTP
  success and the CLI's own application are told apart, a write that was never confirmed is not
  replayed after a restart, and per-session writes are serialized. A partial model or effort change
  keeps the part that landed, a restart keeps the writer's accepted input, and always-allow keeps
  the condition the CLI offered, in that session only.
- **A phone's files come through one bounded session boundary.** Desktop transcripts, SDK messages
  and workers share it: traversal, symlinks, secret files, changed handles and oversized deliveries
  are refused while the conversation around them stays, and a session's own Claude temp folder
  stays readable. Blob ids are scoped to the log epoch, edited attachments get fresh ids, and
  widget rows no longer draw the same file card twice.

### Changed

- **The eager-delegation note rides on every prompt.** It used to go once when eager delegation was
  turned on and once after each compaction, so between compactions the main chat read one line far
  back in a long context. A note on every prompt costs about twenty tokens and leaves nothing to
  bury.

### Fixed

- **Windows: the tray's shortcuts work while the router runs** (#87). The launcher appended to a log
  the router's scheduled task held open for as long as it ran, so PowerShell stopped before node
  started and the desktop and Start-menu shortcuts did nothing. It now writes its own
  `logs\tray-launcher.log`, and runs without a log if that cannot be opened either.
- **A provider that has run out fails a worker at once** (#89). A spending cap or a used-up quota
  now carries `x-should-retry: false` and a `retry-after` for when the provider is back, so Claude
  Code no longer retries the same 429 ten times over about two and a half minutes. Status and body
  are unchanged, and a bare rate limit is forwarded as before.
- **A Claude pool with nothing usable sends the turn on the app's own sign-in** (#88). Once every
  main-chat model routed to the Claude provider, the app's login was never refreshed and aged out
  after 12 hours; with its stored account revoked, every turn got "no usable Claude account" until
  the provider was deleted. A turn with the client's Bearer now goes out on it, and one without is
  still refused. Closing the dashboard's sign-in dialog while the token exchange ran no longer
  drops the sign-in.
- **A spent Google quota group rests only that group, on that host** (#84 by @csa906). A 429
  `QUOTA_EXHAUSTED` for the Claude (3P) group rested the whole account, so Gemini models on it went
  out too, and a rest on one host blocked the other. The pool now rests the group per account and
  host, the ladder skips only the models in it (an effort suffix included), the dashboard shows
  which group rests where with one button to use the account now, and the group's return counts
  accounts that are only cooling. A 402, a 429 without that evidence and a 503 behave as before.
- **A stored Claude account keeps the mod's workers available** (#81 by @RedBoardDev). The mod's
  ladder called a Claude provider unusable whenever Claude Code's own login was not seen, even with
  ready stored accounts serving every turn, and skipped every worker on that provider.
- **Injected CLI bootstrap models get their descriptions** (#86 by @csa906). A description left out
  is filled at the bootstrap boundary, while explicit descriptions, empty strings and upstream
  options stay as they are.
- **Each routed worker compacts at its own window.** A 272000 written at install capped every
  routed worker, so 6.1 Sol's 475000 and DeepSeek's and MiniMax's million all compacted there.
  Install now writes Claude Code's 1,000,000 ceiling for a per-model window unless
  `--max-context-tokens` names another, and the bootstrap sends every window inside the CLI's
  100K–1M range, so Gemini's 1,048,576 applies at the ceiling instead of being dropped.
- **A dark wake no longer keeps a sleeping Mac awake.** Cache keep-warm pings and scheduled tasks
  during maintenance dark wakes were counted as work, turning ~45 s wakes into 72 and 35 minutes
  awake on battery with the lid shut. A hold now starts only in a full wake, read from the same
  ioreg call as the clamshell flags; a hold already taken is kept, and mode "on" is unchanged.
- **Windows: the new Claude data folders are found, and `uninstall --purge` finishes its own
  cleanup.** A pasted image or scratchpad file under `%TEMP%\claude\…` reaches the phone, the
  bundled CLI under `%LOCALAPPDATA%\Claude-Data\…` is found, and the session folder is allowed only
  with its owner and ACL checked. Purge run from the install's own node.exe could not delete its
  folder yet exited 0: an outside step now finishes it, the command no longer reports success it
  did not have, and it removes only what the ownership manifest names. A cleaned environment also
  keeps its `PSModulePath`.
- **Outside text is cleaned and bounded once, so no surface is refused or loses its controls.** A
  blank press across each card, a long queued phone message, a judge failure or a pinned sentence
  could push the band's buttons past the engine's text budget; one ESC from an error refused the
  log, queue, alerts and settings whole, and a long model name broke the band's width limit. Each
  surface now gets a bounded share through one boundary, cards open from their title or arrow, and
  a failure page does not read the state again.
- **The band and the panes draw again.** A picture with a blank alt no longer vanishes (it takes the
  word ClaudeRipple), worker updates no longer redraw the band, so 리플이's eyes, waves and ripples
  play out, an agent card's title stays light, and a run's line takes the page's ink under the
  pointer as the app's does.
- **The Agents pane stays within the engine's limits and its fallback cannot fail too.** Long
  fallback reasons, titles and an unfolded conversation passed the engine's 20,000-node limit and
  were refused whole, and the fallback re-read the state that had just failed. Reasons and titles
  are now previews, a conversation shows at most its last 512 entries, and the fallback draws from
  what the render had already read.
- **A worker that ends before its spawn is recorded is listed as ended.** A workflow's verify
  agents failed in 72 ms, and their end found no record to close, so 29 cards stayed live 12 hours
  after the run; the end is now kept until the record lands, and the record is written as ended.
- **A phone's notifications and updates say and do the right thing.** Question and plan
  notifications name the question and its options instead of serialized tool input, a web push
  carries the same private context as the native one, and an older phone app gets the earlier reply
  shapes while a newer one names what it reads. A host update skipped because the host was busy is
  retried each minute once nothing is running, queued or handing off, and a tray relaunch that
  failed retries from one minute up to fifteen.

## 0.12.13 — 2026-10-23

### Added

- **A provider can hold more than one API key.** OpenAI-compatible providers such as OpenCode Go now
  rotate keys the way Anthropic-compatible ones do: a conversation stays on its key while it works,
  so its prompt cache holds, and a 429, 402 or rejected key is retried on the next one before
  anything reaches the client. The dashboard gains an accounts tab on these providers to add a key
  with a name, see each key's state and OpenCode Go usage, and rename, replace or remove it. Keys
  are shown masked.
- **Every account pool takes the same controls.** Claude, ChatGPT, Google and API-key accounts can
  each be made first, paused or resumed, have their cooldown cleared, and show which one a new
  conversation gets now. A conversation already on an account stays there, so its prompt cache
  stays. The dashboard offers those controls on every panel, and a first-choice change on API keys
  clears the others in the same save.
- **The dashboard knows which Claude account is signed in.** It asks Claude once per token and marks
  a stored copy of the same person, so someone with one account no longer sees two, or a stale row
  asking to sign in again. Providers also take a display name now: renaming one keeps its key and
  changes only the label shown in the list, status, mappings and logs.
- **A pairing QR opens the app instead of a browser.** The relay can answer the app-link files that
  let the phone claim its link, once it is deployed with the Play signing key's fingerprint
  configured. Until then the Android file answers 404, so a phone does not cache "no app".

### Fixed

- **Windows: a phone session hands off again** (#83). Windows had no desktop handoff runner, so a
  session driven from the phone stayed pending after its writer exited. The handoff now uses the OS
  headless console and waits for the real SDK process before opening another writer, stores the
  error, and retries at most three later idle turns. `--desktop` is supported on x64 Windows only.
- **Gemini 4 Argon sends the thinking level you ask for** (#85). The Google translator recognized
  only Gemini 3 and 2.5, so `@high` was silently dropped on both AI Studio and OpenCode Go.
- **Google's monthly spending cap counts as billing exhaustion** (#85). A project past its cap
  stayed usable, so each new delegation picked the same exhausted API. A plain rate limit, a bare
  `RESOURCE_EXHAUSTED` and a relay's own failure are still not billing.
- **A provider named in Korean keeps the worker you named** (#85). A model or provider named in
  Korean was not recognized, and naming OpenCode could not tell its worker from the Google API
  worker. The generated agent's provider is read in both the spawn and marker checks, a source name
  is honored, and a model-only request stays valid on either source.
- **A GPT model's context window is the one Codex runs with.** The router, the dashboard picker and
  `/api/context-windows` now share Codex's own catalogue: 6.1 Sol is 475000, and a window Codex
  reports without a percentage takes Codex's 95%. The dashboard shows such a window read-only with a
  note, since an edit there would be a number the router ignores.
- **Two dashboard windows no longer overwrite each other.** Nine saving defects from today's review
  are fixed: a provider saved without a new key keeps its auth header and first key, a model map
  keeps each slot's fallbacks and context window, and a save that conflicts re-applies only its own
  changes onto the newer config. A change made while a save is in flight is saved after it, late
  model lists no longer undo ticks, and removing a provider drops only its own picks. The admin API
  also requires a loopback `Host` on every request, so a DNS-rebinding page cannot read your keys.
- **Translated routes deliver tool calls, images and documents intact.** Ten wire defects fixed:
  parallel tool calls are tracked per call instead of all landing on the last, calls whose arguments
  arrive whole reach Claude Code with their input instead of `{}`, interleaved Chat Completions
  calls no longer break their JSON, and Gemini user text, attachments and images in tool results are
  passed. Text and base64 documents survive every translated wire, a token-limit ending with a tool
  call reports `max_tokens`, and schema normalisation no longer strips `pattern`. A later turn of a
  translated worker is refused here rather than sent on as a 404, and the mod draws it as one quiet
  line.
- **A retry, a continue and a relay's refusal are judged by what happened.** A credential retry
  after a 403 resets its error state, so the second answer is not wrapped in the first error. A
  continue after a vendor's own message id is refused and resent stateless instead of drawing a
  404 every turn, a marker naming a target reachable only by a `direct` rule applies that target's
  rules, and a relay's transient 402 is read from its body rather than taken for billing. A
  replaced key drops the old key's quarantine, and stickiness is kept per provider and
  conversation, so one turn elsewhere no longer costs the cache.
- **Install and the CLI no longer break your setup.** `--help` anywhere prints usage and runs
  nothing (before, `uninstall --purge --help` ran the uninstall), CA trust is checked by
  fingerprint so a reinstalled certificate is trusted, and uninstall takes off the Desktop proxy,
  picker flag, Codex provider and CA trust each on its own. Install and update keep `direct on`,
  direct off restores the port configured now, and an update fails when its download fails.
  Windows launchers handle a non-ASCII folder. Generated worker agent files also come back after
  `uninstall --purge` and a reinstall instead of counting as hand-written.
- **A phone session keeps its messages.** A queued message goes as soon as the registry says the
  session is idle, Stop holds the queue before interrupting, and a message taken back keeps its
  attachments. Messages the SDK already read survive a restart, an archived session reaches the
  phone's archive, a plan approval that loses to cancellation rolls the permission mode back, and a
  bridged session picks up a model change. The host also survives a second instance that fails to
  bind and one unreadable session log.
- **macOS starts the tray at login.** `Open at Login` registered Electron.app itself, so every login
  opened a bare Electron window and no tray. A LaunchAgent now runs the router's own ClaudeRipple
  bundle, the old login item is removed and an existing start-at-login moves over, and the
  background bundle no longer changes on each install, so macOS stops announcing a new item.
  Uninstall removes it.
- **The mods' Agents pane draws every agent.** A 31-agent Workflow asked for a picture taller than
  the 4096 px an Svg may be, and the engine refused the whole tree. A picture past the limit is now
  tiled, a record missing a description, type or model renders by its id, and a judge pick without
  a label no longer throws. If drawing still fails, the pane shows a plain list of the last 40
  agents with the reason instead of the engine's blank page.
- **A Workflow agent shows the model it actually runs on.** One Workflow ran 31 Sol workers while
  the task list said Opus 5.5 for all of them, and every later turn lost the marker it was routed
  by. The spawn hook now gives such an agent the worker's model, so it shows as Sol and routes by
  model name each turn; `ripple:auto`'s Workflow note says the model goes in `agentType`.
- **A model named while a turn runs counts, and the notice waits.** A prompt typed mid-turn is
  absorbed into the running turn, so a model named in it was read as unnamed and the marker was
  dropped. The mod now keeps the last two submitted prompts. The "not the model you named" notice
  also used to appear before the tier picked, sometimes naming the very model that then ran; it now
  waits for the pick and stays silent when they match.
- **Small labels say what they do.** The model picker's effort tag read as a button that sets the
  effort, and it now says the model accepts a reasoning-effort setting. The Google accounts button
  says it adds an account, as the other panels do.

## 0.12.12 — 2026-10-23

### Fixed

- **A worker added while a session sat idle can be spawned there.** Claude Code missed an agent
  file written in the last 30 s of a session's idle polling, and `/clear` kept the old list, so
  the session answered "Agent type not found" for good. The router touches the generated agent
  files again 45 s after it writes or removes one, which makes every session reread them.
- **A Claude app session cleared with `/clear` lists once on the phone.** The conversation before
  the clear no longer shows beside the live one.

## 0.12.11 — 2026-10-23

### Added

- **The Code tab's own panels reach the phone.** A Claude app session's task list shows above the
  phone's composer, its closing box shows the recap, the question and reply buttons that answer
  it, and its chapters divide the conversation. Needs Ripple Remote 1.0.4.
- **A question waits for you.** When a Claude app turn ends on a question, the push says an answer
  is needed (the question itself stays in the encrypted part), and the session moves to "needs
  input". Sessions also carry the Claude app's own status line.
- **A session's changes from the phone.** The host answers what changed in a session's folder:
  uncommitted work, or the branch against its base. Read-only git; no configured program runs.
- **Background workers open from the dock.** A background agent's task names its log, so the
  phone can open its conversation.

### Fixed

- **Windows: an update no longer leaves Claude without a router** (#80, #62). A start counts only
  once the router's process is up; when the scheduled task brings none, the router is started
  directly and the CLI says so. `install.ps1`/`install.sh` exit non-zero over a failed setup, and
  the tray's Electron fetch finds the Node running it.
- **Remote Control questions are questions** (#82). AskUserQuestion and plan approvals from a
  Claude app session card as they do for the host's own sessions, the answers go back, and a
  request already answered never cards again.
- **The phone sees a Claude app turn sooner.** A send shows the session running at once, and the
  transcript is read on file change rather than every 3 s.

## 0.12.10 — 2026-10-23

### Added

- **The phone's queue lives on your computer.** A message queued on the phone while a turn runs is
  handed to the host, which sends it when the turn ends, even with the phone locked in a pocket.
  Before, the app held it and sent nothing until it was opened again. Needs Ripple Remote 1.0.3.
- **The Claude app shows what the phone queued.** While a chat has queued messages, a slim strip
  over the ClaudeRipple band shows how many, the first one, and that they go when the turn ends.

### Fixed

- **A model named in a quoted reply counts.** The Claude app sends a reply that quotes a message
  with a `<!-- reply -->` comment first; that message was read as a notice, so a model named in it
  was ignored.

## 0.12.9 — 2026-10-22

### Fixed

- **A session can no longer pick a model you didn't ask for.** Naming a model on `ripple:auto`,
  calling a worker agent directly or giving `general-purpose` a model now counts only when you named
  that model in your last messages (or approved an answer that did). Otherwise ClaudeRipple says so
  and sends the task by its tier.
- **The domain comes from the session, not a guess.** A tier marker can say `ui` or `backend`
  (`[[ripple: standard ui]]`); without it the task uses the general ladder. The judge no longer
  rates tiered tasks in the background, so they start without waiting for it.
- **A domain ladder's "light work" row is for easy work only.** Ordinary work now takes the
  "heavy work" row with the hard work, so "easy design on Sonnet, the rest on Opus" does what it
  says. Saved settings carry over.

## 0.12.8 — 2026-10-22

### Fixed

- **A Workflow script's agents go to the worker their marker names.** Claude Code wraps a workflow
  agent's prompt in a harness frame, so a `[[ripple: gemini-3-8-flash@high]]` on the script's first
  line was no longer at the top of a message and every agent ran on the session's model. The router
  now reads the marker from the first line under that frame.

## 0.12.7 — 2026-10-22

### Fixed

- **A GPT main session knows it can make images.** How to call `/api/image` was written only into
  generated worker files, so a session running GPT as its own model said it had no image tool and
  drew an SVG. The same lines now end its instructions; subagent turns are unchanged.
- **A relay's 402 for a downed model no longer parks the whole account.** OpenCode Go answered 402
  while one model's endpoint was down, which read as billing exhaustion and rested the account for
  30 minutes, DeepSeek included. A refusal whose body says the upstream failed is now transient.
- **A failed hotspot join is tried again within seconds** (10 s, 20 s, 30 s … up to a minute)
  instead of waiting out the once-a-minute switch rule.
- **`ripple:auto` asks for a bare task description,** so the Claude app's running-agent row no
  longer shows another worker's model name copied into the title.

## 0.12.6 — 2026-10-22

### Fixed

- **The phone can pick a folder on another Windows drive.** Browsing starts in `C:\Users\<name>`,
  and a drive root had nowhere to go up to, so a project on `E:` was out of reach. A drive root now
  lists the other drives first.
- **The phone's model picker always offers Claude.** It listed only what the router's providers
  declare, so a router that passes Claude straight through showed no Claude, and with no other
  provider the picker was empty. Claude Code's own Opus, Sonnet and Haiku are now offered when no
  Claude provider is configured.
- **A running worker's row names its model** as soon as the worker's first answer (or, for a Claude
  app session, its meta file) says which model ran it, instead of only when it finishes.
- **A quiet computer reads as a wait, not a lost connection.** The phone's red "connection lost"
  card came after 30 seconds of silence, which a phone that slept or switched networks often
  reaches. It now comes after a minute, in the warning tone, as "waiting for your computer", and
  time the phone app spent in the background no longer counts toward it.
- **Jev gets 5 seconds to answer** before Haiku judges instead. It answers in about 2.1–2.4
  seconds, so 3 seconds timed out whenever OpenCode slowed down.
- **`clauderipple install` removes npm's `clauderipple.ps1` on Windows.** PowerShell runs it before
  `clauderipple.cmd`, and its default execution policy refuses it, so an `npm install -g` user could
  not run `clauderipple` in PowerShell. The README now says to start with `clauderipple.cmd` there.
- **The phone says when the Mac is asking for folder access.** Opening a folder macOS guards
  (Desktop, Documents, Downloads, iCloud Drive, another volume) for the first time puts up the
  Mac's "would like to access" dialog, and the phone waited in silence, then said the computer did
  not answer. It now says the dialog is up within two seconds, and where to allow access if it was
  refused.
- **The band's limits row comes back at the next check after a failed read**, not a minute later.

## 0.12.5 — 2026-10-22

### Changed

- **The install script adds the menu-bar app on macOS and Windows.** It carries the repair
  screen that opens while the router is down, which someone who does not use a terminal needs.
  Electron is about 270MB and fetched once; `CLAUDERIPPLE_NO_TRAY=1` skips it, and a failed
  fetch leaves the router installed with a hint to add the app later. Linux keeps it opt-in.

### Fixed

- **Updating restarts the phone host too.** An update replaced the files but left the running
  host on the old code until the machine restarted, so a fix like 0.12.4's Windows sending did
  not arrive. `install` (which every update ends with) now restarts a phone host this
  installation registered, unless a turn is in progress; then it says to run
  `clauderipple remote install` afterwards. A host run from a source checkout is left alone.
- **Windows with a non-ASCII account name no longer re-registers the router on every install.**
  The scheduled task was read back in the console's code page, so it never matched (#74, #75 by
  @115dkk). Tests that assumed "/" paths or POSIX permission bits now run only where those hold
  (#76).

## 0.12.4 — 2026-10-22

### Added

- **On Windows, the phone can send to a session open in the Claude app.** Before, such a session
  could be read but not written to. It needs Remote Control turned on in the Claude app, the same
  as on macOS; with only the Claude app in use, the login ClaudeRipple saw the app use carries it.
  Handing a phone session over to the Claude app is still macOS only.

## 0.12.3 — 2026-10-22

### Added

- **Fast for GPT, separately for the main session and for subagents.** The ChatGPT provider's
  settings have two switches, both off: "Fast for the main session" and "Fast for subagents".
  When on, those GPT requests go out on Codex's fast tier, which answers sooner and uses the
  subscription faster. Claude Code's own Fast toggle does not reach GPT models, so these are the
  way to turn it on. Each request in the log now says whether a subagent made it.

### Fixed

- **The phone host says when Claude Code has no login of its own.** On a computer that only ever
  used the Claude app, every phone turn failed at once with "Not logged in". `clauderipple doctor`
  and `clauderipple remote install` now warn about it and say how to log in, and the phone shows
  that instead of the raw error.

## 0.12.2 — 2026-10-22

### Fixed

- **Back on Wi-Fi only when a known Wi-Fi is in range.** After a hotspot failover, the way back
  no longer drops the hotspot for a Wi-Fi that is not there, which cut the connection on the move.

### Changed

- **Naming a model on a delegation is now explained to the main chat.** `ripple:auto`'s
  description says that `[[ripple: opus@high]]` (or a worker's name) on the first line runs that
  model past every ClaudeRipple rule and still shows in the agents panel, so a session no longer
  starts models outside it to get one. It also says what a brief should state, to check that the
  report did what was asked, and to resume a worker only within 5 minutes of its last reply.

## 0.12.1 — 2026-10-21

### Changed

- **One web setting covers page reading too.** WebFetch downloads a page and has the small, fast
  model answer from it; that answer now comes from the model picked for web search, as WebSearch
  already did, instead of Haiku on Claude quota. The Clients row is "Web search & page reading". If
  that model fails before answering, the request goes where it went before.
- **Design work takes the heavy level of the frontend + design ladder**, whatever tier it was
  given: a task judged design runs on the heavy workers, since its result depends on the model's
  taste rather than on difficulty. Frontend tasks still pick by tier.

## 0.12.0 — 2026-10-21

### Added

- **ClaudeRipple updates itself.** The router checks for a new version 10 minutes after it starts
  and every 12 hours, and installs it once nothing has been in flight for 10 minutes; requests in
  flight finish before the restart. A version that fails to come up is not retried for 24 hours.
  The tray shows a desktop notification when an update has landed, or when one is available where
  nothing installs by itself. Off with the switch in the dashboard's About view. Versions before
  this one need one manual update to get here.
- **Frontend + design and backend can have workers of their own.** Each worker set (Base and every
  mode) can give those two domains their own ladder of two levels, light work and heavy work; every
  other task keeps the four general workers. When the main chat names a task's tier, the judge is
  asked for its domain only while such a ladder is set.
- **Base has its own delegation strength.** Eager delegation no longer needs a mode to be on.
- **Web search gets its own model.** The Clients view picks the model that answers `WebSearch`
  apart from the small, fast one, from the models ClaudeRipple can actually search with. It applies
  at once, without a new session.
- **OpenCode Go's Gemini model works** (#68). A model can speak Google's `generateContent` wire
  inside one provider; `gemini-4-argon-contributor` is listed on it, sent with OpenCode's session
  header.
- **The Phone view introduces Ripple Remote**, with an App Store button for your language's store,
  until a phone is paired.
- **Image generations appear in the request log and the usage counts.**
- **The Compact icon shows how many times the chat has been compacted.**

### Fixed

- **A routed model's compaction window falls back to the one its provider declared**, not the
  global default: a 1M-token subagent was compacting at about 240K.
- **"Reopen Claude" goes away once Claude has restarted**, however it was restarted.
- **OpenCode Go's DeepSeek is no longer offered as a search model**; it never ran a search.
- **A router that briefly lost its settings no longer sends every chat back to setup.**

## 0.11.1 — 2026-10-20

### Fixed

- **The Dock shows ClaudeRipple's icon when the app is opened from its icon.** In 0.11.0 the icon
  was set while the launch was still finishing, and macOS put Electron's back; it is now set once
  more two seconds later.

## 0.11.0 — 2026-10-20

### Added

- **Close the laptop, Claude keeps working.** For sessions driven from a phone, the laptop now
  stays awake with the lid shut while a model call runs and for 10 minutes after (or until a time
  you set), and lets go under a 20% battery floor or, on macOS, a thermal warning, putting a closed
  laptop to sleep when it does. macOS needs one setup: macOS's own password dialog installs a
  sudoers rule for exactly the commands used, and Insomnia is cleaned up. Windows needs no
  administrator rights: a router child holds `SetThreadExecutionState` and sets the lid action
  only while held, restoring yours afterwards. Off until turned on in the dashboard's Laptop view.
- **Wi-Fi without internet fails over to the phone hotspot, and comes back.** The router probes the
  internet through the Wi-Fi interface (a dead uplink or a captive portal still reads "connected"
  to the OS), joins the hotspot you name after 3 of 5 failed rounds, and tries the way back to a
  known Wi-Fi 5, 10, 20, 30, 40, 50 and 60 minutes after landing, then every 10 minutes. iPhone and
  Android hotspots both work: an Android hotspot's subnet is learned from the router's own join.
  When calls never stop, the switch holds new model calls for a moment instead of waiting forever;
  nothing is refused.
- **The app's window is the dashboard, and it opens with the router down.** It draws its own copy
  of the dashboard, so a broken router no longer takes the only screen with it; the Status view
  offers repair and a switch to Claude's own connection. `clauderipple doctor`, `repair` and
  `direct on|off` do the same from a terminal. Opening the app from its icon shows the window.
- **The app and its tray wear 리플이,** and the Dock shows that icon instead of Electron's.

### Changed

- **Gemini 3.8 Flash's high effort uses the medium tier.** `-high` thinks without a budget, and
  on a normal day the requests past medium's 4,000 tokens took 64% of all request time.
- **Every model goes to the Antigravity host that offers it** (Gemini 3.1 Pro is on prod only),
  and the limits row reads the quota of the host the requests spend.
- **Korean reads as everyday Korean** across the dashboard, the mod and the menu-bar app, and the
  power screens name no device brand: laptop and phone, with iPhone and Android steps side by side.
- **An agent's conversation shows whole,** with no "earlier" to press, and a back button floats at
  the top once you scroll down. Narrow agent cards give the elapsed time no row of its own and cut
  titles at two lines; the band and log drop a hosted model's vendor path.

### Fixed

- **A Mac offline no longer restarts the router in a loop.** The health self-exit, meant for a
  wedged process, fired 27 times in 18 minutes on a commute and kept the hotspot failover from ever
  counting its failures; it now asks a fresh process first and stays up when the machine is offline.
- **Google's "no capacity" no longer rests the account.** A 503 `MODEL_CAPACITY_EXHAUSTED` is retried
  twice, slowly, then handed to the route fallback or answered 529 overloaded; other turns are not
  refused with "all accounts resting".
- **Ripple Remote keeps sending when the `claude` CLI's login lapses.** The phone host borrowed the
  CLI's keychain login, which only the CLI refreshes; it now falls back to the login the Claude app
  is using.
- **Gemini's quota is read from the host the requests spend it on,** a window past its reset reads
  0% instead of vanishing, and Gemini's Claude-and-GPT windows show only when such a model runs
  through it.

## 0.10.0 — 2026-10-20

### Added

- **Code tab sessions on an SSH host route through Ripple.** Claude Code on a remote host went
  straight to Anthropic and could not find the GPT workers, because Claude Desktop opens that
  connection itself and never reads `RemoteForward` (#67). `clauderipple remote add <host>` copies
  the CA and the generated agent files over plain `sh`, points the host's `settings.json` at a
  router-held reverse tunnel on `127.0.0.1:18791`, re-syncs the agents whenever they change, and
  `remote hosts` / `remote remove` manage them. It needs key-based `ssh` with no password prompt;
  the mod is not on the remote host yet.
- **The logs page shows token usage for any period, and every provider.** The chips covered only
  the last hour. A period control (1 hour, today, 7 days, 30 days, this month, all time, custom
  dates) now reads an hourly history that survives restarts, a per-model table shows where the
  tokens went, and the provider menu lists every configured provider instead of only the ones in
  the last 200 requests, filtering the chips, the table and the recent requests together. A figure
  too wide for a narrow pane or a 1,024px window steps its type down instead of being cut.
- **The band's limits row shows every provider.** Claude, ChatGPT, Antigravity (Gemini), OpenCode
  Go and a Grok subscription each draw a group in their provider's colour, from one
  `/api/limits` read; before, only Claude and ChatGPT did. At about 100 columns four providers
  took roughly 207 cells as gauges against 96, so the row picks the roomiest of three densities
  and gives up later groups only when none fits. Each provider can be kept off the status bar.
- **The Agents pane gives each agent a card.** The pane showed "no agents running · 2 done" over
  an empty panel. Each card now holds the state, title, the model that answered and the effort it
  was sent at, the API's real token counts with cache share, the tool count, and the elapsed time,
  and keeps its size steady while the agent runs. Opening a card shows its conversation in the
  pane, with a run of tool calls collapsed into one summary line ("3 files read, 1 command run"),
  as the Claude app draws it.
- **The dashboard's Phone view pairs Ripple Remote and manages the connection.** Pairing used to
  mean running `npm run remote -- pair` in a source checkout. The view now shows the host's state,
  a pairing QR on request, the mode, the phones seen and a key rotation, answered on a
  loopback-only `/local` API with a secret from a `0600` file. The published CLI and dashboard now
  install the phone host, which runs under Windows and Linux user supervisors as well as launchd.
- **Ripple Remote tells you which session finished and what it did.** Notifications carried one
  fixed line for every session; the host now sends the title and the last answer, approval request
  or failure reason inside an encrypted blob, leaving Expo, APNs and FCM with only the fallback
  text. Mac sessions push when a turn ends while the Mac is away, Claude app sessions send and
  receive photos, a subagent shows its model and opens its own chat, and thinking no longer
  splits a run (one real session went from 1,442 rows to 549).
- **The desktop has two skins, deep and flat.** A `skin` setting picks them on the quick settings
  panel and the dashboard's Look card; deep stays the default. Flat follows the app's own surface
  and quiet text colour, keeps one accent, and the band's labels, counts and controls carry the
  right colour.

### Fixed

- **Google and Antigravity prompt refusals are retried instead of failing the turn.** A refusal is
  now returned unwritten and retried once along a configured fallback route with the original
  request, and an Antigravity 429 is called a real limit only when fresh account and project quota
  evidence says so.
- **Parallel tool results with images stay together on the OpenAI-compatible wire.** Three image
  Reads used to interleave `tool|user|tool|user`, and DeepSeek refused them
  ("insufficient tool messages following tool_calls", #64). Images now wait until the run of tool
  results ends.
- **A slow reasoning model passes the connection check.** Hive answers a streamed request in 0.3
  seconds but a whole one in 3–23, past the 8-second probe, so a working key read as "could not
  connect"; the check now streams and drops the body once the status is in.
- **A provider named in Hangul is named after its domain.** "하이브" slugged to nothing and showed
  as "provider"; it now falls back to the URL's domain ("thehive").
- **A failed restart no longer ends the Windows supervisor loop.** One `Start-Process` error, such
  as a locked log file, stopped the script and left the router and host unsupervised until logon.
- **A dark-mode select's options are readable.** Native options and optgroups now get opaque,
  theme-aware backgrounds.
- **Slash commands stay available when settings fail to load.** A throw while loading settings
  took `/ripple`, `/ripple-log` and `/ripple-bar` with it (#62); the settings step now has its own
  catch, so the commands register either way.

## 0.9.5 — 2026-10-14

### Fixed

- **Routed reasoning models keep their train of thought between tool calls.** The router dropped
  every translated model's previous reasoning, so on each tool call Muse, GPT and DeepSeek reasoned
  the whole task again from scratch. Workers took minutes per step, kept re-deriving the same plan,
  and sometimes stopped with no answer. The model's own reasoning now travels in Claude Code's
  transcript and goes back to it unchanged, the way OpenCode's and Codex's own clients do it. On four
  real fixes graded by their hidden tests, Muse Spark 1.3 at xhigh finished in 90–584 seconds, where
  0.9.4 took up to 13 minutes and twice ran past 30 minutes without finishing. Switching a session
  to a Claude model still works: the carried reasoning is left out of requests to Anthropic.

## 0.9.4 — 2026-10-14

### Fixed

- **Reasoning models are no longer cut off after five minutes of thinking.** Node's `fetch` dropped a
  response that sent nothing for 300 seconds. Muse Spark 1.3 at xhigh thinks for minutes in silence
  on a large context, so long steps failed with 529 at 303–305 seconds and started over. The router
  now waits up to 15 minutes. OpenCode's own CLI had no such limit, which is why the same model
  worked there.
- **OpenCode Go and Zen models get their real context window.** They fell back to the global
  258,400, so Claude Code compacted DeepSeek V4.1 Flash, GLM-5.3 and Muse Spark 1.3 at a quarter of
  their 1M windows. The router now reads the window from the same models.dev catalogue OpenCode's
  CLI uses, and fills models already saved without one.
- **A ChatGPT account whose limit was reset or topped up is usable again right away.** It stayed
  "cooling" until the old reset time, so the app could not switch to GPT models.
- **Adding an OpenAI-compatible provider such as B.ai works.** The connection check asked for one
  token, which some vendors refuse ("max_tokens must be greater than 2", #57).
- **The plan limit shows on the band**, and every control's tip shows on hover even when the band
  is full.

### Changed

- **The band:** Auto is a word that lights when on, instead of a switch. Compact and Clear (with a
  confirm) sit beside settings. The limit draws as a small gauge and its percent.
- **Workers read and edit with the dedicated tools.** Generated worker agents are told to read files
  with Read and change them with Edit, not with `sed`/`cat` through Bash.
- `/ripple debug` also shows the model, the limit and the host's rate limits.

## 0.9.3 — 2026-10-14

### Fixed

- **Claude workers offer X-High.** Claude's effort ladder stopped at high and max, so X-High could
  not be picked for Claude in the mod or the dashboard though GPT had it. Opus, Sonnet and Haiku 5.5
  all take it (#56).
- **A model ticked after the mod's worker list was saved is usable.** It used to stay off and show
  as unavailable in the mod (GPT-6 Astra in #56). A worker the list has not seen now starts on.
  Settings saved before this keep the old reading until the list is changed once.
- **The plan limit shows in the band on Claude chats.** The desktop Code tab left the mod's rate
  limits empty, so the limit never appeared even with it switched on. The mod now falls back to the
  router's figure for the same Claude login, and hides it when that figure is over 15 minutes old.
- `/ripple-bar` no longer says the band is shown above the prompt when the layout is Minimal, where
  only the short line under the prompt is drawn (#56).
- The close button lights as one disc under the pointer instead of drawing a second box around it.

## 0.9.2 — 2026-10-14

### Added

- **The mod shows when keep-warm held your cache.** A successful ping used to be silent, so it was
  easy to think keep-warm never ran. When you come back, a card now says how many pings kept how
  many tokens in cache and how long is left. It goes when you send a prompt or close it, and the
  cold-cache card takes over if the cache expires after all.
- **Keep-warm per chat.** The band's flame now turns keep-warm on or off for that chat only: a full
  flame where it is on, an empty one where it is off. Settings is what a new chat starts with.
  After a restart or resume, a chat follows Settings again.

- **Grok through a Grok subscription.** A new "Grok subscription" provider uses Grok 4.7, 4.7
  Fast, 4.6 and 4.5 with the Grok CLI's own sign-in (`grok login`), with no API key. It reads the
  CLI's session and, when the session is about to expire, has the CLI refresh it. Tools,
  thinking and effort (low…xhigh, per model) work as on the other translated providers. This
  is the channel the Grok CLI itself talks to, not a published xAI API, so a CLI update can
  change it. Pay-per-token access with an xAI API key stays under the xAI preset. Thanks @nakjiya (#52).

### Fixed

- An OpenAI-compatible provider's error that echoed the bare token, without its `Bearer` scheme,
  could show it in the error message. It is now redacted like the full header value (#52).
- On a two-line mod card, 리플이 sat on the title's line; it now sits at the card's middle.

## 0.9.1 — 2026-10-14

### Added

- **The request log records more of each request** (`logs/requests.jsonl`, #55). Every new field is
  optional, so older records and readers keep working.
  - Anthropic's request id or the message id, to match a row to the transcript, subagents included.
  - Why a request ended before reaching a model, with the right provider instead of `anthropic`.
  - Whether a call was the auto-mode classifier or a web search.
  - An explicit `cacheWrite: 0`.
  - The service tier that was asked for and the one the provider served. This shows whether a Fast
    request was honoured (#54).

### Fixed

- Saving the mod settings failed on Windows with `EPERM … fsync` since 0.9.0 (#53).
- "Haiku returned no verdict" appeared now and then. When Haiku breaks the end of its JSON, the
  verdict's complete fields are now read instead of the whole answer being dropped (#53).
- A response over 64KiB that arrived in one piece (every compressed answer, for one) lost its usage
  and stop reason in the request log.
- Alert cards centre their buttons when the title takes two lines.
- Ripple Remote no longer lists a resumed session's old halves, and a host restart no longer marks
  idle sessions as just used.

## 0.9.0 — 2026-10-13

### Added

- **The ripple mod.** A band above the Code tab's prompt shows reasoning effort, context, the
  cache timer, and which model answered each request with its cache hit. Log opens the request
  log, ⚙ opens quick settings, and the dashboard has a mod page with every setting.
- **Effort picked per prompt.** A small judge model (Haiku 5.5 or Jev) reads the prompt and the
  recent turns, then sets low through max. Pick an effort yourself whenever you want; Auto comes
  back when you switch it on.
- **Workers picked per task.** The main chat hands work to `ripple:auto`, and the judge decides
  how hard each task is and sends it to the matching rung: light work to DeepSeek or GLM, hard work
  to GPT or Opus. Rungs, candidate models and named modes (prefer or avoid a model, eager
  delegation, switch off at a quota reset) are set on the dashboard. Every pick is kept in
  `logs/worker-picks.jsonl`.
- **Warnings that save tokens.** Cards appear when the prompt cache has gone cold on a big chat,
  when the context gets heavy, and when a plan window passes 80%. Each card offers compact or a
  handoff.
- **Handoff to a fresh session.** A handoff writes a summary and opens a new session in the same
  folder with it in the prompt box. The current chat is left as it is.
- **리플이**, the mascot, on the band and every card, acting out what the band is doing. Mod text
  in six languages, following the Mac's system language.
- **Artificial Analysis scores** for every routable model, refreshed daily, used to rank worker
  candidates by measured cost.
- A provider that answers 402 or says its quota is exhausted is skipped for a while.

### Changed

- Dashboard settings are rebuilt in the style of macOS System Settings.
- The mod's settings live in the router, so every session follows a change at once.

### Fixed

- Judge-only models such as Jev no longer appear in pickers, worker lists or Codex.
- The install script works under macOS `/bin/sh` again.

## 0.8.10 — 2026-10-10

### Added

- **Choose which Claude account is used first.** With several Claude accounts, the current Claude
  login was always tried first. Each account card now has a "Use first" button (Providers →
  Claude → Accounts). New conversations start on that account, move to the next one when it hits
  its limit, and return to it once the limit resets. A conversation already running stays on its
  account to keep its cache.

### Fixed

- **DeepSeek subagents no longer fail with 400 on the Artifact tool.** DeepSeek's Anthropic
  endpoint rejected Claude Desktop's Artifact tool over a regular expression it cannot compile
  (`"^[^\0]*$" is not a "regex"`). That pattern is now removed on the way out, as it already was for
  OpenAI-format providers (#51).
- **The tray starts again after a Windows restart.** Installed with the install script, the tray
  was set to open at logon without its own script, so Windows opened a bare Electron instead
  (#50). Restarting the tray once after updating fixes the entry. `clauderipple tray` now also
  reports a tray that quits right after starting, with its output in `logs/tray.log`. Running it
  while a tray is already up no longer adds a second icon.
- **New ChatGPT models show up without the Codex CLI installed.** OpenAI's model list hides
  models from older Codex versions, and without a Codex CLI the router asked as 0.155.0, so GPT-6.1
  Sol never appeared (#50). It now asks as the newest published Codex. New models appear unticked in
  the ChatGPT provider form.

## 0.8.9 — 2026-10-08

### Fixed

- **New Claude models appear on their own.** The Claude model list was built into ClaudeRipple,
  so Opus 5.5, Sonnet 5.5 and Haiku 5.5 never showed up. It now comes from Anthropic's model list
  for your account, refreshed hourly. When a newer model ships in a family you already use (say
  Opus 5.5 after Opus 5), it is added to your Claude provider on its own. Untick it and it stays
  unticked.

## 0.8.8 — 2026-10-07

### Fixed

- **Web search works with OpenCode Go's DeepSeek on the small/fast slot.** With that slot on
  DeepSeek V4.1 Flash, V4 Flash or V4 Pro through OpenCode Go, every `WebSearch` was refused
  and the Clients screen marked those models "no web search here". The same plan runs the search on
  its Anthropic endpoint, so the router now sends searches for these models there. Their other
  requests are unchanged.

## 0.8.7 — 2026-10-07

### Fixed

- **"Enter manually" takes OpenAI-compatible APIs.** The form now asks for the API format
  (Anthropic Messages, OpenAI Chat Completions or OpenAI Responses). It used to save every hand-entered
  provider as Anthropic-compatible, so an OpenAI-compatible address failed its connection check with
  a 404. An OpenAI-compatible provider also fills its model list from `/models`.
- **Opus 404s after a pause no longer show as errors.** Since Claude Code 2.1.288, a turn after a
  few idle minutes often comes back 404 `thread_not_found`, and Claude Code resends the conversation
  at once with the prompt cache intact. Nothing fails, so the log, the line above the prompt and the
  summary now show such requests as resent, not failed.

## 0.8.6 — 2026-10-07

### Fixed

- **Web search works with a ChatGPT model on the small/fast slot.** With that slot on a ChatGPT
  model (Luna, say) and no web-search provider set, every `WebSearch` failed as "unavailable",
  while the Clients screen called ChatGPT searchable. A search sent to a ChatGPT model is now
  answered by your ChatGPT subscription's own search.

## 0.8.5 — 2026-10-07

### Fixed

- **The ChatGPT provider no longer says Plus/Pro only.** Any ChatGPT plan that includes Codex
  (Plus, Pro, Business, and Enterprise/Edu with Codex on) signs in the same way; the dashboard
  now says so in every language.

## 0.8.4 — 2026-10-06

### Added

- **Four more languages.** The dashboard, the tray and the README now come in Simplified
  Chinese, Japanese, Spanish and Brazilian Portuguese as well as English and Korean. The
  dashboard follows your browser or OS language; pick another from the selector at the bottom
  of the sidebar.

### Changed

- **Releases publish themselves.** A version tag now publishes to npm from GitHub Actions, with
  a signed provenance statement, so fixes reach `clauderipple update` without waiting on anyone.

## 0.8.3 — 2026-10-06

### Fixed

- **No PowerShell window at every Windows logon** (#49). With Windows Terminal as the default
  terminal — the Windows 11 default — the router task's PowerShell window stayed on screen after
  each logon, because Windows Terminal ignores `-WindowStyle Hidden`. The task now starts
  PowerShell inside a headless console host. Updating re-registers the task; where Windows
  refuses that, the old task is kept and the router runs as before.

## 0.8.2 — 2026-10-06

### Fixed

- **Effort works on API-key providers.** A provider with no effort ladder of its own — DeepSeek,
  Kimi, GLM, MiniMax, Qwen, Groq, Mistral, or any key and URL — stripped the effort you picked and
  the Claude app showed no effort menu for its models. ClaudeRipple now asks each such model: it
  sends a level no vendor defines, and if the endpoint refuses it, the levels it does accept become
  that model's effort menu. An endpoint that accepts anything is left without effort, since it is
  not reading the field. Providers you already set up are measured a minute after the router
  starts; nothing needs re-saving.
- **DeepSeek's API offers low / high / max**, the three levels its thinking mode maps every
  request onto.

## 0.8.1 — 2026-10-06

### Fixed

- **Codex credits are spent instead of refused.** Once a ChatGPT plan's window read 100%, the
  router rested the account until the reset, even though OpenAI serves an account with bought
  credits past its window. An account with credits (or an unlimited balance) now stays in
  rotation; a real usage-limit refusal still rests it.
- **Fewer failed Claude app requests in picker mode.** claude.ai closes idle kept-alive
  connections, and a request written on one as it closed came back as a 502 (about 65 a day
  here, mostly the app's start-up requests). A GET, HEAD or OPTIONS that meets such a socket is
  now sent again; a POST is not.
- **Picker mode on a new Mac.** The ClaudeRipple CA counted as trusted when it was merely in the
  login keychain, so `picker on` could skip the trust step and leave Claude Desktop unable to
  load claude.ai. Trust is now read from the user trust settings, and `picker off` removes the
  certificate either way.
- **The route band said "router not answering"** on Claude Code 2.1.288, which sends plain
  `http://` requests through the proxy too and got 405. They are now relayed.

### Docs

- Any ChatGPT plan that includes Codex works (Plus, Pro, Business; Enterprise/Edu with Codex
  turned on), not just Plus and Pro.
- `ultra` effort is sent as `max`: the Codex backend refuses `ultra` (measured), and Codex's own
  ultra is max reasoning plus its sub-agents, which in Claude Code are Claude Code's subagents.

## 0.8.0 — 2026-10-05

### Added

- **The route, where you type** (Claude Code mods; a switch on the Clients screen, or
  `clauderipple mod on`). A line above the Claude Code prompt says where your last request
  went: model, provider, effort, cache hit and time, colored by provider and result. `Log` or
  `/ripple-log` opens the request log in a side pane, all sessions or just this one; `×` or
  `/ripple-bar` puts the line away. The router now records which Claude Code session sent each
  request (`X-Claude-Code-Session-Id`), and `/api/requests?session=` filters by it.
- **Workers stay on their own model.** The same mod catches a `model` argument on an Agent call
  that would have put a ClaudeRipple worker on a Claude alias (its output cut to 64 tokens) and
  runs it on its own model, and reads a `[[ripple: name@level]]` marker wherever it sits in the
  prompt, not only on the first line.
- **Google Gemini**, on its own wire: an AI Studio key, or a Google account through the
  Antigravity backend with several accounts in rotation. Google's terms name the account route
  as a breach and accounts were suspended for it; the sign-in says so before it starts.
- **Each routed model gets its own effort menu in the Claude app.** DeepSeek and GLM show
  low/high/max instead of Claude's whole ladder; a model that takes no effort shows none.
- **Fast mode on GPT.** `/fast` in Claude Code asks the ChatGPT backend for the Codex fast tier.
- **Updates from the dashboard**: the version row checks and starts an update.
- **A typed model ID** for a provider that lists no models (#42).
- **An explicit Auto mode classifier target** (`autoModeClassifier`, JSON only; #43 by
  @Sociopacific). The README says what pointing it at a weaker model gives up.

### Changed

- **Measuring an OpenCode provider takes one request per model**, its effort ladder read from
  models.dev, four models at a time, instead of about ten sequential requests each (three
  OpenCode Go models had taken 2m33s). The ladders are the catalogue's: glm-5.3-flash is
  low/high/max, where requests had accepted seven levels.
- **Generated workers run at `@high`** unless a marker says otherwise.
- **A clamping tie goes up**: medium on a low/high/max model is high, not low.

### Fixed

- **A settings save no longer undoes what the router wrote.** The dashboard saved the whole
  config from the copy it loaded when it opened, so measured ladders and hand edits came back
  with the next unrelated save. Every save now starts from the router's current config.
- **Routed workers are no longer told to call `advisor`** after the tool was dropped (#47, #48
  by @115dkk).
- **`claude-login` finds the Desktop-cached CLI** in its new `<version>/<hash>/` folder (#45,
  #46 by @115dkk). macOS had the same layout.
- **Codex context overflow** is answered as "prompt is too long", so Claude Code compacts
  instead of retrying the same request (#44 by @Sociopacific); a stream held for that opens
  after five seconds regardless.
- The Codex app sees a GPT model released after the router started; subagent titles keep the
  model and effort under Desktop's new task panel; a provider's connection test reads a
  model-not-found 404 as an accepted key; a Gemini provider waiting on Google's verification
  is not shown as connected, and the page to open is passed on.

## 0.7.0 — 2026-09-29

### Added

- **Worker tools** (`cli.limitWorkerTools`, off by default; a toggle in the dashboard). Generated
  workers get only the read, edit, run, search and skill tools instead of inheriting every MCP
  server and plugin tool of the session. One worker's first request fell from 32,942 to 8,823
  tokens. Such a worker cannot use a browser or the iOS Simulator; keep those in an agent file of
  your own.
- **Images from the ChatGPT subscription.** `clauderipple image "<prompt>" -o file.png`, with
  `--aspect square|landscape|portrait`, `--transparent`, `--format` and `--ref FILE` for reference
  images. Underneath is `POST /api/image` on the admin port, which answers with the image itself.
  Generated workers are told the `curl` form, so a worker with only Bash can make one. The backend
  chooses resolution and quality; about 30 seconds an image.

## 0.6.0 — 2026-09-28

Both suggested in #8 by @artisthanbohee-del.

### Added

- **Updates from the tray and the CLI** (#39). The tray checks for a new version at start and
  twice a day and offers it in its menu; **Check for Updates…** asks on demand. In a terminal:
  `clauderipple update` (`--check` only reports). It updates the way ClaudeRipple was
  installed — the install script again, or npm into the same prefix — and restarts the router
  on the new version. The standalone app points to the releases page instead.
- **Usage of each Claude subscription account** (#40): the five-hour and weekly limits of the
  current Claude login and of every account added in ClaudeRipple, on the Health screen, in the
  Claude provider's Accounts tab and in the tray menu. Read from the same endpoint Claude
  Code's `/usage` uses, so an account that has not answered anything yet still has a number.
- **The version in the tray's About box.**

### Fixed

- **Re-running the installer now restarts a router still running the old version.** Before,
  the files changed but the router kept the old code until the next login — on Windows and
  Linux always, since an unchanged task or service is not registered again.
- **The tray survives updates.** Its Electron (~270MB) was fetched into the package folder, and
  every update deleted it; on Windows a running tray could make the update fail. It now lives in
  `~/.clauderipple/tray-runtime`, and the install scripts move an existing copy there instead of
  fetching it again. An install made with plain `npm install -g` fetches it once more with
  `clauderipple tray --install`.
- **The tray installed from npm reports its own version**, not Electron's: its package manifest
  carried none.

## 0.5.1 — 2026-09-28

### Fixed

- **Prompt caching on anthropic-compatible providers** (#36, #37, by @grapefruit0205).
  Claude Code's billing header opens the system prompt and changes every turn, so a
  vendor with a plain prefix cache cached nothing after it: DeepSeek via Alibaba Bailian
  reported 0.3% over two days. The header is now dropped for these providers, as it
  already was for the translated ones; measured 99% on the next turns.
- **Switching a session from a translated model to Claude.** The translated providers
  return reasoning as unsigned, sometimes empty `thinking` blocks, and Anthropic refused
  every turn after the switch with "each thinking block must contain thinking". Unsigned
  thinking is now dropped before a request reaches Anthropic.
- **Windows install when the user name equals the computer name** (#38, reported by
  @haemilchu). The scheduled task is registered as `DOMAIN\user`; the bare name did not
  resolve and registration failed with 0x80070057 before `settings.json` was written.
- **Windows reinstall no longer re-registers a correct task.** The check read two
  battery settings under names the task object does not have, so it never matched and
  every install registered again — what fails on machines that protect the task.
  Checked in a Windows 11 VM.
- **`clauderipple` in a new PowerShell window** (#38). The installer leaves no `.ps1`
  shim, so PowerShell runs the `.cmd` under the default execution policy.

## 0.5.0 — 2026-09-24

Linux, and four fixes from the first outside contributions.

### Added

- **Linux** (#28, #33, #34, by @grapefruit0205). `install`, `status`, `restart` and
  `uninstall` work where there is a systemd user session: the router runs as
  `~/.config/systemd/user/clauderipple.service`, with no sudo. A health self-exit is
  restarted after two seconds, and a stop waits out the 90-second drain. Picker mode
  trusts the local CA in the NSS database Chromium reads (`~/.pki/nssdb`, your user
  only) and needs `certutil` (`libnss3-tools` / `nss-tools`). Measured by the
  contributor on Ubuntu 24.04 x64 with Claude Desktop 2.2553.13.

### Fixed

- **`npm test` no longer rewrites your real `~/.claude/settings.json`** (#16, #26, #30).
  The admin tests isolated the router's home but not the Claude settings path, so a
  test run pointed `NODE_EXTRA_CA_CERTS` at a temp directory it then deleted, and every
  Claude Code session on the machine failed until the file was fixed by hand.
- **A failed install leaves `settings.json` alone** (#27, #31). The proxy settings are
  now written only after the end-to-end probe passes, and `picker on` checks the
  router is answering before it points Claude Desktop at it.
- **Anthropic-compatible providers keep the conversation after a tool call** (#29, #32).
  Claude Code's `thread: continue` carries only the new messages; the router stripped
  the field and forwarded that delta, so the model got orphan tool results and no task.
  It is now refused as for the translated providers, and the CLI resends the full turn.
- **`picker on` and `status` from a PowerShell 7 terminal on Windows** (#35). Windows
  PowerShell inherited PowerShell 7's module path and lost the `Cert:` drive: `picker on`
  stopped at "Cannot find drive 'Cert'" and `status` called a trusted CA untrusted.
  Every `powershell.exe` we start now drops the inherited `PSModulePath`. Reproduced
  and checked in a Windows 11 VM.

## 0.4.1 — 2026-09-24

### Fixed

- **The tray starts from an npm install** (#8). After 0.3.1 it launched as
  Electron but died at once with "exports is not defined in ES module scope": the
  tray is CommonJS and the package root says `"type": "module"`. The tray now has
  its own `package.json`. Checked by starting it from the packed package.

## 0.4.0 — 2026-09-24

Several ChatGPT accounts, for Claude Desktop and for Codex.

### Added

- **Several ChatGPT accounts.** `clauderipple login` (or **+ Add ChatGPT account**
  in the dashboard) adds an account instead of replacing the one you had; the
  sign-in asks who is signing in, so the browser's current ChatGPT session is not
  silently reused. When an account hits its limit, the same request moves to the
  next one before anything reaches the client, and the spent account rests until
  the window the backend reports resets. A conversation stays on the account that
  answered, to keep its prompt cache. A 401 gets one token refresh and a replay;
  only a freshly minted token refused again asks for a new sign-in. Accounts live
  in `~/.clauderipple/chatgpt-accounts.json` (0600); the old single login is moved
  there on the first sign-in. The Codex CLI's own login still takes part, last.
- **Accounts tab for ChatGPT** in the dashboard: each account's 5-hour and weekly
  usage, when a resting one is back, and pause/resume, rename, remove, use now and
  sign in again.
- **Codex's GPT goes through the account pool.** `clauderipple codex on` now also
  points Codex's built-in OpenAI provider at ClaudeRipple. Codex keeps its ChatGPT
  sign-in; its GPT requests reach ChatGPT unchanged except for the account, so when
  one account runs out Codex carries on with the next — no sign-out. With no account
  added, or every one at its limit, Codex's own login is used. An `openai_base_url`
  of your own is never overwritten; `clauderipple codex off` undoes it.

### Changed

- `clauderipple logout` removes every ChatGPT account added with `login`.
- `/api/status` keeps `chatgpt.quota` (the account that answers next) and adds
  `chatgpt.accounts`, one entry per account.

## 0.3.1 — 2026-09-24

Fixes for three reports against 0.3.0.

### Fixed

- **Claude account rotation no longer breaks requests with a 400** (#15). With
  `accountPool` on, the account's `anthropic-beta` header replaced the client's,
  so fields Claude Code enables per request (`cache_control.scope`,
  `context_management`, …) were refused with `Extra inputs are not permitted`.
  A conversation pinned to an added account failed on every retry, because a
  400 does not move it. The account now supplies identity only: its OAuth flags
  are added to the client's, on the first attempt and on every retry.
- **The Windows tray appears** (#8). It was started with `ELECTRON_RUN_AS_NODE`
  set to an empty string, which macOS Electron treats as unset and Windows
  Electron treats as set, so on Windows the tray ran as plain Node and exited
  while the CLI reported "tray started". The variable is now removed.
- **GLM-5.3 and GLM-5.3 Flash in the Z.AI preset** (#14). Z.AI serves no model
  list, so the preset's list is the whole picker, and it stopped at GLM-5.2.

## 0.3.0 — 2026-09-23

Everything on `main` since 0.2.0. The account rotation that issue #8 asked for
was on `main` from 2026-09-20 while the README already described it, but no
release carried it. A user looking for the setting in 0.2.0 could not find it.

### Added

- **Claude subscription account rotation.** A native Anthropic provider can opt in
  with `accountPool: true` and use the current Claude Code/Desktop login followed by
  every OAuth account added through ClaudeRipple. Conversations stay on the account
  that answered to preserve the prompt cache; before any response reaches the client,
  429, 401 and transient upstream failures can move the same turn to the next account.
  Stored grants refresh independently with single-flight and compare-and-swap safety,
  rejected accounts are isolated until re-login, and the dashboard can rename or
  remove them without exposing a token or upstream account id. Existing single-account
  OAuth grants migrate to the private `~/.clauderipple/claude-accounts.json` file on
  the first pool write. This applies to native Claude Desktop/Claude Code Messages;
  the translated OpenAI ingress for Codex picks one highest-priority available login
  per request but deliberately does not rotate accounts.
- **ChatGPT subscription web search.** When `webSearch` explicitly names a
  ChatGPT provider, Claude Code's separate search request uses the subscription's
  Codex hosted-search tool instead of silently consuming Anthropic quota. The
  adapter requires a reported search and URL citations, preserves allowed-domain
  filters, and refuses unsupported blocked-domain filters.
- **New ChatGPT models appear without an update.** The model list is read from
  the Codex catalogue the subscription serves, not from a list in the code, so
  GPT-6 Sol and GPT-6 Luna showed up the day they shipped. If the catalogue
  cannot be read, a built-in list is used instead. Newly found models are
  offered unticked. Claude Opus 5.5 is in the Claude list.
- **Credential pools and route fallbacks.** A provider can hold several keys. A
  rate-limited or refused key rests until its cooldown ends, and the turn moves
  to the next key before the client sees the failure. A model slot can name
  fallback providers for when the primary has nothing usable left. The
  dashboard shows which credential is resting, and until when.
- **OpenCode Go and OpenCode Zen presets.** One OpenCode Go subscription is one
  preset covering all three of its endpoints, each with the session header its
  prompt cache needs. Each model's request format is taken from the vendor's
  published endpoint table. After a provider is saved, its models are measured
  for request format and effort levels instead of being assumed.
- **A ticked model is a subagent.** Every model ticked in the GUI gets a
  generated agent file. A model that only one provider carries routes there
  without a hand-written rule. A model no provider carries is refused with a
  message naming it, instead of being sent to Anthropic and coming back 404.
- **Web search in a routed session.** It reaches a provider that runs the
  search tool itself, uses ChatGPT's hosted search when configured, and is
  refused with a reason where no provider can run it.
- **Claude Code's own model slots as a setting.**

### Fixed

- **A cut-off stream is retried, not taken as the answer.** An upstream that
  closed the stream without finishing used to become an empty, successful
  turn. A subagent then stopped silently, which is how long Muse runs appeared
  to stall and die. The turn now fails as overloaded, and Claude Code retries it.
- **The Codex prompt cache holds across turns again.** The conversation is
  named to the Codex backend, which now keys its cache on that name.
- **The provider form no longer wipes settings it does not show.** Saving a
  ChatGPT provider in the GUI dropped fields such as `instructionsAppend`.
- **The request log shows a request's whole input.** A fully cached Anthropic
  turn used to read as a 2-token request. The model column no longer shows
  the agent file's default effort next to the effort that was actually sent.
- **Routed models keep their own context window,** including across a model
  switch, and tool names the wire rejects are rewritten and restored.
- **Screenshots in tool results survive translation.**

- **Remote Control works through the forward proxy.** Claude Code sends its
  registration, polling and heartbeat requests in HTTPS absolute-form rather
  than CONNECT. ClaudeRipple now rewrites only the request target, strips proxy
  headers and relays it over TLS outside model routing. The connection closes
  after one request so another proxy target cannot leak to the first origin.
- **Windows reinstall is idempotent without elevation.** An existing scheduled
  task is reused only when its action, principal, trigger, restart policy,
  execution limit, instance policy and battery settings all match the intended
  per-user task. A foreign or stale task is never trusted.

## 0.2.0 — 2026-09-16

The first release published to npm, and the reason the number moves to 0.2:
ClaudeRipple is installed with one command instead of a signed application,
and the Electron window is gone in favour of the dashboard in your own browser.

Why 0.1.1 did not help the Windows install that reported the 0.1.1 bugs: the
fixes were in the files, but the router that kept answering was the old
process. Nothing restarted it, and nothing could tell.

### Changed

- **Distribution is npm.** `npm install -g clauderipple && clauderipple install`.
  There is no per-platform build to make, nothing to sign, nothing to notarize and
  no Windows VM in the loop: one `npm publish` serves both platforms, and the
  arm64 Windows installer bug cannot reach anyone through this path. The cost is
  that the user needs Node 24. The published package is JavaScript, because Node
  refuses to strip types under `node_modules`; the electron-builder path is still
  there for a standalone app but is no longer required for a release.
- **One command installs everything, Node included.** `curl … install.sh | sh` on
  macOS, `irm … install.ps1 | iex` on Windows. The script uses a Node 24+ already
  on PATH and otherwise downloads the official build into `~/.clauderipple/runtime`,
  checked against the checksum nodejs.org publishes, then runs setup. The package
  goes under its own prefix, so nothing needs elevation and uninstalling is one
  directory. The Node version is resolved at install time rather than pinned.
- **The tray is a command, and its runtime is fetched on request.** `clauderipple
  tray` starts the menu-bar / tray app; `--install` fetches Electron the first
  time. Electron is 270MB and is not a dependency, so a plain install is under a
  megabyte and every other command works without it.

### Added

- **Claude subscription sign-in from the app.** "Connect Claude subscription…"
  in the GUI (and `clauderipple claude-login`) now runs ClaudeRipple's own
  browser sign-in: the same OAuth flow with PKCE that Claude Code uses, with the
  code returning to a loopback listener on port 54545 or, when that port is
  taken, pasted from Anthropic's page. No terminal needed. The grant is stored
  in `~/.clauderipple/claude-auth.json` (mode 0600) and refreshed automatically
  before it expires; a failed refresh becomes a clear 401 instead of a dead
  token. `--setup-token` keeps the previous terminal-only path. Tray →
  "Connect Claude subscription" runs the same flow.
- **Readiness, not only liveness.** `/api/status.readiness` and `GET /readyz`
  (200, or 503 with `retry-after`) name what stands between a request and a
  model: Claude Code not pointed at ClaudeRipple, Anthropic unreachable, picker
  mode without certificate trust or the app proxy entry, a provider host that
  does not answer. The tray shows the list next to "Connected".
- **The stored sign-in is reported separately from the one in use.** A live
  Claude Desktop session outranks ClaudeRipple's own credential, so the provider
  screen now names both: the source a request would use, and, on its own line,
  whether a ClaudeRipple sign-in is stored and waiting behind it. Without this a
  successful sign-in changed nothing on screen.
- **A model removed from a provider leaves the app picker.** Unticking a model
  rewrote the provider but left its entry in `cli.extraModels` and its `direct`
  rule behind, and the next save read that entry back as a selection. Since the
  tick list is built from the providers, such an entry had no checkbox and could
  never be removed; duplicated ids appeared twice in the picker. The selection is
  now rebuilt from what the providers actually offer, deduplicated by model id,
  and a direct rule that served only a removed model goes with it. A prefix rule
  that is not a model id, such as the legacy `gpt-` one, is kept.
- **Every provider can tell the model what it is.** The identity line and the
  system-prompt addendum were ChatGPT-only, so a mapped DeepSeek read Claude
  Code's own prompt and answered that it was Claude. Anthropic-compatible and
  OpenAI-compatible providers now carry the same two settings, on by default,
  and the GUI offers them under Advanced for every provider.
- **HTML error pages are called out.** A provider that answers with a web page
  (a bare vendor domain, a login wall) is logged as "HTML page … not an API"
  instead of a quoted markup fragment.

### Fixed

- **`uninstall --purge` removes the home directory on Windows.** It unregistered
  the scheduled task but left the router running, and a running router holds
  `router.log` open, so the removal failed with `EPERM` and left everything
  behind. The router is stopped first now, and the removal is retried briefly
  while Windows releases the handle.

- **An update now replaces the running router.** Installing a new version only
  replaces files; the supervisor had started the router at logon from the old
  ones, and `start` leaves a running router alone, so the old code kept serving
  after every update. A zip unpacked into a new folder was worse: the
  supervisor and `paths.json` still named the old folder, so even a restart
  brought the old code back. The tray app now compares the running router's
  version and files with its own once per launch; if they differ it re-runs
  `install` (only when this installation's files are not the recorded ones) and
  restarts the router, with a notification. A source checkout recorded in
  `paths.json` is left alone.
- **Windows: "Restart Router" restarts the router.** The packaged router runs
  as `ClaudeRipple.exe` (Electron as Node), but the process lookup only knew
  `node.exe`, so on every packaged install `restart` found nothing to stop,
  and the scheduled task ignored the start request because it was already
  running. Nothing was restarted, and the command still said "restarted". The
  lookup now matches either executable. Until 0.1.2, the only ways to get a
  new router on a packaged Windows install were the installer (whose own stop
  script did look for `ClaudeRipple.exe`), signing out and in, or a reboot.
- **The router reports its real version.** It said `0.1.0` in 0.1.1 (a literal
  in two places). One `VERSION` constant now feeds the router, the CLI and the
  status page, and a test fails when it drifts from the package manifests.
- **Provider errors are logged with their body.** A 4xx/5xx from a provider or
  from Anthropic recorded only the status; a DeepSeek `401` stayed unexplained
  for a day. The first 300 characters of the error body now go into the router
  log and the Logs page, with anything key-shaped reduced to its last four
  characters. `/api/status` also reports which files the router is running and
  when it started.
- **`claude setup-token` from the app no longer hangs or fails silently.** It
  is an interactive terminal flow; run from the tray or the GUI it waited for
  input that never came or failed with a bare "setup-token failed". That path
  is now `claude-login --setup-token` only, refuses without a terminal with a
  message that says where to run it, and includes what `claude` printed when
  it fails. The app uses the browser sign-in above instead.

## 0.1.1 — 2026-09-15

All four were reported from a Windows install and reproduced here.

### Fixed

- **A mapped request now carries provider authentication only.** The caller's
  own `authorization` and `x-api-key` are dropped before the provider's headers
  are added. Previously only the header that happened to share a name with the
  provider's was replaced, which differs per provider: DeepSeek and MiniMax
  authenticate with `x-api-key`, everything else with `Authorization: Bearer`.
  A DeepSeek mapping answered `401` on every request while the provider form's
  own "Test connection" stayed green — the test sends the provider's headers
  alone, so it certified a path live traffic did not take. An un-routed request
  is unchanged; it really is going to Anthropic.
- **Mapping Haiku 4.5 works.** The app sends `claude-haiku-4-5-20251001` while
  the GUI offers the undated `claude-haiku-4-5`, and route lookup was an exact
  key match, so the mapping never fired and Haiku answered itself. Lookup now
  accepts either form.
- **The native Claude (Anthropic) provider is no longer offered as a mapping
  target.** It serves the OpenAI ingress (Codex) only, but it could be picked in
  Model mapping and given picker entries, and a slot pointed at it failed every
  Claude request with `400`. It is out of the mapping list, creates no picker
  entries, and an existing config that names it passes through instead of
  failing.
- **Windows: "Connect Claude subscription" works.** CLI discovery looked for an
  extensionless `claude` on `PATH` and for the macOS Application Support cache,
  so it always reported "Claude Code CLI not found". It now looks for the
  `.exe`/`.cmd`/`.bat` launchers, checks both AppData roots for the CLI that
  Claude Desktop caches, and runs a `.cmd` launcher through a shell.
  `clauderipple status` reported the cached CLI version from the macOS path too.

## 0.1.0 — 2026-09-14 (first release: macOS + Windows)

The source was published on 2026-09-13; this is the first build. Everything
under "0.1.0 — 2026-09-13" below is included.

### Windows support

ClaudeRipple runs on Windows. Everything was verified end to end against a real
Claude Desktop on Windows 11 arm64 (VM) and on x64 hardware: the picker lists
provider models by name, selecting one routes the call, and the model answers
with its reasoning effort intact.

- Supervisor: a per-user scheduled task, registered without administrator rights.
  It starts the router at logon, and the launcher supervises the process itself —
  Task Scheduler's restart setting only covers failing to *start* a task, so a
  crash would otherwise go unnoticed.
- Certificate trust for the current user only (`Cert:\CurrentUser\Root`). Windows
  shows a confirmation dialog with the fingerprint instead of asking for a
  password; no UAC prompt, and removal asks again.
- Graceful restart over `POST /api/shutdown`, because Windows has no SIGTERM.
- Installer: per-user NSIS, no elevation. **Unsigned** — see the README note.
  Reinstalling and uninstalling stop the supervisor and drain the router first
  (it kept running as `ClaudeRipple.exe` after the tray app closed, so the
  installer failed with "could not be closed" and no hint what to close); the
  uninstaller also undoes the settings.json edits and picker mode while the
  bundled runtime still exists.

### Fixed

- **"Show in the Claude app picker" did nothing on its own.** The provider form's
  checkbox only recorded which models to show; picker mode stayed off and the
  picker never changed, with no message (Windows x64, 2026-09-14). The form now
  says so and offers to turn picker mode on right after saving.
- **ChatGPT sign-in from the GUI.** The provider card said "sign-in needed" and
  gave no way to do it; it has a button now, and the sign-in runs in the
  background while the card waits for the browser to finish.
- **Language.** The tray, notifications and the GUI came up in English on a
  Korean Windows: `app.getLocale()` is Chromium's app locale, not the language
  the user set. The OS preference list is used instead, and the GUI follows it
  unless a language was picked in the GUI itself.

- **Startup.** After a reboot the router could listen minutes after login, and
  Claude Desktop was a blank `ERR_PROXY_CONNECTION_FAILED` window the whole time
  (in picker mode the app has no direct fallback). The launchd agent is no longer
  a throttled `Background` job, `listen()` comes before certificate minting, and
  every start logs its budget. `start` is idempotent: it used to kill a router
  that was still coming up.
- **The app now says what is wrong.** A login item so the tray is there before
  Claude Desktop is, an offline notice that names the cause instead of the
  router-served GUI it cannot load, and a notification after 20s down.
- **Certificates are issued by `node:crypto`**, with no `openssl` binary and no
  new dependency — which is also what let Windows work at all.
- **Security: the admin API refused no cross-site requests.** Binding to
  127.0.0.1 does not keep the browser out: any page could POST to it, and CORS
  hides only the response, not the side effect. Requests carrying another site's
  `Origin` are refused.
- The model mapping table listed every model twice and offered our own injected
  ids as mapping sources.
- The settings window opened smaller than its own content.
- The subagent title hook silently did nothing when its path contained a space.

## 0.1.0 — 2026-09-13 (first public alpha)

- Local HTTPS proxy for Claude Code: model mapping (Claude name → any provider
  model), per-request effort, graceful drain on restart, structured request log.
- ChatGPT subscription provider (Codex backend) with prompt-cache preservation
  (94–99% cache hit on multi-turn sessions), server-side thread fallback, and
  orphan tool-result handling.
- Anthropic-compatible providers with presets: DeepSeek, Kimi (Moonshot), Z.ai
  (GLM), MiniMax, Qwen (DashScope intl/cn), OpenRouter. Connection test and
  model discovery from the GUI; compatibility layer that strips Anthropic-only
  request features.
- Picker mode: your provider models appear under their real names in Claude
  Desktop's model picker (login-keychain trust, app config-library proxy).
- Subagent name tags (real model and effort in the background-task panel) via a
  Claude Code hook.
- Local GUI (Korean/English): status, model mapping with auto-save, providers,
  request log; menu-bar app that carries its own runtime and sets itself up on
  first launch. Signed and notarized macOS builds (arm64, x64).
- Works with the Claude Desktop Code tab, the terminal CLI, and mobile Remote
  Control sessions.

Known limits: macOS only; presets other than ChatGPT and OpenRouter are verified
against vendor docs, not with live keys; a model added to the picker is usable
from the next session.
