// Claude Code PreToolUse hook (matcher: Agent|Task): put the real model and thinking depth into the
// subagent's title, e.g. "Terra·high · Provider presets", so the Claude Desktop background-task
// panel shows which model a subagent runs on. The app's model line names Claude models only (its
// display table is a fixed list of Claude families, app web bundle 2026-09-30), so for a routed
// model the title is the only text we can influence.
//
// The panel shows this title only while it follows the session live: rebuilt from the transcript
// (another session opened and back, app restart) it takes the description the parent model wrote,
// which a hook cannot change. So the generated agent files also ask the parent to write the same
// prefix itself (packages/router/src/agents.ts); here it is corrected to what the router will do.
//
// Model resolution mirrors the router (packages/router/src/routing.ts): a `[[ripple: sol@xhigh]]`
// marker at the very top of the prompt, else the agent definition's frontmatter `model:`, else the
// explicit `model` argument, else the parent session's model from the transcript tail. Depth = the
// marker's level, else the agent file's `@level`, else the hook input's effort.level, after the
// router's `effortClamp`. Runs in <50ms, never fails the tool call (empty output = no-op).
//
// Installed by `clauderipple agent-title on` into ~/.claude/settings.json; the router ships no
// Python, so this is TypeScript run by the Node recorded in <home>/paths.json.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

type HookInput = {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  transcript_path?: string;
  effort?: { level?: string } | string;
};

// The router's marker (routing.ts MARKER): honoured only at the very top of the prompt.
const MARKER = /^\s*\[\[\s*(?:ripple|gpt)\s*:\s*([A-Za-z0-9.\-]+)\s*(?:@\s*([A-Za-z]+))?\s*\]\]/;
const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const OUR_PREFIX = /^[^\s·]+(?:·[a-z]+)? · /;
const CLAUDE_ID = /^claude-(opus|sonnet|haiku|fable)-(\d+(?:-\d+)*?)(?:-\d{8})?$/;
/** The router's default `effortClamp` (config.ts), for when config.json cannot be read. */
const DEFAULT_CLAMP: Record<string, string> = { ultra: "max" };

/** A model's name in a title: the last word of its display name ("GPT-6.1 Sol" → "Sol"). */
export function shortName(name: string): string {
  const words = name.trim().split(/\s+/);
  return words[words.length - 1]!;
}

/** What the title needs from config.json: display names, marker aliases and the effort clamp. */
export type TitleConfig = { names: Record<string, string>; aliases?: Record<string, string>; effortClamp?: Record<string, string> };

function titleConfig(): TitleConfig {
  const names: Record<string, string> = { "gpt-5.6-terra": "Terra", "gpt-5.6-sol": "Sol", "gpt-5.6-luna": "Luna", "gpt-6-astra": "Astra", "gpt-6-sol": "Sol", "gpt-6-luna": "Luna" };
  const home = process.env.CLAUDERIPPLE_HOME ?? path.join(os.homedir(), ".clauderipple");
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8")) as {
      cli?: { extraModels?: { model: string; name?: string }[] };
      providers?: Record<string, { models?: { id: string; name?: string }[] }>;
      aliases?: Record<string, string>;
      effortClamp?: Record<string, string>;
    };
    const add = (id: string | undefined, name: string | undefined): void => {
      if (id && name) names[id.toLowerCase()] = shortName(name);
    };
    for (const m of cfg.cli?.extraModels ?? []) add(m.model, m.name);
    for (const p of Object.values(cfg.providers ?? {})) for (const m of p.models ?? []) add(m.id, m.name);
    return { names, aliases: cfg.aliases ?? {}, effortClamp: { ...DEFAULT_CLAMP, ...(cfg.effortClamp ?? {}) } };
  } catch {
    return { names, aliases: {}, effortClamp: DEFAULT_CLAMP };
  }
}

/** The `[[ripple: <name>@<effort>]]` a prompt starts with, name lowercased. Not resolved. */
export function fromMarker(prompt: string): { name: string; effort: string } | null {
  const m = MARKER.exec(prompt.replace(REMINDER, ""));
  return m ? { name: m[1]!.toLowerCase(), effort: (m[2] ?? "").toLowerCase() } : null;
}

