import { test } from "node:test";
import assert from "node:assert/strict";
import { apiKeyBetas } from "../src/proxy.ts";

test("an API key is sent the client's betas without the Claude Code sign-in ones", () => {
  // The app's own header: the sign-in pair and two feature betas.
  assert.equal(
    apiKeyBetas("claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27"),
    "interleaved-thinking-2025-05-14,context-management-2025-06-27",
  );
  // A key on a subscription's API credit refuses `claude-code-*` with billing_error 400 (2026-11-10).
  assert.equal(apiKeyBetas(["claude-code-20250219", "fine-grained-tool-streaming-2025-05-14"]), "fine-grained-tool-streaming-2025-05-14");
  assert.equal(apiKeyBetas("claude-code-20250219,oauth-2025-04-20"), undefined, "nothing left is no header");
  assert.equal(apiKeyBetas(undefined), undefined);
});
