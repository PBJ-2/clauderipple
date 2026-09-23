// `clauderipple codex on|off`: installs only ClaudeRipple-owned TOML fragments.
// Codex 0.146 profiles are separate $CODEX_HOME/<name>.config.toml layers, so the default
// selection in config.toml is never changed. The provider definition is marked and removed exactly.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const START = "# >>> ClaudeRipple Codex provider >>>";
const END = "# <<< ClaudeRipple Codex provider <<<";
const PROFILE_START = "# >>> ClaudeRipple Codex profile >>>";
const PROFILE_END = "# <<< ClaudeRipple Codex profile <<<";
const CATALOG_START = "# >>> ClaudeRipple Codex model catalog >>>";
const CATALOG_END = "# <<< ClaudeRipple Codex model catalog <<<";
const OPENAI_START = "# >>> ClaudeRipple OpenAI route >>>";
const OPENAI_END = "# <<< ClaudeRipple OpenAI route <<<";
export const CODEX_PROVIDER_MARKER = START;

/** A model ClaudeRipple serves to Codex (Claude or an Anthropic-compatible provider's model). */
export type CatalogModel = { id: string; name?: string; provider: string; effortLevels: string[] };

export function codexHome(): string {
  return process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
}

function configFile(home = codexHome()): string {
  return path.join(home, "config.toml");
}

function profileFile(home = codexHome()): string {
  return path.join(home, "clauderipple.config.toml");
}