export function fromAgentFile(subagentType: string, dirs: string[]): { model: string; effort: string } | null {
  if (!subagentType || subagentType.includes("/") || subagentType.startsWith(".")) return null;
  for (const d of dirs) {
    let head: string;
    try {
      head = fs.readFileSync(path.join(d, `${subagentType}.md`), "utf8").slice(0, 8192);
    } catch {
      continue;
    }
    if (head.startsWith("---")) {
      const end = head.indexOf("\n---", 3);
      if (end !== -1) head = head.slice(0, end);
    }
    const m = /^model:\s*['"]?([^'"\s]+)/m.exec(head);
    if (m) {
      const [model, effort = ""] = m[1]!.toLowerCase().split("@");
      return { model: model!, effort };
    }
  }
  return null;
}

export function claudePretty(modelId: string | undefined): string | null {
  const v = (modelId ?? "").trim().toLowerCase();
  if (["opus", "sonnet", "haiku", "fable"].includes(v)) return v[0]!.toUpperCase() + v.slice(1);
  const m = CLAUDE_ID.exec(v);
  return m ? m[1]![0]!.toUpperCase() + m[1]!.slice(1) + m[2]!.replace(/-/g, ".") : null;
}

function parentModel(transcriptPath: string | undefined): string | null {
  if (!transcriptPath) return null;
  let chunk: string;
  try {
    const fd = fs.openSync(transcriptPath, "r");
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - 262144);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    chunk = buf.toString("utf8");
  } catch {
    return null;
  }
  for (const line of chunk.split("\n").reverse()) {
    if (!line.includes('"assistant"') || line.includes('"isSidechain":true')) continue;
    try {
      const d = JSON.parse(line) as { message?: { model?: string } };
      if (d.message?.model) return d.message.model;
    } catch {
      /* the first line of a tail read can be cut */
    }
  }
  return null;
}

/**
 * The model and effort the router will use for this call. The marker's name resolves as the router's
 * aliases do (agents.ts withAgentAliases): an explicit alias, else an agent file's model, else the
 * name itself; its effort, when absent, is the one the subagent's own `model:` asks for.
 */
function routed(inp: Record<string, unknown>, agentDirs: string[], aliases: Record<string, string>): { model: string; effort: string } | null {
  const own = fromAgentFile(typeof inp.subagent_type === "string" ? inp.subagent_type : "", agentDirs);
  const marker = fromMarker(typeof inp.prompt === "string" ? inp.prompt : "");
  if (!marker) return own;
  const model = aliases[marker.name]?.toLowerCase() ?? fromAgentFile(marker.name, agentDirs)?.model ?? marker.name;
  return { model, effort: marker.effort || (own?.effort ?? "") };
}

export function retitle(input: HookInput, agentDirs: string[], cfg: TitleConfig): Record<string, unknown> | null {
  if (input.tool_name !== "Agent" && input.tool_name !== "Task") return null;
  const inp = input.tool_input ?? {};
  const desc = inp.description;
  if (typeof desc !== "string" || desc.trim() === "") return null;
  const clamp = cfg.effortClamp ?? DEFAULT_CLAMP;
  const level = (e: string): string => clamp[e] ?? e;
  const effort = level((typeof input.effort === "object" && input.effort ? input.effort.level : typeof input.effort === "string" ? input.effort : "") ?? "");

  const got = routed(inp, agentDirs, cfg.aliases ?? {});
  const names = cfg.names;
  let tag: string | null = null;
  if (got && !claudePretty(got.model)) {
    // Legacy short forms ("sol") resolve against full ids ("gpt-5.6-sol").
    const key = names[got.model] !== undefined ? got.model : Object.keys(names).find((k) => k.endsWith(`-${got.model}`));
    const name = (key ? names[key] : undefined) ?? got.model;
    tag = got.effort ? `${name}·${level(got.effort)}` : name;
  }
  if (tag === null) {
    const name = claudePretty(typeof inp.model === "string" ? inp.model : undefined) ?? (got ? claudePretty(got.model) : null) ?? claudePretty(parentModel(input.transcript_path) ?? undefined);
    if (!name) return null;
    const e = got?.effort ? level(got.effort) : effort;
    tag = e ? `${name}·${e}` : name;
  }
  const prefix = `${tag} · `;
  if (desc.startsWith(prefix)) return null;
  let bare = desc.replace(OUR_PREFIX, "");
  if (bare.trim() === "") bare = desc;
  return { ...inp, description: prefix + bare };
}

function defaultAgentDirs(): string[] {
  const dirs = [path.join(os.homedir(), ".claude", "agents")];
  for (const base of [process.env.CLAUDE_PROJECT_DIR, process.cwd()]) if (base) dirs.push(path.join(base, ".claude", "agents"));
  return dirs;
}

// fileURLToPath, not URL.pathname: the latter keeps percent-encoding (a space in the path becomes
// %20, so the comparison fails and the hook silently does nothing) and on Windows yields "/C:/…".
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    const raw = fs.readFileSync(0, "utf8");
    const data = JSON.parse(raw || "{}") as HookInput;
    const updated = retitle(data, defaultAgentDirs(), titleConfig());
    if (updated) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: updated } }) + "\n");
  } catch {
    /* a hook must never break the tool call */
  }
}
