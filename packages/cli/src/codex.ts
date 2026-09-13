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
env_key = "CLAUDERIPPLE_KEY"
${END}`;
}

function profileBlock(): string {
  return `${PROFILE_START}
model_provider = "clauderipple"
${PROFILE_END}`;
}

export type CodexEdit = { changed: boolean; backup?: string; profileBackup?: string; config: string; profile: string };

/** Install provider in config.toml plus selection in the dedicated `clauderipple` profile. */
export function codexOn(port: number, home = codexHome()): CodexEdit {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const config = configFile(home);
  const profile = profileFile(home);
  const beforeConfig = fs.existsSync(config) ? fs.readFileSync(config, "utf8") : "";
  const beforeProfile = fs.existsSync(profile) ? fs.readFileSync(profile, "utf8") : "";
  const nextConfig = appendBlock(withoutOwnedBlock(beforeConfig, START, END), providerBlock(port));
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
  const nextConfig = withoutOwnedBlock(beforeConfig, START, END);
  const nextProfile = withoutOwnedBlock(beforeProfile, PROFILE_START, PROFILE_END);
  if (nextConfig === beforeConfig && nextProfile === beforeProfile) return { changed: false, config, profile };
  const configBackup = backup(config);
  const profileBackup = backup(profile);
  if (nextConfig) fs.writeFileSync(config, nextConfig.endsWith("\n") ? nextConfig : `${nextConfig}\n`, { mode: 0o600 });
  else fs.rmSync(config, { force: true });
  if (nextProfile) fs.writeFileSync(profile, nextProfile.endsWith("\n") ? nextProfile : `${nextProfile}\n`, { mode: 0o600 });
  else fs.rmSync(profile, { force: true });
  return { changed: true, ...(configBackup ? { backup: configBackup } : {}), ...(profileBackup ? { profileBackup } : {}), config, profile };
}
