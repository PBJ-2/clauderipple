// Agent definitions, derived from one place: config.json.
//
// Claude Code's Agent tool reads `~/.claude/agents/*.md` and takes the worker's model from the
// frontmatter `model:`. Until now that was a third copy of the truth, beside `providers.*.models`
// (what the router knows) and `aliases` (what a `[[ripple: xxx@effort]]` marker resolves to), and
// the copies drifted: an agent file named `deepseek` had no matching alias, so the marker resolved
// to a model id no provider declared and `PASS` sent thirty 404s to Anthropic (2026-09-20).
//
// This module derives both from config: the aliases a marker can name, and the agent files
// themselves. Files it writes are recorded in a manifest; marked current targets can recover lost
// ownership. A hand-written `muse.md` or `gpt.md` is never overwritten or removed.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { adminPort, homeDir, type Config, type Provider } from "./config.ts";
import { withFileLock } from "./locked-file.ts";
import { declaredBy, qualifiedModel } from "./routing.ts";
import { isTargetProvider } from "./targets.ts";
import { isJudgeOnlyModel } from "./model-policy.ts";
import { GROK_EFFORT_LEVELS } from "./providers/grok/catalog.ts";
import { shortName } from "../../cli/src/hooks/agent-title.ts";

/** The least a caller has to offer as a logger; `console` qualifies, so startup can pass one. */
export type AgentLog = { warn: (msg: string) => void; info?: (msg: string) => void };

/** Where Claude Code's Agent tool reads its worker definitions. */
export function defaultAgentDir(): string {
  return path.join(os.homedir(), ".claude", "agents");
}

/**
 * `cfg` with the agent files' derived aliases merged in. An explicit `cfg.aliases` entry wins, so a
 * hand-written alias is never overridden by a generated one. The names the 0.12.18 build gave the
 * same workers join as aliases too, so a marker written against one still resolves (#111); a current
 * name wins over an old one, since the derived and explicit entries sit above them.
 */
export function withAgentAliases(cfg: Config, dir: string, log?: AgentLog): Config {
  const derived = agentAliases(dir, log);
  return { ...cfg, aliases: { ...legacyAgentAliases(cfg, dir, log), ...derived, ...cfg.aliases } };
}

/** The body every generated worker carries, verbatim. */
const BODY = [
  "너는 이 세션의 실행자다. 위임받은 작업을 직접 끝내고 직접 검증해서 결론만 간결히 보고한다.",
  "파일 전문·코드 덤프는 보고에 넣지 않는다. 추측은 추측이라 명시하고 근거는 파일:줄번호로 댄다.",
  "다른 에이전트에게 넘기지 않는다. 프롬프트 첫 줄의 `[[ripple: …]]` 표식은 라우팅용이니 무시한다.",
  "**시키지 않은 파일은 만들지 않는다.** 작업 지시에 결과물 경로가 없으면 조사·감사라도 작업 디렉터리(cwd)에 아무 파일도 남기지 않는다.",
  "작업 지시가 결과물 경로(파일·폴더)를 정했으면 조사·감사·대조 작업이라도 그 경로에는 반드시 만든다. 그 밖의 메모·사본·임시 파일은 `/tmp` 아래에만 만들고, 끝나면 지운다.",
  // Claude Code tells a bypass/auto session to read and edit through Bash (since CLI 2.1.234). After it
  // arrived Bash edits went from 32% to 78% and Read calls from 2,897 to 151 in the operator's
  // sessions, and details went missing (brain, 2026-08-25); workers here read with `sed -n`/`cat` more
  // than with Read (2026-10-14). The operator's own rule, given to the workers too:
  "**소스 파일 읽기와 수정은 전용 도구로 한다.** 처음 만지는 파일은 Read로 통독하고(필요하면 다시 읽는다), 수정은 Edit, 새 파일은 Write로 한다. `cat`·`sed -n`·`head`로 조각만 읽어 넘기지 않고, `sed -i`·heredoc 덮어쓰기·스크립트 재작성으로 소스를 고치지 않는다 — 간격·정렬·주석이 조용히 깎인다. Bash는 검색(grep/rg)·실행·테스트·빌드, 그리고 수십 곳 이상의 기계적 일괄 치환(끝나면 `git diff`로 확인)에만 쓴다.",
].join("\n");

