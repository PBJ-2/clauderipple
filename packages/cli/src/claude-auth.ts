// `claude setup-token` invocation for a ClaudeRipple-owned, 0600 token file.
// The token is never echoed, logged, or returned from this module.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { removeClaudeAuthFile, saveClaudeAuthFile } from "../../router/src/providers/anthropic-token-file.ts";

function isSetupToken(value: string): boolean {
  return /^sk-ant-oat01-[A-Za-z0-9._~-]{16,}$/.test(value);
}

export function parseSetupToken(stdout: string): string | null {
  const matches = stdout.match(/sk-ant-oat01-[A-Za-z0-9._~-]{16,}/g) ?? [];
  const unique = [...new Set(matches)];
  return unique.length === 1 && isSetupToken(unique[0]!) ? unique[0]! : null;
}

export function latestDesktopClaude(): string | null {
  const directory = path.join(os.homedir(), "Library", "Application Support", "Claude", "claude-code");
  try {
    const versions = fs.readdirSync(directory)
      .filter((entry) => /^\d+\.\d+\.\d+$/.test(entry))
      .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
    const latest = versions.at(-1);
    if (!latest) return null;
    const binary = path.join(directory, latest, "claude.app", "Contents", "MacOS", "claude");
    return fs.existsSync(binary) ? binary : null;
  } catch {
    return null;
  }
}

export function claudeBinary(pathValue = process.env.PATH): string | null {
  for (const directory of (pathValue ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const binary = path.join(directory, "claude");
    try {
      fs.accessSync(binary, fs.constants.X_OK);
      return binary;
    } catch {
      // Continue to the bundled Desktop CLI.
    }
  }
  return latestDesktopClaude();
}

export function claudeLogin(home: string, options: { binary?: string; pathValue?: string; run?: (binary: string) => string } = {}): void {
  const binary = options.binary ?? claudeBinary(options.pathValue);
  if (!binary) throw new Error("Claude Code CLI not found; install Claude Code or open Claude Desktop once");
  let stdout: string;
  try {
    stdout = options.run ? options.run(binary) : execFileSync(binary, ["setup-token"], { encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] });
  } catch (error) {
    const detail = (error as { stderr?: string | Buffer }).stderr;
    const text = typeof detail === "string" ? detail : Buffer.isBuffer(detail) ? detail.toString("utf8") : "";
    if (/unknown command|unknown option|setup-token/i.test(text)) throw new Error("This Claude Code version does not support `claude setup-token`; update Claude Code and try again");
    throw new Error("Claude Code setup-token failed");
  }
  const token = parseSetupToken(stdout);
  if (!token) throw new Error("Claude Code did not return a recognizable setup token; no credential was saved");
  saveClaudeAuthFile(home, token);
}

export function claudeLogout(home: string): boolean {
  return removeClaudeAuthFile(home);
}
