# ClaudeRipple — project rules

- Read `docs/ARCHITECTURE.md` before touching routing, TLS, or provider code.
  Every fact there has a source; do not re-derive or contradict it without new
  evidence. Section 5 lists failure modes that must not be reintroduced.
- Reference implementations (proxenos, chatgpt-codex-proxy) are behavioral
  specs only. **Never copy code from them.** Own implementation in TypeScript.
- The live Python prototype at `~/.local/share/claude-router/` is the user's
  daily driver. Do not modify it, and never bind its port (8790). Test on a
  separate port and a separate `settings.json` env only when the user asks.
- Product boundary: Code tab + subagents. Do not spend effort on general chat.
- Acceptance metrics are non-negotiable: zero vanished requests, ≥90% cache
  hit on translated providers, remote-control workers survive upstream failure.
- Language: TypeScript. Node 24. No Python in the product.
- Trademarks: keep the "not affiliated" notice in README and app About screen.