/**
 * Added to the body when a ChatGPT provider is configured: how a worker makes an image. A worker has
 * no image tool, and `clauderipple` is not on PATH for everyone (a checkout runs from source), so
 * the instruction is the admin endpoint itself, which curl reaches on every platform. A GPT main
 * session gets the same lines in its instructions (proxy.ts).
 */
export function imageLine(port: number): string {
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
type AgentEntry = { name: string; model: string | null; generated: boolean; mtimeMs: number };

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
    next.set(file, { name, model: fm.model ?? null, generated: isGenerated(text), mtimeMs: st.mtimeMs });
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
    if (!entry.model || isJudgeOnlyModel(entry.model)) continue;
    out[entry.name] = entry.model.replace(/@[a-z]+$/i, "");
  }
  return out;
}

/**
 * The agent name (and file basename) a model id maps to: lower-cased first, everything outside
 * `[a-z0-9-]` becomes `-`, runs of `-` collapse to one and the ends are trimmed. Lower-casing comes
 * first because a hosted id keeps its vendor's capitals — `deepseek-ai/DeepSeek-V4.1-Flash-1017`
 * must read as its own model. The 0.12.18 build sanitised without it, so each capital and its
 * neighbours became one dash (`deepseek-ai--eep-eek--4-1--lash-1017`, #111), and a name that ends
 * up empty falls back to `model` rather than writing a `.md` with no name.
 */
export function agentNameFor(modelId: string): string {
  return modelId.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "") || "model";
}

/** The name the 0.12.18 build gave a model id: sanitised without lower-casing, nothing else. */
function legacyAgentNameFor(modelId: string): string {
  return modelId.replace(/[^a-z0-9-]/g, "-");
}

/** A generated worker's current name and the name the 0.12.18 build gave the same target. */
function workerNames(modelId: string, providerName: string, suffixed: boolean): { name: string; legacy: string } {
  const suffix = (of: (id: string) => string): string => (suffixed ? `-${of(providerName)}` : "");
  return { name: agentNameFor(modelId) + suffix(agentNameFor), legacy: legacyAgentNameFor(modelId) + suffix(legacyAgentNameFor) };
}

/** One generated worker: the config it comes from, and the two names it can be known by. */
type AgentTarget = { modelId: string; title: string; provider: string; suffix: string; legacy: string };

/**
 * One worker per outbound provider/model declaration; the first owner keeps the bare name (#94), and
 * a duplicate declaration's later provider gets `<model>-<provider>`. Two ids that sanitise alike,
 * and a name a hand file already uses, are what the caller resolves.
 */
function agentTargets(cfg: Config, log?: AgentLog): Map<string, AgentTarget> {
  const targets = new Map<string, AgentTarget>();
  for (const [providerName, provider] of Object.entries(cfg.providers)) {
    if (!isTargetProvider(provider)) continue;
    for (const model of provider.models ?? []) {
      if (isJudgeOnlyModel(model.id)) continue;
      const owners = declaredBy(model.id, cfg);
      const first = owners.find(name => {
        const owner = cfg.providers[name]!;
        return isTargetProvider(owner);
      });
      const duplicate = owners.length > 1;
      const { name, legacy } = workerNames(model.id, providerName, duplicate && first !== providerName);
      const clash = targets.get(name);
      if (clash) {
        log?.warn(`agent files: "${model.id}" and "${clash.modelId}" both map to "${name}"; skipping "${model.id}"`);
        continue;
      }
      targets.set(name, { modelId: duplicate ? `${providerName}:${model.id}` : model.id, title: shortName(model.name ?? model.id), provider: providerName, suffix: effortSuffix(provider, model.id), legacy });
    }
  }
  return targets;
}

