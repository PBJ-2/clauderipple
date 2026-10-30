// `clauderipple power | awake … | tether …` — lid-closed awake and hotspot failover from the
// terminal. Changes go through the running router's admin API (`PUT /api/power`), which saves them
// and applies them at once; with no router answering they are saved to config.json and apply when it
// starts (and `awake off` also clears a sleep bit the router left set).

import { persistPowerChange, type PowerChange, type PowerStatus } from "../../router/src/power.ts";
import type { Runner } from "../../router/src/awake.ts";
import { awakeRemove, awakeSetup, releaseAwake, releaseFailedHint, type SetupDeps } from "./awake-setup.ts";

/** `HH:MM` → the next time the clock shows it (today, else tomorrow), as ISO. A full ISO time is accepted too. */
export function parseUntil(text: string, now: Date): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (!m) {
    const t = Date.parse(text);
    if (/^\d{4}-\d{2}-\d{2}T/.test(text) && !Number.isNaN(t)) return new Date(t).toISOString();
    throw new Error(`--until takes HH:MM (24-hour), got "${text}"`);
  }
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw new Error(`--until takes HH:MM (24-hour), got "${text}"`);
  const at = new Date(now);
  at.setHours(h, min, 0, 0);
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
  return at.toISOString();
}

const clock = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function formatPower(s: PowerStatus): string[] {
  const a = s.awake;
  const t = s.tether;
  const lines: string[] = [];
  const setup = a.setup === "ok" ? "" : a.setup === "needs-setup" ? " · needs setup: clauderipple awake setup" : " · not supported here";
  const machine = s.platform === "win32" ? "PC" : "Mac";
  lines.push(`awake   ${a.mode}${a.until ? ` until ${clock(a.until)}` : ""} · ${a.applied ? `holding the ${machine} awake` : "sleep allowed"} (${a.reason})${setup}`);
  const facts: string[] = [];
  if (a.battery) facts.push(a.battery.percent === null ? "no battery" : `battery ${a.battery.percent}% ${a.battery.onBattery ? "(on battery)" : "(on power)"}`);
  if (a.thermal) facts.push(`thermal ${a.thermal}`);
  if (a.lidClosed !== null) facts.push(`lid ${a.lidClosed ? "closed" : "open"}`);
  if (facts.length) lines.push(`        ${facts.join(" · ")}`);
  // A newer router sends an object (app, name, at) or null; an older one the bare string below, or
  // nothing at all. The old string is read as the one app it named.
  const conflict: unknown = a.conflict;
  if (conflict === "aldente-disable-sleep") lines.push(`        conflict: AlDente also changes the sleep setting`);
  else if (conflict && typeof conflict === "object") {
    const c = conflict as { name?: unknown; at?: unknown };
    if (typeof c.name === "string" && c.name !== "") lines.push(`        conflict: ${c.name} also changes the sleep setting`);
    else if (typeof c.at === "string" && !Number.isNaN(Date.parse(c.at))) lines.push(`        conflict: sleep was re-enabled outside ClaudeRipple at ${clock(c.at)} by another app or a settings change`);
  }
  if (!t.enabled) lines.push(`tether  off${t.state === "unsupported" ? " (not supported here)" : ""}`);
  else {
    lines.push(`tether  on · ${t.network} · ${t.state}${t.pinned ? " (pinned)" : ""}${t.hotspotSsid ? ` · hotspot "${t.hotspotSsid}"` : ""}`);
    if (t.lastProbe) lines.push(`        last probe ${t.lastProbe.ok ? "ok" : "FAILED"} at ${clock(t.lastProbe.at)}`);
    if (t.lastSwitch) lines.push(`        last switch to ${t.lastSwitch.to} at ${clock(t.lastSwitch.at)}: ${t.lastSwitch.ok ? "ok" : "failed"} (${t.lastSwitch.reason})`);
  }
  if (t.hint && t.enabled) lines.push(`        → ${t.hint}`);
  return lines;
}

/** One admin call; null when the router is not answering. */
export type PowerCall = (method: "GET" | "PUT", body?: PowerChange) => Promise<{ status: number; json: unknown } | null>;

