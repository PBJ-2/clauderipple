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
import { adminPort } from "./admin.ts";
import { shortName } from "../../cli/src/hooks/agent-title.ts";

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

/**
 * Added to the body when a ChatGPT provider is configured: how a worker makes an image. A worker has
 * no image tool, and `clauderipple` is not on PATH for everyone (a checkout runs from source), so
 * the instruction is the admin endpoint itself, which curl reaches on every platform.
 */
function imageLine(port: number): string {
  return [
    "이미지가 필요하면 ChatGPT 구독으로 만든다(한 장 30초~수 분):",
    `\`curl -sS --fail-with-body -o <절대경로>.png -H 'content-type: application/json' -d '{"prompt":"…"}' http://127.0.0.1:${port}/api/image\``,
    "선택 키: aspect(square·landscape·portrait), background(transparent), format(png·jpeg·webp), images(참고 이미지 data: URL 목록). 해상도·품질은 지정할 수 없다. 실패하면 그 파일에 오류 JSON이 담긴다. 만든 뒤 Read로 확인한다.",
  ].join("\n");
}

/**
 * The tools a generated worker is given when `cli.limitWorkerTools` is on. Without a `tools:` line a
 * subagent inherits every tool of the session — each MCP server, plugin agent and deferred-tool name —
 * and a general worker's first request measured 43,598 tokens (2026-09-20), resent on every turn;
 * limited, a deepseek worker's first request fell from 32,942 to 8,823 (2026-09-29). A worker reads,
 * edits, searches, runs commands and uses skills; it does not drive browsers, simulators or mail.
 * Off by default: a user whose workers do need those tools would otherwise lose them silently.
 */
const TOOLS = ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "WebFetch", "WebSearch", "Skill"];

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
 * The `@effort` suffix a generated file's `model:` carries: `@high` when the provider or the model
 * offers any reasoning effort, otherwise none. A ladder without `high` is fine — the request is
 * clamped to the nearest level the model takes (compat.ts). It used to be `@medium`, which a ladder
 * from the catalogue such as `low`/`high`/`max` does not hold, and the operator wants workers at
 * high unless a marker says otherwise (2026-10-02). An empty `model.effortLevels` disables the
 * provider fallback (config.ts), so it is honoured rather than ignored.
 */
function effortSuffix(provider: Provider, modelId: string): string {
  const modelLevels = provider.models?.find((m) => m.id === modelId)?.effortLevels;
  const levels = modelLevels !== undefined ? modelLevels : capsEffortLevels(provider);
  return levels && levels.length > 0 ? "@high" : "";
}

/**
 * What the parent is asked to start the Agent `description` with. The Desktop task panel names only
 * Claude models, and rebuilt from the transcript it shows the description as the parent wrote it,
 * so the agent-title hook's live correction is lost (app web bundle, 2026-09-30); a prefix the
 * parent writes itself survives. Same form as the hook's: the display name's last word, `·level`.
 */
function titlePrefix(title: string, suffix: string): string {
  return suffix
    ? `Start the Agent description with "${title}·<level> · " (the marker's level, else ${suffix.slice(1)}) so the app's task list shows the model.`
    : `Start the Agent description with "${title} · " so the app's task list shows the model.`;
}

function fileContent(name: string, modelId: string, title: string, provider: string, suffix: string, limitTools: boolean, imagePort: number | null): string {
  const description =
    `${modelId} via ${provider}. Generated by ClaudeRipple from config.json — edits are overwritten; ` +
    `to customise, copy to another name. Set effort with [[ripple: ${name}@<level>]] on the first line. ` +
    titlePrefix(title, suffix);
  const tools = limitTools ? `tools: ${TOOLS.join(", ")}\n` : "";
  const body = imagePort === null ? BODY : `${BODY}\n${imageLine(imagePort)}`;
  return `---\nname: ${name}\ndescription: ${description}\nmodel: ${modelId}${suffix}\n${tools}---\n${body}\n`;
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
  const targets = new Map<string, { modelId: string; title: string; provider: string; suffix: string }>();
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
      targets.set(name, { modelId: model.id, title: shortName(model.name ?? model.id), provider: providerName, suffix: effortSuffix(provider, model.id) });
    }
  }

  const imagePort = Object.values(cfg.providers).some((p) => p.type === "chatgpt") ? adminPort(cfg) : null;
  const nextOwned: string[] = [];
  for (const [name, t] of targets) {
    if (handNames.has(name)) {
      log?.info?.(`agent files: "${name}" exists and is not ours; leaving it alone`);
      continue;
    }
    const file = path.join(dir, `${name}.md`);
    const content = fileContent(name, t.modelId, t.title, t.provider, t.suffix, cfg.cli.limitWorkerTools === true, imagePort);
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