/** The names in `dir` whose file is a person's own, not one this router wrote: no generated mark. */
function handAgentNames(dir: string, log?: AgentLog): Set<string> {
  const names = new Set<string>();
  for (const entry of scanDir(dir, log).values()) if (!entry.generated) names.add(entry.name);
  return names;
}

/**
 * Whether the 0.12.18 name `legacy` already belongs to a worker the rename is not about: a hand
 * file's name, or any file at that name that is not our generated file for exactly `modelId`. Only
 * that file is the duplicate the rename replaces; the same evidence dropRenamedAgent removes it by.
 */
function otherWorkerAt(dir: string, legacy: string, modelId: string, hand: Set<string>): boolean {
  if (hand.has(legacy)) return true;
  const file = path.join(dir, `${legacy}.md`);
  let text: string;
  try {
    if (!fs.lstatSync(file).isFile()) return false;
    text = fs.readFileSync(file, "utf8");
  } catch {
    return false;
  }
  return !(isGenerated(text) && parseFrontmatter(text)?.model?.replace(/@[a-z]+$/i, "") === modelId);
}

/**
 * Every target the name change renamed (#111), provided its 0.12.18 name is still free: no current
 * worker name, no model any provider declares, no explicit alias, and no hand file (or another
 * worker's file) holding the name. An alias or a rename for such a name would take it over — two
 * ids that collapse to one name (`a//b` and `a--b` both shorten to `a-b`) leave the skipped one
 * declared, and `a--b -> a//b` would send the real `a--b`'s markers to a different model — and a
 * saved ladder rung naming a person's own worker would be rewritten to the generated one.
 */
function* renamedTargets(cfg: Config, dir: string, log?: AgentLog): Generator<{ name: string; legacy: string; modelId: string }> {
  const targets = agentTargets(cfg);
  const current = new Set(targets.keys());
  let hand: Set<string> | undefined;
  for (const [name, t] of targets) {
    if (t.legacy === name || current.has(t.legacy)) continue;
    if (Object.hasOwn(cfg.aliases, t.legacy) || declaredBy(t.legacy, cfg).length > 0) continue;
    hand ??= handAgentNames(dir, log);
    if (otherWorkerAt(dir, t.legacy, t.modelId, hand)) continue;
    yield { name, legacy: t.legacy, modelId: t.modelId };
  }
}

/**
 * `{ [0.12.18 name]: model id }` for the workers the name change renamed (#111): a marker or a saved
 * script that still says the old name resolves to the model instead of going out as a model id no
 * provider declares. Derived from config, not the files, so it holds once the old file is gone —
 * except for a name a hand file holds, which stays that file's own.
 */
export function legacyAgentAliases(cfg: Config, dir = defaultAgentDir(), log?: AgentLog): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { legacy, modelId } of renamedTargets(cfg, dir, log)) if (!(legacy in out)) out[legacy] = modelId;
  return out;
}

/**
 * `{ [0.12.18 name]: current name }` for the same workers, so a ladder rung or an allow-list entry
 * saved before the change keeps pointing at its worker (admin.ts migrates them on read).
 */
export function agentRenames(cfg: Config, dir = defaultAgentDir(), log?: AgentLog): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { name, legacy } of renamedTargets(cfg, dir, log)) if (!(legacy in out)) out[legacy] = name;
  return out;
}

