// Hotspot failover on Windows (tether.ts holds the shared probe/decision loop; this is the OS part).
//
// No administrator step: joining a saved Wi-Fi profile and disconnecting are ordinary user actions
// (`netsh wlan connect|disconnect`, WlanConnect/WlanDisconnect).
//
// Windows 11 24H2 put the Native Wifi calls that can reveal a BSSID behind the Location permission:
// WlanGetAvailableNetworkList, WlanGetNetworkBssList, WlanScan, and WlanQueryInterface with
// wlan_intf_opcode_current_connection (Microsoft Learn, "Changes to API behavior for Wi-Fi access and
// location"). `netsh wlan show interfaces` is the last of those, so it is not used: the Wi-Fi adapter
// comes from Get-NetAdapter (NdisPhysicalMedium 9 = Native 802.11, 1 = wireless LAN), its address from
// os.networkInterfaces() (keyed by the same adapter name), and "on the hotspot" from that address as
// on macOS: the iPhone range 172.20.10.0/28, or the network learned after our own `netsh wlan
// connect` to the hotspot's profile (address + netmask from os.networkInterfaces(), which Windows
// fills from GetAdaptersAddresses — no Location, no elevation). Profile listing (WlanGetProfileList /
// WlanGetProfile), connect and disconnect are not on Microsoft's list; if a build gates them anyway,
// netsh says so and the state reads `needs-location` with the Settings path.
//
// netsh's own text is translated, so it is read only where it cannot be avoided: profile names from
// `show profiles` (the part after " : " on each line — the label before it is what gets translated),
// and everything else from `export profile` XML (connectionMode auto|manual, the SSID), which is not.
//
//   failover  `netsh wlan connect name="<profile>" interface="<adapter>"`. Windows keeps the password
//             in the profile, so the hotspot must have been joined once (no profile → a hint).
//   return    `netsh wlan disconnect interface="<adapter>"`; Windows' auto-config then joins the best
//             network whose profile connects automatically. Whether a netsh disconnect suppresses that
//             is not documented for Vista and later (WlanDisconnect's note about "on-demand" profiles
//             is for XP), so if nothing has an address after 8s the first automatic profile other
//             than the hotspot is joined by name. No automatic profile at all → no attempt, a hint.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Runner, RunResult } from "./awake.ts";
import { POWERSHELL, powershellEnv, psArgs } from "./awake-win.ts";
import type { JoinFailure, TetherBackend, TetherState } from "./tether.ts";

const SYSTEM_ROOT = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
export const NETSH = path.win32.join(SYSTEM_ROOT, "System32", "netsh.exe");

/** NdisPhysicalMedium: 9 Native802_11, 1 WirelessLan (8 is WirelessWan, cellular — not Wi-Fi). */
export const FIND_WIFI_PS = [
  "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
  "$a = Get-NetAdapter -Physical -ErrorAction SilentlyContinue | Where-Object { $_.NdisPhysicalMedium -eq 9 -or $_.NdisPhysicalMedium -eq 1 } | Sort-Object { $_.Status -ne 'Up' } | Select-Object -First 1",
  "if ($a) { $a.Name }",
].join("\n");

/** Names netsh can take between double quotes, and nothing else. */
export function quotable(name: string): boolean {
  return name.length > 0 && name.length <= 256 && !/["\r\n\0]/.test(name);
}

export function parseAdapterName(stdout: string): string | null {
  const name = stdout.replace(/^\uFEFF/, "").split(/\r?\n/).map((l) => l.trim()).find((l) => l) ?? null;
  return name && quotable(name) ? name : null;
}

/** Windows 11 24H2+: netsh refuses Wi-Fi commands without Location consent, and says so. */
export function needsLocation(r: RunResult): boolean {
  return /location permission|ms-settings:privacy-location/i.test(`${r.stdout}\n${r.stderr}`);
}

/**
 * `netsh wlan show profiles`, in profile order (Windows' connection preference):
 *   Profiles on interface Wi-Fi:
 *   Group policy profiles (read only)
 *   ---------------------------------
 *       <None>
 *   User profiles
 *   -------------
 *       All User Profile     : Home
 *       All User Profile     : PBJ’s iPhone
 * The labels are translated; the " : " and the name after it are not.
 */
export function parseProfileNames(text: string): string[] {
  const names: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!/^\s{2,}\S/.test(line)) continue;
    const i = line.indexOf(" : ");
    if (i < 0) continue;
    const name = line.slice(i + 3).trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/** `netsh wlan show networks mode=ssid`: SSID is the protocol label, not the translated fields below it. */
export function parseVisibleSsids(text: string): string[] {
  return [...new Set(text.split(/\r?\n/).flatMap((line) => {
    const name = /^\s*SSID\s+\d+\s*:\s?(.*)$/.exec(line)?.[1]?.trim();
    return name ? [name] : [];
  }))];
}

export type WifiProfile = { name: string; ssid: string; auto: boolean };

function xmlText(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n))).replace(/&amp;/g, "&");
}

