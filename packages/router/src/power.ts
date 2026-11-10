// The admin contract for lid-closed awake + hotspot failover (`GET|PUT /api/power`).
//
//   GET  → { platform: "darwin"|"win32"|"linux", awake: AwakeStatus, tether: TetherStatus }
//        (`platform` lets a client word things per OS: "Mac" or "PC", the Windows hints. Anything
//        that is neither macOS nor Windows reads "linux", where both features are `unsupported`.)
//   PUT  { awake?: { mode?: "off"|"working"|"on", until?: ISO string | null },
//          tether?: { enabled?: boolean, pin?: boolean } }
//        mode/until/enabled are saved to config.json (the router picks the file up by mtime, like
//        every other settings save); `pin` is in-memory only — it pauses switching until unpinned or
//        until the router restarts.

import fs from "node:fs";
import { writeJsonAtomic } from "./locked-file.ts";
import type { AwakeMode } from "./config.ts";
import type { AwakeStatus } from "./awake.ts";
import type { TetherStatus } from "./tether.ts";

export type PowerPlatform = "darwin" | "win32" | "linux";
export type PowerStatus = { platform: PowerPlatform; awake: AwakeStatus; tether: TetherStatus };

export function powerPlatform(p: NodeJS.Platform): PowerPlatform {
  return p === "darwin" || p === "win32" ? p : "linux";
}

export type PowerChange = {
  awake?: { mode?: AwakeMode; until?: string | null };
  /** `hotspotSsid` is written only by `clauderipple awake setup`, never through the API: the sudoers rule names it. */
  tether?: { enabled?: boolean; pin?: boolean; hotspotSsid?: string };
};

/** What the router hands the admin server. */
export type PowerApi = {
  status: () => PowerStatus;
  pin: (on: boolean) => void;
  /** Re-evaluate now, after a change was saved. */
  poke: () => Promise<void>;
};

/** Validates a PUT body. Returns the change, or what is wrong with it. */
export function parsePowerChange(raw: unknown): PowerChange | string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "expected an object";
  const body = raw as { awake?: unknown; tether?: unknown };
  const out: PowerChange = {};
  for (const key of Object.keys(body)) if (key !== "awake" && key !== "tether") return `unknown field "${key}"`;
  if (body.awake !== undefined) {
    const a = body.awake as { mode?: unknown; until?: unknown } | null;
    if (!a || typeof a !== "object" || Array.isArray(a)) return "awake must be an object";
    for (const key of Object.keys(a)) if (key !== "mode" && key !== "until") return `unknown field "awake.${key}"`;
    const awake: NonNullable<PowerChange["awake"]> = {};
    if (a.mode !== undefined) {
      if (a.mode !== "off" && a.mode !== "working" && a.mode !== "on") return 'awake.mode must be "off", "working" or "on"';
      awake.mode = a.mode;
    }
    if (a.until !== undefined) {
      if (a.until !== null && (typeof a.until !== "string" || Number.isNaN(Date.parse(a.until)))) return "awake.until must be an ISO date-time or null";
      awake.until = a.until === null ? null : new Date(Date.parse(a.until)).toISOString();
    }
    out.awake = awake;
  }
  if (body.tether !== undefined) {
    const t = body.tether as { enabled?: unknown; pin?: unknown } | null;
    if (!t || typeof t !== "object" || Array.isArray(t)) return "tether must be an object";
    // The hotspot name is set by `awake setup` only: the sudoers rule names it.
    for (const key of Object.keys(t)) if (key !== "enabled" && key !== "pin") return `unknown field "tether.${key}"${key === "hotspotSsid" ? " (set it with `clauderipple awake setup --ssid`)" : ""}`;
    const tether: NonNullable<PowerChange["tether"]> = {};
    if (t.enabled !== undefined) {
      if (typeof t.enabled !== "boolean") return "tether.enabled must be true or false";
      tether.enabled = t.enabled;
    }
    if (t.pin !== undefined) {
      if (typeof t.pin !== "boolean") return "tether.pin must be true or false";
      tether.pin = t.pin;
    }
    out.tether = tether;
  }
  return out;
}

/**
 * Applies the persistent part of a change to the config file as it is on disk (re-read, so a save
 * made elsewhere meanwhile is not reverted) and writes it atomically. Returns whether it wrote.
 */
export function persistPowerChange(configFile: string, change: PowerChange): boolean {
  const awake = change.awake ?? {};
  const tether = change.tether ?? {};
  if (awake.mode === undefined && awake.until === undefined && tether.enabled === undefined && tether.hotspotSsid === undefined) return false;
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(fs.readFileSync(configFile, "utf8")) as Record<string, unknown>;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (awake.mode !== undefined || awake.until !== undefined) {
    const next = { ...((raw.awake as Record<string, unknown> | undefined) ?? {}) };
    if (awake.mode !== undefined) next.mode = awake.mode;
    if (awake.until === null) delete next.until;
    else if (awake.until !== undefined) next.until = awake.until;
    raw.awake = next;
  }
  if (tether.enabled !== undefined || tether.hotspotSsid !== undefined) {
    raw.tether = {
      ...((raw.tether as Record<string, unknown> | undefined) ?? {}),
      ...(tether.enabled !== undefined ? { enabled: tether.enabled } : {}),
      ...(tether.hotspotSsid !== undefined ? { hotspotSsid: tether.hotspotSsid } : {}),
    };
  }
  writeJsonAtomic(configFile, raw);
  return true;
}