export function adminPowerCall(port: number): PowerCall {
  return async (method, body) => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/power`, {
        method,
        signal: AbortSignal.timeout(15_000),
        ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
      });
      return { status: res.status, json: await res.json().catch(() => ({})) };
    } catch {
      return null;
    }
  };
}

export type PowerCliDeps = {
  call: PowerCall;
  configFile: string;
  rippleHome: string;
  run: Runner;
  setupDeps: () => SetupDeps;
  print: (line: string) => void;
  now: () => Date;
  platform?: NodeJS.Platform;
};

export const POWER_USAGE = `usage:
  clauderipple power [--json]
  clauderipple awake setup [--ssid <hotspot name>] [--remove]
  clauderipple awake on|off|working [--until HH:MM]
  clauderipple tether on|off`;

/** Runs `power`, `awake …` or `tether …`; returns the exit code. */
export async function powerCli(args: string[], d: PowerCliDeps): Promise<number> {
  const [cmd, sub] = args;
  const opt = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const flag = (name: string): boolean => args.includes(`--${name}`);
  const platform = d.platform ?? process.platform;
  const machine = platform === "win32" ? "PC" : "Mac";

  const show = async (): Promise<number> => {
    const r = await d.call("GET");
    if (!r) {
      d.print("the router is not answering; start it with: clauderipple start");
      return 1;
    }
    if (r.status !== 200) {
      d.print(`error: ${(r.json as { error?: string }).error ?? `HTTP ${r.status}`}`);
      return 1;
    }
    if (flag("json")) d.print(JSON.stringify(r.json));
    else for (const line of formatPower(r.json as PowerStatus)) d.print(line);
    return 0;
  };

  /** Through the router when it answers; saved to the file otherwise. */
  const change = async (c: PowerChange): Promise<number> => {
    const r = await d.call("PUT", c);
    if (r && r.status === 200) {
      for (const line of formatPower(r.json as PowerStatus)) d.print(line);
      return 0;
    }
    if (r) {
      d.print(`error: ${(r.json as { error?: string }).error ?? `HTTP ${r.status}`}`);
      return 1;
    }
    persistPowerChange(d.configFile, c);
    d.print("✓ saved to config.json; the router is not running, so it applies when it starts (clauderipple start)");
    if (c.awake?.mode === "off") {
      const released = await releaseAwake(d.run, d.rippleHome, "awake off (router not running)", platform);
      if (released === "released") d.print(platform === "win32" ? "✓ the lid-close action is back to yours (the router had left it on Do nothing)" : "✓ sleep re-enabled (the router had left it disabled)");
      if (released === "failed") d.print(`✗ could not re-enable sleep: ${releaseFailedHint(platform)}`);
    }
    return 0;
  };

  if (cmd === "power") return show();

  if (cmd === "awake") {
    if (sub === undefined || sub === "status") return show();
    if (sub === "setup") {
      if (flag("remove")) {
        // Off first, so a running router stops re-applying while the rule goes away.
        await change({ awake: { mode: "off" }, tether: { enabled: false } });
        const r = await awakeRemove(d.setupDeps());
        d.print(`${r.ok ? "✓" : "✗"} ${r.detail}`);
        return r.ok ? 0 : 1;
      }
      const ssid = opt("ssid");
      if (args.includes("--ssid") && (ssid === undefined || ssid.startsWith("--"))) {
        d.print("usage: clauderipple awake setup --ssid <hotspot name>");
        return 1;
      }
      const r = await awakeSetup(ssid !== undefined ? { ssid } : {}, d.setupDeps());
      d.print(`${r.ok ? "✓" : "✗"} ${r.detail}`);
      if (!r.ok) return 1;
      if (ssid !== undefined) persistPowerChange(d.configFile, { tether: { hotspotSsid: ssid } });
      d.print("");
      d.print("Next:");
      d.print(`  clauderipple awake working   keep the ${machine} awake (lid closed too) while Claude works, and 10 min after`);
      d.print("  clauderipple awake on [--until HH:MM]   keep it awake regardless");
      if (ssid !== undefined) d.print("  clauderipple tether on       join the phone hotspot when Wi-Fi has no internet, and come back later");
      d.print(`Keep a closed ${machine === "PC" ? "laptop" : "Mac"} on a hard, ventilated surface — never in a bag while it is held awake.`);
      return 0;
    }
    if (sub === "on" || sub === "off" || sub === "working") {
      const raw = opt("until");
      let until: string | null = null;
      if (raw !== undefined) {
        if (sub === "off") {
          d.print("--until applies to on and working");
          return 1;
        }
        try {
          until = parseUntil(raw, d.now());
        } catch (e) {
          d.print((e as Error).message);
          return 1;
        }
      }
      return change({ awake: { mode: sub, until } });
    }
  }

  if (cmd === "tether" && (sub === "on" || sub === "off")) return change({ tether: { enabled: sub === "on" } });

  d.print(POWER_USAGE);
  return 1;
}