/** One `netsh wlan export profile` file (WLANProfile schema; not translated). */
export function parseProfileXml(xml: string): WifiProfile | null {
  const body = xml.replace(/^\uFEFF/, "");
  const name = /<name>([^<]*)<\/name>/.exec(body)?.[1];
  if (name === undefined) return null;
  const ssid = /<SSID>[\s\S]*?<name>([^<]*)<\/name>/.exec(body)?.[1];
  const mode = /<connectionMode>\s*(auto|manual)\s*<\/connectionMode>/i.exec(body)?.[1];
  return { name: xmlText(name), ssid: xmlText(ssid ?? name), auto: mode?.toLowerCase() === "auto" };
}

export type ProfileList = { profiles: WifiProfile[]; location?: boolean; error?: string };

/** Saved Wi-Fi profiles in Windows' preference order, with SSID and auto-connect from their XML. */
export async function listWifiProfiles(run: Runner): Promise<ProfileList> {
  const shown = await run(NETSH, ["wlan", "show", "profiles"]);
  if (needsLocation(shown)) return { profiles: [], location: true };
  if (shown.code !== 0) return { profiles: [], error: (shown.stdout || shown.stderr).trim().slice(0, 200) };
  const order = parseProfileNames(shown.stdout);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clauderipple-wlan-"));
  try {
    // No `key=clear`: the passwords stay encrypted (and that would need elevation anyway).
    const r = await run(NETSH, ["wlan", "export", "profile", `folder="${dir}"`], { verbatim: true });
    if (needsLocation(r)) return { profiles: [], location: true };
    if (r.code !== 0) return { profiles: [], error: (r.stderr || r.stdout).trim().slice(0, 200) || `profile export exited ${r.code}` };
    const parsed: WifiProfile[] = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.toLowerCase().endsWith(".xml")) continue;
      const p = parseProfileXml(fs.readFileSync(path.join(dir, f), "utf8"));
      if (p && !parsed.some((q) => q.name === p.name)) parsed.push(p);
    }
    const rank = (p: WifiProfile) => (order.includes(p.name) ? order.indexOf(p.name) : order.length);
    return { profiles: parsed.sort((a, b) => rank(a) - rank(b)) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function hotspotProfile(profiles: WifiProfile[], ssid: string): WifiProfile | null {
  return profiles.find((p) => p.ssid === ssid) ?? profiles.find((p) => p.name === ssid) ?? null;
}

/** Profiles Windows would join by itself, other than the hotspot's. */
export function autoProfiles(profiles: WifiProfile[], ssid: string): WifiProfile[] {
  const hotspot = hotspotProfile(profiles, ssid);
  return profiles.filter((p) => p.auto && p !== hotspot);
}

/** `netsh wlan connect`'s outcome. It returns when the request is queued; the address decides after. */
export function classifyNetshConnect(r: RunResult): JoinFailure | null {
  if (needsLocation(r)) return "needs-location";
  if (r.code === 0) return null;
  const text = `${r.stdout}\n${r.stderr}`;
  if (/is not available to connect/i.test(text)) return "hotspot-not-visible";
  if (/no profile .* assigned|profile .* is not found/i.test(text)) return "no-hotspot-profile";
  return "join-failed";
}

/**
 * What an idle phone does to its hotspot differs, so the step to wake it is said per phone. Shared
 * with the macOS hints; it lives here because tether.ts imports this module (not the other way).
 */
export const HOTSPOT_NOT_VISIBLE_STEPS =
  "On an iPhone, open Settings → Personal Hotspot once (and keep \"Allow Others to Join\" on). On Android, turn Wi-Fi hotspot on again: Android switches it off by itself after a while with nothing connected, unless its \"turn off hotspot automatically\" setting is off.";

export const WIN_HINTS: Partial<Record<TetherState, string>> = {
  "hotspot-not-visible": `Windows could not find the phone's hotspot. ${HOTSPOT_NOT_VISIBLE_STEPS}`,
  "no-hotspot-profile": "Windows has not joined this hotspot before. Join it once from the Wi-Fi menu so Windows saves its password; ClaudeRipple then switches to it by name.",
  "needs-location": "Windows 11 24H2 and later allow Wi-Fi commands only with Location on: Settings → Privacy & security → Location → turn on Location services and \"Let desktop apps access your location\".",
  "no-hotspot-ssid": "Set the phone hotspot's name: `clauderipple awake setup --ssid <hotspot name>`.",
  "no-wifi": "Wi-Fi is not connected. Windows joins the phone hotspot by itself only if its saved profile is set to connect automatically.",
  "join-failed": "Joining the hotspot failed. Check the hotspot name, and that Windows has joined it once before (it keeps the password).",
  pinned: "Switching is paused because the network was pinned.",
};

export class WinTetherBackend implements TetherBackend {
  readonly noAddressOutcome = "hotspot-not-visible" as const;
  readonly hints = WIN_HINTS;
  private readonly run: Runner;
  private readonly log: { info(m: string): void; warn(m: string): void };
  private adapter: string | null = null;

  constructor(run: Runner, log: { info(m: string): void; warn(m: string): void }) {
    this.run = run;
    this.log = log;
  }

  async findWifi(): Promise<string | null> {
    const r = await this.run(POWERSHELL, psArgs(FIND_WIFI_PS), { env: powershellEnv(), timeoutMs: 20_000 });
    this.adapter = r.code === 0 ? parseAdapterName(r.stdout) : null;
    return this.adapter;
  }

  async join(ssid: string): Promise<JoinFailure | null> {
    const list = await listWifiProfiles(this.run);
    if (list.location) return "needs-location";
    const p = hotspotProfile(list.profiles, ssid);
    if (!p) return "no-hotspot-profile";
    return this.connect(p.name);
  }

  private async connect(profile: string): Promise<JoinFailure | null> {
    if (!quotable(profile) || !this.adapter) return "join-failed";
    const r = await this.run(NETSH, ["wlan", "connect", `name="${profile}"`, `interface="${this.adapter}"`], { verbatim: true, timeoutMs: 30_000 });
    const failed = classifyNetshConnect(r);
    if (failed && failed !== "needs-location") this.log.warn(`tether: netsh said: ${(r.stdout + r.stderr).trim().slice(0, 200)}`);
    return failed;
  }

  async returnBlocked(ssid: string): Promise<string | null> {
    const list = await listWifiProfiles(this.run);
    if (list.location) return "Windows needs Location on for Wi-Fi commands";
    if (list.error) throw new Error(`saved Wi-Fi profiles failed: ${list.error}`);
    const known = autoProfiles(list.profiles, ssid).filter((p) => p.ssid !== ssid);
    if (!known.length) return "no other Wi-Fi on this PC is set to connect automatically";
    if (!this.adapter) throw new Error("no Wi-Fi adapter for visibility scan");
    const shown = await this.run(NETSH, ["wlan", "show", "networks", "mode=ssid", `interface="${this.adapter}"`], { verbatim: true, timeoutMs: 20_000 });
    if (needsLocation(shown)) return "Windows needs Location on to scan for known Wi-Fi; visibility is unknown";
    if (shown.code !== 0) throw new Error(`netsh Wi-Fi scan failed: ${(shown.stderr || shown.stdout).trim().slice(0, 200) || `exit ${shown.code}`}`);
    const visible = parseVisibleSsids(shown.stdout);
    if (!visible.length) return "no known Wi-Fi in range (netsh returned no usable SSIDs; empty, redacted or unsupported scan)";
    return known.some((p) => visible.includes(p.ssid)) ? null : "no known Wi-Fi in range";
  }

  /**
   * Whether the hotspot's SSID is in `netsh wlan show networks mode=ssid`, as returnBlocked reads it.
   * The saved profile may carry another name than its SSID, so a name not listed is looked up in the
   * profile's own SSID before it counts as absent. Location denial, a command error, an empty list
   * (empty, redacted or unsupported output) or a hotspot with no saved profile to match are unknown
   * (null), never "not in range".
   */
  async hotspotVisible(ssid: string): Promise<boolean | null> {
    try {
      if (!this.adapter) return null;
      const shown = await this.run(NETSH, ["wlan", "show", "networks", "mode=ssid", `interface="${this.adapter}"`], { verbatim: true, timeoutMs: 20_000 });
      if (needsLocation(shown) || shown.code !== 0) return null;
      const visible = parseVisibleSsids(shown.stdout);
      if (!visible.length) return null;
      if (visible.includes(ssid)) return true;
      const list = await listWifiProfiles(this.run);
      if (list.location || list.error) return null;
      const p = hotspotProfile(list.profiles, ssid);
      if (!p) return null;
      if (visible.includes(p.ssid)) return true;
      // A hidden network is listed with an empty SSID: a saved hidden hotspot may be that entry.
      return /^\s*SSID\s+\d+\s*:\s*$/m.test(shown.stdout) ? null : false;
    } catch (e) {
      this.log.warn(`tether: could not scan for "${ssid}": ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  async leave(): Promise<string | null> {
    if (!this.adapter) return "no Wi-Fi adapter";
    const r = await this.run(NETSH, ["wlan", "disconnect", `interface="${this.adapter}"`], { verbatim: true, timeoutMs: 15_000 });
    return r.code === 0 && !needsLocation(r) ? null : (r.stdout || r.stderr).trim().slice(0, 200) || `netsh exited ${r.code}`;
  }

  async joinKnown(ssid: string): Promise<void> {
    const list = await listWifiProfiles(this.run);
    const first = autoProfiles(list.profiles, ssid)[0];
    if (!first) return;
    this.log.info(`tether: Windows joined nothing by itself; asking for "${first.name}"`);
    await this.connect(first.name);
  }
}
