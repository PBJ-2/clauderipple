# Roadmap

Last decided: 2026-11-12.

## Goal

One install for everything a Claude Code or Codex user needs. Every request
already passes through the router, so ClaudeRipple can see cost, cache, limits
and accounts in one place. The plan is to turn that into the tools people keep
asking for elsewhere.

Each item is chosen by three criteria:

1. People actually want it. We count reactions on public issues.
2. Only we can do it, because every request goes through the router.
3. It can start small.

Reaction counts below are thumbs-up on anthropics/claude-code issues. For
openai/codex issues they are all reactions, so the two are not comparable.

## Already shipped

- Routing to other models (ChatGPT, Gemini, DeepSeek, MiniMax and more) with
  the prompt cache kept, and failover to another model when one fails.
- Several accounts in one pool, a limit gauge per account, and a limit forecast.
- The ripple mod: automatic reasoning effort, worker ladders, cache warm-up.
- Usage and cost history, and a Logs view with cache reads and writes.
- Ripple Remote, the phone app: remote control, approvals, photos,
  notifications, sessions per working folder, end-to-end encryption, foldables
  and tablets.
- Small background jobs (such as titles) on a cheap model, handling of stalled
  responses, and keep-awake.

## Phase 1: see where your limit goes

This comes first.

| Item | What you get | Evidence | Owner |
|---|---|---|---|
| Why the cache broke | One line on each Logs row saying why the request was expensive: idle for over 5 minutes, system prompt changed, model changed, and so on. No tool does this today. | [anthropics/claude-code#16157](https://github.com/anthropics/claude-code/issues/16157) (697), [#38335](https://github.com/anthropics/claude-code/issues/38335) (477), [#46829](https://github.com/anthropics/claude-code/issues/46829) (244) | |
| What is in a request | Tokens for system prompt, tools, conversation and tool results, per request. The next phases build on it. | [openai/codex#23794](https://github.com/openai/codex/issues/23794) (253), [openai/codex#19464](https://github.com/openai/codex/issues/19464) (241) | |
| Limit forecast alerts | "At this pace you run out at 3 pm." Counts idle nights and weekends. Alerts reach the phone and the tray. | Named in 5 of 9 research reports | |
| Task-finished alerts | Desktop notification and sound when a task ends. ntfy and webhooks. | [openai/codex#2109](https://github.com/openai/codex/issues/2109) (689) | |
| Safety guard | Block dangerous commands such as `rm -rf` and reads of secret files. Blocked actions are listed on the dashboard and the phone. | [openai/codex#59060](https://github.com/openai/codex/issues/59060) (3,491), a server-deletion incident | |
| Describe images for text-only models | When a request with an image goes to a model that cannot read images, another model describes the image first. | Four competing routers already do this | |

## Phase 2: settings in one place

| Item | What you get | Evidence | Owner |
|---|---|---|---|
| Extensions page | Plugins, MCP servers, skills and hooks in one list with on and off switches. Shows the tokens each one really costs, measured from traffic. Warns before a change breaks the cache. | [anthropics/claude-code#6235](https://github.com/anthropics/claude-code/issues/6235) (5,192, the most-reacted issue we found), [#31005](https://github.com/anthropics/claude-code/issues/31005) (462). The MCP manager mcp-router has stopped. | |
| One-click popular bundles | Install well-known setups with one button. Examples: [ECC](https://github.com/affaan-m/ECC) (formerly everything-claude-code) and [claude-mem](https://github.com/thedotmack/claude-mem). | The most popular repositories in this space | |
| One rules file | Keep CLAUDE.md and AGENTS.md from a single source, shared by Claude and Codex. | Same issues as the extensions page | |

## Phase 3: memory

Keep context across sessions and across months.

- **Automatic records.** Every session is distilled daily into decisions,
  records and open items. That includes sessions routed to GPT, Gemini and
  other models, not only Claude. The result is a plain Markdown folder. It
  works with an Obsidian vault or any Markdown folder.
- **Pick up where you left off.** On session start, a short note says where the
  project stood and what was decided last time.
- **Relevant decisions on a matching prompt.** Only the two or three past
  decisions that match the prompt are added. We do not push everything in. An
  earlier attempt injected 3,069 items and only 5 were used.
- **A warning before editing a matching file.** The decisions tied to that file
  appear at that moment. Pending: we first test whether the engine allows it.
- **A search tool.** Claude and workers can search memory themselves. The
  dashboard and the phone can search too.
- **Usage measured.** We check whether injected memories were actually used and
  drop the ones that are not.

## Phase 4: accounts handled for you

| Item | What you get | Evidence | Owner |
|---|---|---|---|
| Smarter account choice ([#137](https://github.com/PBJ-2/clauderipple/issues/137)) | Use the account whose weekly limit resets soonest first. Starts by only logging the account it would have picked. A notice about the provider's terms is shown when you turn it on. | [anthropics/claude-code#18435](https://github.com/anthropics/claude-code/issues/18435) (1,028), [#36151](https://github.com/anthropics/claude-code/issues/36151) (776). Named in 6 of 9 research reports. | `contributor: RedBoardDev` |
| Continue after the limit | When every account is blocked, hold the request and send it when a limit resets. | [anthropics/claude-code#73125](https://github.com/anthropics/claude-code/issues/73125) (388), [#13354](https://github.com/anthropics/claude-code/issues/13354) (211). We are the only tool that also works from the Code tab. | |
| Import accounts from other tools | Bring over accounts from claude-swap, CLIProxyAPI and Codex in one step. | | |

## Phase 5: save tokens, measured honestly

| Item | What you get | Evidence | Owner |
|---|---|---|---|
| Before and after meter | Compare real cost before and after turning on any saving tool, using our own request log. | | |
| RTK switch | Turn the RTK output shrinker on and off from the dashboard. Its cost benefit is unclear in measurements, so it ships together with the meter. | | `contributor: RedBoardDev` |
| Tool-result tidying | In the router: remove duplicate output and summarize large output, without breaking the cache. | | |
| Idle-time decision | Decide from cost whether to keep the cache warm, compact, or let it expire. | | |

## Later (order not set)

- Full-text search over all past conversations, with cost and model.
- Request inspector: why a request went to a given model.
- Ask several models the same question and compare.
- Hand work over between Claude and Codex.
- Model combination strategies.
- Spending caps.
- Secret scanning of outgoing requests.
- Bedrock and Vertex.
- Scheduled runs.
- A mod that improves the Claude app's screens.

## Contributor track

`contributor: RedBoardDev` has these items.

- A native macOS panel in Swift. It works over the admin API. Its edge is that
  it also shows other models and per-account limits.
- Mobile app redesign mockups: voice input, per-account limits on the phone, a
  lock-screen widget, commits and pull requests from the phone. The maintainers
  implement them, because the app source is private.
- Smarter account choice, [PBJ-2/clauderipple#137](https://github.com/PBJ-2/clauderipple/issues/137).
- The RTK switch.

## Not planned

- Sharing or reselling accounts. It violates the providers' terms.
- Prompt tricks that break the cache, or shortening the system prompt. Both
  make requests cost more.
- Collecting free accounts, and disguises that look like limit evasion.
- Bundling code under licences we keep out of the package (BUSL, AGPL and
  similar). ClaudeRipple is GPL-3.0.

## Open questions

- ChatGPT account rotation. We have heard that OpenAI's terms forbid it from
  2026-11-04. We have not read the original text yet. The decision waits for it.
- RTK redistribution. We will ask the RTK authors whether it may be included in
  the installer. Until they answer, we only detect or link it.

## How to propose a feature

- Open an issue. Feature requests are welcome. Say what you do and what gets in
  the way.
- Keep pull requests small. One reason per PR.
- Add tests. Keep the "not affiliated" notice in the README and in the app's
  About screen.

The earlier M1 to M5 milestones are in git history.
