// Agent definitions, derived from one place: config.json.
//
// Claude Code's Agent tool reads `~/.claude/agents/*.md` and takes the worker's model from the
// frontmatter `model:`. Until now that was a third copy of the truth, beside `providers.*.models`
// (what the router knows) and `aliases` (what a `[[ripple: xxx@effort]]` marker resolves to), and
// the copies drifted: an agent file named `deepseek` had no matching alias, so the marker resolved
// to a model id no provider declared and `PASS` sent thirty 404s to Anthropic (2026-09-20).
//
// This module derives both from config: the aliases a marker can name, and the agent files
// themselves. Files it writes are recorded in a manifest and are the only ones it may touch — a
// hand-written `muse.md` or `gpt.md` is never overwritten or removed.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { homeDir, type Config, type Provider } from "./config.ts";
import { declaredBy } from "./routing.ts";

/** The least a caller has to offer as a logger; `console` qualifies, so startup can pass one. */
export type AgentLog = { warn: (msg: string) => void; info?: (msg: string) => void };

/** Where Claude Code's Agent tool reads its worker definitions. */
export function defaultAgentDir(): string {
  return path.join(os.homedir(), ".claude", "agents");
}

/**
 * `cfg` with the agent files' derived aliases merged in. An explicit `cfg.aliases` entry wins, so a
 * hand-written alias is never overridden by a generated one.
 */
export function withAgentAliases(cfg: Config, dir: string, log?: AgentLog): Config {
  const derived = agentAliases(dir, log);
  return { ...cfg, aliases: { ...derived, ...cfg.aliases } };
}

/** The body every generated worker carries, verbatim. */
const BODY = [
  "너는 이 세션의 실행자다. 위임받은 작업을 직접 끝내고 직접 검증해서 결론만 간결히 보고한다.",
  "파일 전문·코드 덤프는 보고에 넣지 않는다. 추측은 추측이라 명시하고 근거는 파일:줄번호로 댄다.",
  "다른 에이전트에게 넘기지 않는다. 프롬프트 첫 줄의 `[[ripple: …]]` 표식은 라우팅용이니 무시한다.",
  "**작업 디렉터리(cwd)에 어떤 파일도 만들지 않는다.** 조사·감사처럼 \"읽기만\" 하는 일이어도 마찬가지다.",
  "임시 파일이 필요하면 `/tmp` 아래에만 만들고, 끝나면 지운다. 사본을 작업 폴더에 떨구지 마라.",
].join("\n");

/** One parsed agent file. `model` is null when the file has no `model:` line. */
type AgentEntry = { name: string; model: string | null; mtimeMs: number };

/**
 * Parsed `*.md` frontmatter per directory, keyed by file mtime so a request never re-reads the whole
 * directory. Only the `---` block's own `key: value` lines are read: no YAML library, because the
 * two keys we need are two lines.
 */
const cache = new Map<string, Map<string, AgentEntry>>();

function parseFrontmatter(text: string): Record<string, string> | null {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;
  const out: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "---") return out;
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (m) out[m[1]!.toLowerCase()] = m[2]!.trim().replace(/^['"]|['"]$/g, "");
  }
  return null; // no closing fence: not frontmatter we understand
}

/** The `*.md` files of `dir`, parsed and cached on their mtimes. Parse failures are skipped. */
function scanDir(dir: string, log?: AgentLog): Map<string, AgentEntry> {
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    cache.delete(dir);
    return new Map();
  }
  const prev = cache.get(dir) ?? new Map<string, AgentEntry>();
  const next = new Map<string, AgentEntry>();
  let changed = false;
  for (const file of files) {
    let st: fs.Stats;
    try {
      st = fs.statSync(path.join(dir, file));
    } catch {
      continue;
    }
    const hit = prev.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs) {
      next.set(file, hit);
      continue;
    }
    changed = true;
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, file), "utf8");
    } catch (e) {
      log?.warn(`agent ${file}: unreadable (${(e as Error).message}); skipped`);
      continue;
    }
    const fm = parseFrontmatter(text);
    if (!fm) continue; // no frontmatter: not an agent definition, nothing to warn about
    const name = fm.name;
    if (!name) {
      log?.warn(`agent ${file}: frontmatter has no name; skipped`);
      continue;
    }
    next.set(file, { name, model: fm.model ?? null, mtimeMs: st.mtimeMs });
  }
  if (changed || prev.size !== next.size) cache.set(dir, next);
  return next;
}

/**
 * `{ [name]: model id without its "@effort" }` for every agent file in `dir`. This is the derived
 * half of the marker aliases; an explicit `cfg.aliases` entry wins over it at the call site.
 */
export function agentAliases(dir: string, log?: AgentLog): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of scanDir(dir, log).values()) {
    if (!entry.model) continue;
    out[entry.name] = entry.model.replace(/@[a-z]+$/i, "");
  }
  return out;
}

/** The agent name (and file basename) a model id maps to: everything outside `[a-z0-9-]` becomes `-`. */
export function agentNameFor(modelId: string): string {
  return modelId.replace(/[^a-z0-9-]/g, "-");
}

function capsEffortLevels(provider: Provider): string[] | undefined {
  return (provider as { caps?: { effortLevels?: string[] } }).caps?.effortLevels;
}

