# ClaudeRipple — project rules

- Read `docs/ARCHITECTURE.md` before touching routing, TLS, or provider code.
  Every fact there has a source; do not re-derive or contradict it without new
  evidence. Section 5 lists failure modes that must not be reintroduced.
- Reference implementations (proxenos, chatgpt-codex-proxy) are behavioral
  specs only. **Never copy code from them.** Own implementation in TypeScript.
- The live router is this repo, run by launchd (`com.clauderipple.router`,
  127.0.0.1:8791, admin 8792). It is the user's daily driver: never kill or
  restart it casually (`clauderipple restart` drains; see ARCHITECTURE §5).
  The Python prototype (`~/.local/share/claude-router/`, 8790) and proxenos
  (8787) were retired 2026-09-20 — do not consult or start them.
- Product boundary: Code tab + subagents. Do not spend effort on general chat.
- Acceptance metrics are non-negotiable: zero vanished requests, ≥90% cache
  hit on translated providers, remote-control workers survive upstream failure.
- Language: TypeScript. Node 24. No Python in the product.
- Trademarks: keep the "not affiliated" notice in README and app About screen.
