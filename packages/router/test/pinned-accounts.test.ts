// Pinned workers are provider-generic: every provider that keeps stored accounts (Claude OAuth,
// ChatGPT, Google Antigravity) gets one per declared model × account, and one shared helper decides
// whether a pin can answer the turn. The CLI/Desktop login is the main account and is never pinned.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DEFAULTS, type Config, type Provider } from "../src/config.ts";
import { generatedAgents, syncAgentFiles } from "../src/agents.ts";
import { storedAccountsFor } from "../src/pinned-accounts.ts";
import { CredentialPool, pinnedCredential } from "../src/pool.ts";
import { markClaudeAccountNeedsReauth, saveClaudeOAuthAccount } from "../src/providers/anthropic-accounts.ts";
import { saveChatGptAccount, updateChatGptAccount, removeChatGptAccount } from "../src/providers/chatgpt/accounts.ts";
import { saveGoogleAccount, updateGoogleAccount } from "../src/providers/google/accounts.ts";
/** packages/mod/hooks/workers.ts `agentProvider`, which test/mod/workers.test.ts checks on the same shape. */
const modAgentProvider = (file: string): string | undefined => /^description:\s*.*?\bvia\s+([A-Za-z0-9_-]+)\./m.exec(file)?.[1]?.toLowerCase();

const tempHome = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "cr-pinned-"));
const grant = { accessToken: "tok", refreshToken: "rt", expiresAt: Date.now() + 3_600_000 };

test("each account-holding provider resolves its own store; keys and the borrow-codex login resolve none", () => {
  const home = tempHome();
  const claude = saveClaudeOAuthAccount(home, { ...grant, accountId: "claude-upstream", email: "mambo@example.test" });
  const chatgpt = saveChatGptAccount(home, { ...grant, accountId: "chatgpt-account" });
  const google = saveGoogleAccount(home, { ...grant, projectId: "proj-1", email: "gwork@example.test" });
  const ids = (provider: Provider) => storedAccountsFor(provider, home).map((account) => account.id);

  assert.deepEqual(ids({ type: "anthropic", auth: "claude-code", accountPool: true }), [claude.id]);
  assert.deepEqual(ids({ type: "anthropic", auth: "api-key", apiKey: "k" }), [], "an API key has no stored account");
  assert.deepEqual(ids({ type: "anthropic", auth: "claude-code" }), [], "no account pool, no pinned workers");
  assert.deepEqual(ids({ type: "chatgpt", auth: "own" }), [chatgpt.id]);
  assert.deepEqual(ids({ type: "chatgpt" }), [chatgpt.id], "the default auto mode uses its own accounts too");
  assert.deepEqual(ids({ type: "chatgpt", auth: "borrow-codex" }), [], "the Codex CLI's login is the main account");
  assert.deepEqual(ids({ type: "google", auth: "antigravity" }), [google.id]);
  assert.deepEqual(ids({ type: "google", auth: "api-key", apiKey: "k" }), []);
  // An account waiting for a sign-in could only ever fall back: no worker until it signs in again.
  assert.ok(markClaudeAccountNeedsReauth(home, claude.id, grant.refreshToken));
  assert.deepEqual(ids({ type: "anthropic", auth: "claude-code", accountPool: true }), []);
});