function capsEffortLevels(provider: Provider): string[] | undefined {
  // A grok provider has no caps: its adapter sends the common ladder to a model the listing left out.
  if (provider.type === "grok") return [...GROK_EFFORT_LEVELS];
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

/**
 * What marks a file as this router's: a YAML comment in its frontmatter. The note is for a person
 * opening the file; in the description the main chat read it in every request's agent list, eight
 * workers' worth (2026-10-24).
 */
const GENERATED_MARK = "# Generated by ClaudeRipple from config.json — edits are overwritten; to customise, copy to another name.";
/** Where files written before 2026-10-24 carry the mark: in their description. */
const GENERATED_DESCRIPTION = "Generated by ClaudeRipple from config.json — edits are overwritten";

/** A frontmatter that carries the mark, as a comment line or in the description. Never the body's. */
function isGenerated(text: string): boolean {
  const fm = parseFrontmatter(text);
  if (!fm) return false;
  if (fm.description?.includes(GENERATED_DESCRIPTION)) return true;
  const lines = text.split(/\r?\n/);
  for (let i = 1; i < lines.length && lines[i]!.trim() !== "---"; i++) if (lines[i]!.trim() === GENERATED_MARK) return true;
  return false;
}

function fileContent(name: string, modelId: string, title: string, provider: string, suffix: string, limitTools: boolean, imagePort: number | null): string {
  const description =
    `${modelId} via ${provider}. Set effort with [[ripple: ${name}@<level>]] on the first line. ` +
    titlePrefix(title, suffix);
  const tools = limitTools ? `tools: ${TOOLS.join(", ")}\n` : "";
  const body = imagePort === null ? BODY : `${BODY}\n${imageLine(imagePort)}`;
  return `---\n${GENERATED_MARK}\nname: ${name}\ndescription: ${description}\nmodel: ${modelId}${suffix}\n${tools}---\n${body}\n`;
}

type Manifest = { agents: string[] };

function readManifest(file: string, strict = false): Manifest {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { agents?: unknown } | null;
    if (Array.isArray(parsed?.agents) && parsed.agents.every((name): name is string => typeof name === "string" && /^[a-z0-9-]+$/.test(name))) return { agents: parsed.agents };
    throw new Error("생성 워커 목록이 올바르지 않아 워커 파일을 제거하지 않았습니다.");
  } catch (error) {
    // A missing manifest is an empty claim; unreadable or invalid claims block every deletion.
    if (strict && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { agents: [] };
}

/**
 * The shared worker folder's lock. The manifest is per home, but the files are one folder for every
 * installation on the account, so two routers or an install and a router would otherwise write the
 * same name over each other (2026-10-25 lock audit). The lock lives outside the folder so Claude
 * Code's watcher never sees it.
 */
function agentDirLock(dir: string): string {
  const key = crypto.createHash("sha256").update(path.resolve(dir)).digest("hex").slice(0, 16);
  return path.join(os.tmpdir(), `clauderipple-agents-${key}`);
}

/**
 * Uninstall: the manifest is the ownership boundary, never all of ~/.claude/agents. Names another
 * install's manifest also records (`sharedWith`: the default home's and every home the ownership
 * store knows) stay: two homes write the same agent folder.
 */
export function removeGeneratedAgentFiles(dir: string, manifestPath: string, sharedWith?: string | string[]): void {
  withFileLock(agentDirLock(dir), () => {
    if (!fs.existsSync(manifestPath)) return;
    const parsed = readManifest(manifestPath, true);
    if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) throw new Error("워커 폴더가 심볼릭 링크이므로 제거하지 않았습니다.");
    const sharedPaths = (Array.isArray(sharedWith) ? sharedWith : sharedWith ? [sharedWith] : []).filter((file) => path.resolve(file) !== path.resolve(manifestPath));
    const shared = new Set(sharedPaths.flatMap((file) => readManifest(file, true).agents));
    for (const name of parsed.agents) {
      if (shared.has(name)) continue;
      const file = path.join(dir, `${name}.md`);
      if (!fs.existsSync(file) || !fs.lstatSync(file).isFile()) continue;
      const text = fs.readFileSync(file, "utf8");
      // A recorded worker replaced by a person's own definition is no longer ours.
      if (parseFrontmatter(text)?.name === name && isGenerated(text)) fs.rmSync(file);
    }
    fs.rmSync(manifestPath);
    cache.delete(dir);
  });
}

export type GeneratedAgent = { name: string; model: string; provider: string };

/** Owned files that still exist and name a configured worker, not hand-written agents. */
export function generatedAgents(cfg: Config, dir = defaultAgentDir(), manifestPath = path.join(homeDir(), "generated-agents.json"), log?: AgentLog): GeneratedAgent[] {
  const owned = new Set(readManifest(manifestPath).agents);
  const result: GeneratedAgent[] = [];
  for (const entry of scanDir(dir, log).values()) {
    if (!owned.has(entry.name) || !entry.model || isJudgeOnlyModel(entry.model)) continue;
    const model = entry.model.replace(/@[a-z]+$/i, "");
    const owners = declaredBy(model, cfg);
    const provider = owners.length === 1 ? owners[0] : undefined;
    const target = provider ? cfg.providers[provider] : undefined;
    if (!provider || !isTargetProvider(target)) continue;
    result.push({ name: entry.name, model: qualifiedModel(model, cfg)?.model ?? model, provider });
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
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
 * Bring `dir`'s generated agent files in step with `cfg`: one file per outbound provider/model
 * declaration, and remove the ones this router wrote whose model is no longer ticked. Only
 * files named in the manifest or marked current targets are written; only manifest files are removed.
 * A hand-written agent is left alone, and a name it already uses is skipped rather than overwritten.
 *
 * Never throws: a write failure is a warning, not a dead router. Returns the generated files there
 * are now when it wrote or removed any, for `retouchLater`; [] when nothing changed.
 */
export function syncAgentFiles(cfg: Config, dir: string, log?: AgentLog, opts: SyncOptions = {}): string[] {
  if (cfg.cli.agentFiles === false) return [];
  try {
    return withFileLock(agentDirLock(dir), () => syncAgentFilesLocked(cfg, dir, log, opts));
  } catch (e) {
    // Another installation's sync holds the folder (or it cannot be locked): skip this pass.
    // Nothing is left half-written; the next start or file change syncs again.
    log?.warn(`agent files: cannot lock ${dir} (${(e as Error).message}); this pass was skipped`);
    return [];
  }
}

/**
 * Remove `dir/<legacy>.md` when it is a generated worker for the same model, now written as `name`:
 * a file the 0.12.18 build named after a model id it had not lower-cased (#111). The name alone is
 * never the evidence — the generated mark and the `model:` line must both agree.
 */
function dropRenamedAgent(dir: string, legacy: string, name: string, modelId: string, log?: AgentLog): boolean {
  const file = path.join(dir, `${legacy}.md`);
  let text: string;
  try {
    if (!fs.lstatSync(file).isFile()) return false;
    text = fs.readFileSync(file, "utf8");
  } catch {
    return false;
  }
  if (!isGenerated(text) || parseFrontmatter(text)?.model?.replace(/@[a-z]+$/i, "") !== modelId) return false;
  try {
    fs.rmSync(file);
  } catch (e) {
    log?.warn(`agent files: cannot remove ${file}: ${(e as Error).message}`);
    return false;
  }
  log?.info?.(`agent files: removed ${legacy}.md (the same worker, now ${name}.md)`);
  return true;
}

function syncAgentFilesLocked(cfg: Config, dir: string, log: AgentLog | undefined, opts: SyncOptions): string[] {
  const manifestFile = opts.manifestPath ?? path.join(homeDir(), "generated-agents.json");
  const manifest = readManifest(manifestFile);
  const owned = new Set(manifest.agents);
  const scanned = scanDir(dir, log);

  // Names already taken by files this router did not write: hand files win, always.
  const handNames = new Set<string>();
  for (const entry of scanned.values()) if (!owned.has(entry.name)) handNames.add(entry.name);

  // Targets: one worker per declaring outbound provider; the first owner keeps the old name (#94).
  const targets = agentTargets(cfg, log);

  const imagePort = Object.values(cfg.providers).some((p) => p.type === "chatgpt") ? adminPort(cfg) : null;
  const nextOwned: string[] = [];
  let changed = false;
  for (const [name, t] of targets) {
    const file = path.join(dir, `${name}.md`);
    let current: string | null = null;
    try {
      current = fs.readFileSync(file, "utf8");
    } catch {
      current = null;
    }
    // Recover a lost manifest only for current targets: renamed copies belong to the user.
    const generated = isGenerated(current ?? "");
    if (handNames.has(name) && !generated) {
      log?.info?.(`agent files: "${name}" exists and is not ours; leaving it alone`);
      continue;
    }
    const content = fileContent(name, t.modelId, t.title, t.provider, t.suffix, cfg.cli.limitWorkerTools === true, imagePort);
    if (current === content) {
      nextOwned.push(name); // already correct: do not rewrite
      continue;
    }
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, content);
      nextOwned.push(name);
      changed = true;
      log?.info?.(`agent files: wrote ${name}.md (${t.modelId} via ${t.provider})`);
    } catch (e) {
      log?.warn(`agent files: cannot write ${file}: ${(e as Error).message}`);
    }
  }

  // The name the 0.12.18 build wrote for a worker whose name has since changed (#111): once the
  // renamed file is in place, the old one is the same worker twice. An owned one is removed by the
  // loop below like any stale file; one outside the manifest (a lost ownership record) is removed
  // here, where its mark and its `model:` line are the evidence that it is ours.
  for (const name of nextOwned) {
    const t = targets.get(name);
    if (!t || t.legacy === name || owned.has(t.legacy) || nextOwned.includes(t.legacy)) continue;
    if (dropRenamedAgent(dir, t.legacy, name, t.modelId, log)) changed = true;
  }

  // A model that is no longer ticked: remove the file this router wrote for it, and only that.
  for (const name of owned) {
    if (nextOwned.includes(name)) continue;
    try {
      fs.rmSync(path.join(dir, `${name}.md`), { force: true });
      changed = true;
      log?.info?.(`agent files: removed ${name}.md (model no longer configured)`);
    } catch (e) {
      log?.warn(`agent files: cannot remove ${name}.md: ${(e as Error).message}`);
    }
  }

  const sorted = [...nextOwned].sort();
  if (JSON.stringify(sorted) !== JSON.stringify([...manifest.agents].sort())) {
    writeManifest(manifestFile, { agents: sorted }, log);
  }
  return changed ? sorted.map((name) => path.join(dir, `${name}.md`)) : [];
}

/**
 * How long after a sync its files are touched again: past Claude Code's 30 s idle poll and the
 * 1 s it waits for a write to settle.
 *
 * Claude Code 2.1.308 polls `~/.claude/agents` every 2 s while a session is in use and every 30 s
 * once it has sat a minute. Going back to 2 s rebuilds the watcher, which takes the directory as it
 * finds it, and the catch-up it then runs compares only skills and commands. A worker written in
 * the 30 s before the user returns to an idle session is never read there, and `/clear` keeps the
 * session's list: the MAMBO session refused `zai-org-glm-5-3-flash` 26 s after it was written and
 * still 33 minutes later, after a `/clear` (2026-10-23). A change to any agent file rereads them
 * all, so one more touch past that window reaches a session that missed the first.
 */
export const RETOUCH_AFTER_MS = 45_000;

/** Touch `files` again after `delay`, never holding the process open. A file gone since is skipped. */
export function retouchLater(files: string[], delay = RETOUCH_AFTER_MS): void {
  if (files.length === 0) return;
  const timer = setTimeout(() => {
    const now = new Date();
    for (const file of files) {
      try {
        fs.utimesSync(file, now, now);
      } catch {
        // removed or replaced by a later sync, which schedules its own touch
      }
    }
  }, delay);
  timer.unref?.();
}
