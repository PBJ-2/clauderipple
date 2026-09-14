// Claude Code PreToolUse hook (matcher: Agent|Task): put the real model and thinking depth into the
// subagent's title, e.g. "Terra·high · Provider presets", so the Claude Desktop background-task
// panel shows which model a subagent runs on. The app's own second line is a fixed "Agent" label
// (verified in the app renderer), so the description is the only text we can influence.
//
// Model resolution mirrors the router (packages/router/src/routing.ts): a `[[gpt: sol@xhigh]]`
// marker in the prompt's first 5 lines, else the agent definition's frontmatter `model:`, else the
// explicit `model` argument, else the parent session's model from the transcript tail.
// Depth = the hook input's effort.level. Runs in <50ms, never fails the tool call (empty output = no-op).
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

const MARKER = /\[\[\s*gpt\s*:\s*([a-z0-9.\-]+)\s*(?:@\s*([a-z]+))?\s*\]\]/i;
const OUR_PREFIX = /^[^\s·]+(?:·[a-z]+)? · /;
const CLAUDE_ID = /^claude-(opus|sonnet|haiku|fable)-(\d+(?:-\d+)*?)(?:-\d{8})?$/;

/** Display names: config's picker names (e.g. "GPT-5.6 Terra" → "Terra"), then a built-in table. */
function prettyNames(): Record<string, string> {
  const out: Record<string, string> = { "gpt-5.6-terra": "Terra", "gpt-5.6-sol": "Sol", "gpt-5.6-luna": "Luna", "gpt-6-astra": "Astra" };
  const home = process.env.CLAUDERIPPLE_HOME ?? path.join(os.homedir(), ".clauderipple");
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8")) as {
      cli?: { extraModels?: { model: string; name?: string }[] };
      providers?: Record<string, { models?: { id: string; name?: string }[] }>;
    };
    const add = (id: string | undefined, name: string | undefined): void => {
      if (!id || !name) return;
      const words = name.trim().split(/\s+/);
      out[id.toLowerCase()] = words.length > 1 ? words[words.length - 1]! : name.trim();
    };
    for (const m of cfg.cli?.extraModels ?? []) add(m.model, m.name);
    for (const p of Object.values(cfg.providers ?? {})) for (const m of p.models ?? []) add(m.id, m.name);
  } catch {
    /* no config: built-ins only */
  }
  return out;
}

export function fromMarker(prompt: string): { model: string; effort: string } | null {
  const head = prompt.split("\n").slice(0, 5).join("\n");
  const m = MARKER.exec(head);
  return m ? { model: m[1]!.toLowerCase(), effort: (m[2] ?? "").toLowerCase() } : null;
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

export function retitle(input: HookInput, agentDirs: string[], names: Record<string, string>): Record<string, unknown> | null {
  if (input.tool_name !== "Agent" && input.tool_name !== "Task") return null;
  const inp = input.tool_input ?? {};
  const desc = inp.description;
  if (typeof desc !== "string" || desc.trim() === "") return null;
  const effort = (typeof input.effort === "object" && input.effort ? input.effort.level : typeof input.effort === "string" ? input.effort : "") ?? "";

  const got = fromMarker(typeof inp.prompt === "string" ? inp.prompt : "") ?? fromAgentFile(typeof inp.subagent_type === "string" ? inp.subagent_type : "", agentDirs);
  let tag: string | null = null;
  if (got) {
    // Marker short forms ("sol") resolve against full ids ("gpt-5.6-sol"), as the router's aliases do.
    const key = names[got.model] !== undefined ? got.model : Object.keys(names).find((k) => k.endsWith(`-${got.model}`));
    const name = (key ? names[key] : undefined) ?? (got.model.startsWith("gpt") || got.model.includes("/") ? got.model : null);
    if (name) tag = got.effort ? `${name}·${got.effort}` : name;
  }
  if (tag === null) {
    const name = claudePretty(typeof inp.model === "string" ? inp.model : undefined) ?? (got ? claudePretty(got.model) : null) ?? claudePretty(parentModel(input.transcript_path) ?? undefined);
    if (!name) return null;
    tag = effort ? `${name}·${effort}` : name;
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
    const updated = retitle(data, defaultAgentDirs(), prettyNames());
    if (updated) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: updated } }) + "\n");
  } catch {
    /* a hook must never break the tool call */
  }
}