/**
 * The `@effort` suffix a generated file's `model:` carries: `@medium` when the provider or the model
 * offers medium reasoning, otherwise none. An empty `model.effortLevels` disables the provider
 * fallback (config.ts), so it is honoured rather than ignored.
 */
function effortSuffix(provider: Provider, modelId: string): string {
  const modelLevels = provider.models?.find((m) => m.id === modelId)?.effortLevels;
  const levels = modelLevels !== undefined ? modelLevels : capsEffortLevels(provider);
  return levels?.includes("medium") ? "@medium" : "";
}

function fileContent(name: string, modelId: string, provider: string, suffix: string): string {
  const description =
    `${modelId} via ${provider}. Generated by ClaudeRipple from config.json — edits are overwritten; ` +
    `to customise, copy to another name. Set effort with [[ripple: ${name}@<level>]] on the first line.`;
  return `---\nname: ${name}\ndescription: ${description}\nmodel: ${modelId}${suffix}\n---\n${BODY}\n`;
}

type Manifest = { agents: string[] };

function readManifest(file: string): Manifest {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { agents?: unknown };
    if (Array.isArray(parsed.agents)) return { agents: parsed.agents.filter((a): a is string => typeof a === "string") };
  } catch {
    /* missing or broken: treat as empty, and it is rewritten below */
  }
  return { agents: [] };
}

function writeManifest(file: string, manifest: Manifest, log?: AgentLog): void {
  try {
    fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
  } catch (e) {
    log?.warn(`generated-agents manifest: cannot write ${file}: ${(e as Error).message}`);
  }
}

export type SyncOptions = {
  /** Where the ownership manifest lives. Defaults to `<homeDir()>/generated-agents.json`. */
  manifestPath?: string;
};

/**
 * Bring `dir`'s generated agent files in step with `cfg`: one file per model exactly one non-anthropic
 * provider declares, and remove the ones this router wrote whose model is no longer ticked. Only
 * files named in the manifest are ever written or removed — a hand-written agent is left alone, and
 * a name it already uses is skipped rather than overwritten.
 *
 * Never throws: a write failure is a warning, not a dead router.
 */
export function syncAgentFiles(cfg: Config, dir: string, log?: AgentLog, opts: SyncOptions = {}): void {
  if (cfg.cli.agentFiles === false) return;

  const manifestFile = opts.manifestPath ?? path.join(homeDir(), "generated-agents.json");
  const manifest = readManifest(manifestFile);
  const owned = new Set(manifest.agents);
  const scanned = scanDir(dir, log);

  // Names already taken by files this router did not write: hand files win, always.
  const handNames = new Set<string>();
  for (const entry of scanned.values()) if (!owned.has(entry.name)) handNames.add(entry.name);

  // Targets: each model declared by exactly one provider, that provider not ingress-only.
  const targets = new Map<string, { modelId: string; provider: string; suffix: string }>();
  for (const [providerName, provider] of Object.entries(cfg.providers)) {
    if (provider.type === "anthropic" && !provider.accountPool) continue;
    for (const model of provider.models ?? []) {
      const owners = declaredBy(model.id, cfg);
      if (owners.length !== 1) {
        if (owners.length > 1) log?.warn(`agent files: "${model.id}" is declared by ${owners.join(", ")}; not generating an agent for it`);
        continue;
      }
      const name = agentNameFor(model.id);
      const clash = targets.get(name);
      if (clash) {
        log?.warn(`agent files: "${model.id}" and "${clash.modelId}" both map to "${name}"; skipping "${model.id}"`);
        continue;
      }
      targets.set(name, { modelId: model.id, provider: providerName, suffix: effortSuffix(provider, model.id) });
    }
  }

  const nextOwned: string[] = [];
  for (const [name, t] of targets) {
    if (handNames.has(name)) {
      log?.info?.(`agent files: "${name}" exists and is not ours; leaving it alone`);
      continue;
    }
    const file = path.join(dir, `${name}.md`);
    const content = fileContent(name, t.modelId, t.provider, t.suffix);
    const existing = scanned.get(`${name}.md`);
    if (existing) {
      let current: string | null = null;
      try {
        current = fs.readFileSync(file, "utf8");
      } catch {
        current = null;
      }
      if (current === content) {
        nextOwned.push(name); // already correct: do not rewrite
        continue;
      }
    }
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, content);
      nextOwned.push(name);
      log?.info?.(`agent files: wrote ${name}.md (${t.modelId} via ${t.provider})`);
    } catch (e) {
      log?.warn(`agent files: cannot write ${file}: ${(e as Error).message}`);
    }
  }

  // A model that is no longer ticked: remove the file this router wrote for it, and only that.
  for (const name of owned) {
    if (nextOwned.includes(name)) continue;
    try {
      fs.rmSync(path.join(dir, `${name}.md`), { force: true });
      log?.info?.(`agent files: removed ${name}.md (model no longer configured)`);
    } catch (e) {
      log?.warn(`agent files: cannot remove ${name}.md: ${(e as Error).message}`);
    }
  }

  const sorted = [...nextOwned].sort();
  if (JSON.stringify(sorted) !== JSON.stringify([...manifest.agents].sort())) {
    writeManifest(manifestFile, { agents: sorted }, log);
  }
}