test("a pinned worker is generated for every stored account of every kind, and removed with it", (t) => {
  const home = tempHome();
  const dir = path.join(home, "agents");
  const manifest = path.join(home, "generated-agents.json");
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const claude = saveClaudeOAuthAccount(home, { ...grant, accountId: "claude-upstream", email: "mambo@example.test" });
  const chatgpt = saveChatGptAccount(home, { ...grant, accountId: "chatgpt-account" });
  updateChatGptAccount(home, chatgpt.id, { label: "gpt-work" });
  const google = saveGoogleAccount(home, { ...grant, projectId: "proj-1", email: "gwork@example.test" });
  updateGoogleAccount(home, google.id, { label: "gwork" });

  const cfg: Config = {
    ...DEFAULTS,
    providers: {
      anthropic: { type: "anthropic", auth: "claude-code", accountPool: true, models: [{ id: "claude-opus-5-5", name: "Claude Opus 5.5" }] },
      chatgpt: { type: "chatgpt", auth: "own", models: [{ id: "gpt-6.1-sol", name: "GPT-6.1 Sol" }] },
      google: { type: "google", auth: "antigravity", models: [{ id: "gemini-4-argon" }] },
    },
    routes: {}, direct: [], aliases: {},
  };
  const accountsFor = (provider: Provider) => storedAccountsFor(provider, home);
  const sync = () => syncAgentFiles(cfg, dir, undefined, { manifestPath: manifest, pinnedAccounts: accountsFor });

  sync();
  const pinnedFiles = [
    [`claude-opus-5-5-${claude.id.slice(0, 8)}`, `anthropic#${claude.id.slice(0, 8)}:claude-opus-5-5`],
    [`gpt-6-1-sol-${chatgpt.id.slice(0, 8)}`, `chatgpt#${chatgpt.id.slice(0, 8)}:gpt-6.1-sol`],
    [`gemini-4-argon-${google.id.slice(0, 8)}`, `google#${google.id.slice(0, 8)}:gemini-4-argon`],
  ] as const;
  for (const [name, model] of pinnedFiles) {
    const file = fs.readFileSync(path.join(dir, `${name}.md`), "utf8");
    assert.match(file, new RegExp(`\\nname: ${name}\\n`), name);
    assert.match(file, new RegExp(`\\nmodel: ${model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n`), `${name} pins its account`);
    assert.match(file, /Start the Agent description with "/, "the title convention survives");
    // The mod finds a worker's provider in "via <provider>."; without it naming one ran the ladder.
    assert.equal(modAgentProvider(file), model.split("#")[0], `${name}: the mod reads its provider`);
  }
  assert.match(fs.readFileSync(path.join(dir, `claude-opus-5-5-${claude.id.slice(0, 8)}.md`), "utf8"), /Start the Agent description with "5\.5·mambo · "/, "the label shows in prose even though it is not in the name");
  assert.match(fs.readFileSync(path.join(dir, `gpt-6-1-sol-${chatgpt.id.slice(0, 8)}.md`), "utf8"), /Runs on gpt-work \(account /, "the description names the account, not a Claude-only word");
  assert.deepEqual(generatedAgents(cfg, dir, manifest, undefined, accountsFor).map((agent) => [agent.name, agent.model, agent.provider, agent.account]), [
    ["claude-opus-5-5", "claude-opus-5-5", "anthropic", undefined],
    [`claude-opus-5-5-${claude.id.slice(0, 8)}`, "claude-opus-5-5", "anthropic", "mambo"],
    ["gemini-4-argon", "gemini-4-argon", "google", undefined],
    [`gemini-4-argon-${google.id.slice(0, 8)}`, "gemini-4-argon", "google", "gwork"],
    ["gpt-6-1-sol", "gpt-6.1-sol", "chatgpt", undefined],
    [`gpt-6-1-sol-${chatgpt.id.slice(0, 8)}`, "gpt-6.1-sol", "chatgpt", "gpt-work"],
  ]);

  removeChatGptAccount(home, chatgpt.id);
  sync();
  assert.equal(fs.existsSync(path.join(dir, `gpt-6-1-sol-${chatgpt.id.slice(0, 8)}.md`)), false, "the removed account's worker goes");
  assert.ok(fs.existsSync(path.join(dir, "gpt-6-1-sol.md")), "the ordinary worker stays");
  assert.ok(fs.existsSync(path.join(dir, `claude-opus-5-5-${claude.id.slice(0, 8)}.md`)), "another provider's pin is untouched");
  assert.ok(fs.existsSync(path.join(dir, `gemini-4-argon-${google.id.slice(0, 8)}.md`)));
});

test("pinnedCredential answers only for a present, usable account; the caller keeps the fallback", () => {
  const pool = new CredentialPool();
  const credentials = [
    { id: "a", ownerId: "aaaaaaaa-1111-4111-8111-111111111111", headers: {} },
    { id: "b", ownerId: "bbbbbbbb-2222-4222-8222-222222222222", headers: {} },
  ];
  assert.equal(pinnedCredential("p", credentials, "bbbbbbbb", pool)?.id, "b", "the pinned account wins over the order");
  assert.equal(pinnedCredential("p", credentials, undefined, pool), undefined, "no pin, no opinion");
  assert.equal(pinnedCredential("p", credentials, "cccccccc", pool), undefined, "an absent account falls back");
  assert.equal(pinnedCredential("p", credentials.slice(0, 1), "bbbbbbbb", pool), undefined, "an account this turn already spent is not retried");

  assert.equal(pinnedCredential("p", [credentials[0]!, { ...credentials[1]!, paused: true }], "bbbbbbbb", pool), undefined, "a paused pin falls back");
  pool.penalise("p", "b", 429, 60_000);
  assert.equal(pinnedCredential("p", credentials, "bbbbbbbb", pool), undefined, "a cooling pin falls back");
  pool.clear("p", "b");

  // A quota group resting is not the whole account resting, and the pin honours the same scope.
  pool.penalise("p", "b", 429, 60_000, "", "gemini");
  assert.equal(pinnedCredential("p", credentials, "bbbbbbbb", pool)?.id, "b");
  assert.equal(pinnedCredential("p", credentials, "bbbbbbbb", pool, "gemini"), undefined);
});