function backup(file: string): string | undefined {
  if (!fs.existsSync(file)) return undefined;
  const destination = `${file}.clauderipple-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  fs.copyFileSync(file, destination);
  return destination;
}

function withoutOwnedBlock(content: string, start: string, end: string): string {
  const startAt = content.indexOf(start);
  if (startAt < 0) return content;
  const endAt = content.indexOf(end, startAt);
  if (endAt < 0) throw new Error(`refusing to edit ${start}: end marker is missing`);
  const after = endAt + end.length;
  const trailing = content.slice(after).replace(/^\r?\n/, "");
  return (content.slice(0, startAt).replace(/\s*$/, "") + (content.slice(0, startAt).trim() && trailing.trim() ? "\n\n" : "") + trailing).replace(/^\s+/, "");
}

function appendBlock(content: string, block: string): string {
  const base = content.trimEnd();
  return `${base}${base ? "\n\n" : ""}${block}\n`;
}

function providerBlock(port: number): string {
  return `${START}
[model_providers.clauderipple]
name = "ClaudeRipple local ingress"
base_url = "http://127.0.0.1:${port}/v1"
wire_api = "responses"
${END}`;
}

function catalogFile(home = codexHome()): string {
  return path.join(home, "clauderipple-models.json");
}

/**
 * Codex lists models from its catalog (`model_catalog_json` overrides the bundled one; measured with
 * 0.146: the file is `{ models: [...] }` in the shape of Codex's own `models_cache.json`, and each
 * entry additionally needs `base_instructions` and `supports_parallel_tool_calls`; when an entry
 * carries `model_messages.instructions_template` Codex renders that as the system prompt and ignores
 * `base_instructions`). We copy the cached OpenAI entries as they are — so the app keeps its GPT
 * list — and append ClaudeRipple's models built from the cached `gpt-5.5` entry (same tools,
 * same instructions template). Without a cache (Codex never signed in) there is nothing to copy
 * from and the catalog is skipped: Codex then works but shows the model as "custom".
 */
export function writeCodexCatalog(models: CatalogModel[], home = codexHome()): string | undefined {
  const cache = path.join(home, "models_cache.json");
  if (!fs.existsSync(cache)) return undefined;
  let cached: { models?: Record<string, unknown>[] };
  try {
    cached = JSON.parse(fs.readFileSync(cache, "utf8")) as { models?: Record<string, unknown>[] };
  } catch {
    return undefined;
  }
  const entries = (cached.models ?? []).filter((m) => typeof m.slug === "string");
  const template = entries.find((m) => m.slug === "gpt-5.5" && m.model_messages) ?? entries.find((m) => m.model_messages);
  if (!template) return undefined;
  const ours = models.map((m, i) => ({
    ...template,
    slug: m.id,
    display_name: m.name ?? m.id,
    description: `via ClaudeRipple (${m.provider})`,
    default_reasoning_level: m.effortLevels.includes("medium") ? "medium" : (m.effortLevels[0] ?? "medium"),
    supported_reasoning_levels: m.effortLevels.map((effort) => ({ effort, description: effort })),
    visibility: "list",
    supported_in_api: true,
    priority: 100 + i,
    additional_speed_tiers: [],
    service_tiers: [],
    availability_nux: null,
    upgrade: null,
    context_window: 200000,
    max_context_window: 200000,
    base_instructions: "",
    supports_parallel_tool_calls: true,
  }));
  const theirs = entries.filter((m) => !models.some((o) => o.id === m.slug)).map((m) => ({ base_instructions: "", supports_parallel_tool_calls: true, ...m }));
  const file = catalogFile(home);
  fs.writeFileSync(file, JSON.stringify({ models: [...theirs, ...ours] }, null, 1), { mode: 0o600 });
  return file;
}

function catalogBlock(file: string): string {
  return `${CATALOG_START}
model_catalog_json = ${JSON.stringify(file)}
${CATALOG_END}`;
}

/** Top-level keys must precede any `[table]`, so the catalog block goes first. Never overrides a user's own setting. */
function withCatalog(content: string, file: string | undefined): string {
  const stripped = withoutOwnedBlock(content, CATALOG_START, CATALOG_END);
  if (!file || /^\s*model_catalog_json\s*=/m.test(stripped)) return stripped;
  return `${catalogBlock(file)}\n\n${stripped}`.replace(/\n+$/, "\n");
}

/**
 * Codex's built-in `openai` provider pointed at our ingress (`openai_base_url`, a root key). Codex
 * keeps its ChatGPT sign-in and sends GPT turns here; the ingress passes them to the ChatGPT backend
 * on one of the signed-in accounts, so running out on one account moves Codex to the next without
 * a sign-out. A user's own `openai_base_url` is left alone (and then this does not apply).
 */
function withOpenAiRoute(content: string, port: number | undefined): string {
  const stripped = withoutOwnedBlock(content, OPENAI_START, OPENAI_END);
  if (port === undefined || /^\s*openai_base_url\s*=/m.test(beforeFirstTable(stripped)[0])) return stripped;
  const block = `${OPENAI_START}\nopenai_base_url = "http://127.0.0.1:${port}/v1"\n${OPENAI_END}`;
  return `${block}\n\n${stripped}`.replace(/\n+$/, "\n");
}

/** Whether Codex's own GPT traffic goes through ClaudeRipple (our route block is in place). */
export function codexOpenAiRouted(home = codexHome()): boolean {
  try {
    return fs.readFileSync(configFile(home), "utf8").includes(OPENAI_START);
  } catch {
    return false;
  }
}

function profileBlock(): string {
  return `${PROFILE_START}
model_provider = "clauderipple"
${PROFILE_END}`;
}

/** The head of a TOML document, before its first table header — where Codex keeps the default selection. */
function beforeFirstTable(content: string): [head: string, rest: string] {
  const at = content.search(/^[ \t]*\[/m);
  return at < 0 ? [content, ""] : [content.slice(0, at), content.slice(at)];
}

/**
 * Codex writes the model picked from our catalog into config.toml's own head, outside our markers:
 * `model_provider = "clauderipple"` and the model id. Removing the provider block while that
 * reference stays makes Codex refuse to start at all — "Model provider `clauderipple` not found",
 * and no `codex` command runs until it is edited by hand — so `off` drops the dangling pair. The
 * `model` line is ours to remove only while it names our provider; standing alone it is the user's.
 */
function withoutDanglingSelection(content: string): string {
  const [head, rest] = beforeFirstTable(content);
  const selectsUs = /^[ \t]*model_provider[ \t]*=[ \t]*(["'])clauderipple\1[ \t]*\r?\n?/m;
  if (!selectsUs.test(head)) return content;
  return head.replace(selectsUs, "").replace(/^[ \t]*model[ \t]*=[ \t]*(["'])[^\n]*\1[ \t]*\r?\n?/m, "") + rest;
}

export type CodexEdit = { changed: boolean; backup?: string; profileBackup?: string; config: string; profile: string };

/** Install provider in config.toml plus selection in the dedicated `clauderipple` profile. */
export function codexOn(port: number, home = codexHome(), models: CatalogModel[] = []): CodexEdit {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const config = configFile(home);
  const profile = profileFile(home);
  const beforeConfig = fs.existsSync(config) ? fs.readFileSync(config, "utf8") : "";
  const beforeProfile = fs.existsSync(profile) ? fs.readFileSync(profile, "utf8") : "";
  const catalog = models.length ? writeCodexCatalog(models, home) : undefined;
  const nextConfig = withOpenAiRoute(withCatalog(appendBlock(withoutOwnedBlock(beforeConfig, START, END), providerBlock(port)), catalog), port);
  const nextProfile = appendBlock(withoutOwnedBlock(beforeProfile, PROFILE_START, PROFILE_END), profileBlock());
  if (nextConfig === beforeConfig && nextProfile === beforeProfile) return { changed: false, config, profile };
  const configBackup = backup(config);
  const profileBackup = backup(profile);
  fs.writeFileSync(config, nextConfig, { mode: 0o600 });
  fs.writeFileSync(profile, nextProfile, { mode: 0o600 });
  return { changed: true, ...(configBackup ? { backup: configBackup } : {}), ...(profileBackup ? { profileBackup } : {}), config, profile };
}

/** Remove only blocks with our exact sentinels. Keeps all user config and profile values. */
export function codexOff(home = codexHome()): CodexEdit {
  const config = configFile(home);
  const profile = profileFile(home);
  const beforeConfig = fs.existsSync(config) ? fs.readFileSync(config, "utf8") : "";
  const beforeProfile = fs.existsSync(profile) ? fs.readFileSync(profile, "utf8") : "";
  const nextConfig = withoutDanglingSelection(withoutOwnedBlock(withoutOwnedBlock(withoutOwnedBlock(beforeConfig, START, END), CATALOG_START, CATALOG_END), OPENAI_START, OPENAI_END));
  const nextProfile = withoutOwnedBlock(beforeProfile, PROFILE_START, PROFILE_END);
  fs.rmSync(catalogFile(home), { force: true });
  if (nextConfig === beforeConfig && nextProfile === beforeProfile) return { changed: false, config, profile };
  const configBackup = backup(config);
  const profileBackup = backup(profile);
  if (nextConfig) fs.writeFileSync(config, nextConfig.endsWith("\n") ? nextConfig : `${nextConfig}\n`, { mode: 0o600 });
  else fs.rmSync(config, { force: true });
  if (nextProfile) fs.writeFileSync(profile, nextProfile.endsWith("\n") ? nextProfile : `${nextProfile}\n`, { mode: 0o600 });
  else fs.rmSync(profile, { force: true });
  return { changed: true, ...(configBackup ? { backup: configBackup } : {}), ...(profileBackup ? { profileBackup } : {}), config, profile };
}

/** True when `codex on` is in effect for this Codex home. */
export function codexEnabled(home = codexHome()): boolean {
  try {
    const text = fs.readFileSync(configFile(home), "utf8");
    return text.includes(START) && text.includes(END);
  } catch {
    return false;
  }
}
