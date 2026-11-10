// Which stored accounts a provider's pinned workers are derived from, in one place.
//
// A pinned worker runs on one stored account of a provider that keeps several: the Claude OAuth
// pool, ChatGPT subscriptions, and Google Antigravity. The CLI/Desktop login each of them may also
// use is the main account and is never in these stores, so it never gets a pinned worker.

import type { Provider } from "./config.ts";
import { readClaudeOAuthAccounts } from "./providers/anthropic-accounts.ts";
import { readChatGptAccounts } from "./providers/chatgpt/accounts.ts";
import { readGoogleAccounts } from "./providers/google/accounts.ts";

/** The stored-account fields a pinned worker is named, described and pinned from. */
export type PinnedAccount = { id: string; label: string; email?: string };

/** The stored accounts one provider may pin a worker to; empty when it has none of its own. */
export function storedAccountsFor(provider: Provider | undefined, home: string): readonly PinnedAccount[] {
  return accountsOf(provider, home).filter((account) => (account as { needsReauth?: boolean }).needsReauth !== true);
}

/**
 * Every stored account, before the ones waiting for a sign-in are left out: a worker for one of
 * those could only ever run on another account. Signing in again changes the list, so the worker
 * comes back on the next check.
 */
function accountsOf(provider: Provider | undefined, home: string): readonly PinnedAccount[] {
  if (!provider) return [];
  if (provider.type === "anthropic") return provider.auth === "claude-code" && provider.accountPool === true ? readClaudeOAuthAccounts(home) : [];
  // A provider borrowing the Codex CLI's login uses no store of ours; in every other mode its own
  // accounts are what it rotates through, and the Codex login stays out (it is the main account).
  if (provider.type === "chatgpt") return provider.auth === "borrow-codex" ? [] : readChatGptAccounts(home).filter((account) => provider.account === undefined || account.id === provider.account);
  if (provider.type === "google") return provider.auth === "antigravity" ? readGoogleAccounts(home) : [];
  return [];
}

/**
 * A fingerprint of the stored accounts the pinned workers are derived from, and of nothing else.
 * It holds exactly what a generated file shows: each configured provider, and for its accounts the
 * durable id a worker's name and model pin come from plus the label/email its description, title and
 * dashboard entry come from. A token refresh changes neither, so it never regenerates; a login,
 * logout, removal or relabel done by the terminal CLI — which the router is never told about —
 * always does. Sorted, so a store that merely reorders its accounts is not a change.
 */
export function storedAccountsSignature(providers: Record<string, Provider | undefined>, home: string): string {
  const parts: string[] = [];
  for (const name of Object.keys(providers).sort()) {
    const provider = providers[name];
    if (!provider) continue;
    for (const account of storedAccountsFor(provider, home)) {
      parts.push([name, account.id, account.label, account.email ?? ""].join("\u0000"));
    }
  }
  return parts.join("\u0001");
}
