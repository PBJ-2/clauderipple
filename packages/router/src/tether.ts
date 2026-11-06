// Fail over to a phone's hotspot (iPhone or Android) when Wi-Fi has no internet, and come back to a known
// Wi-Fi later. The probe/decision loop below is shared; the OS part is a TetherBackend — macOS here,
// Windows in tether-win.ts (netsh, no elevation).
//
// What decides "no internet" is a real HTTP probe through the Wi-Fi interface, not the OS path
// status: a router with a dead uplink or a captive portal reads "satisfied" to NWPathMonitor, which
// is why Insomnia never failed over in that state (research §1.3, §3.3). Behaviour follows wifihop
// (captive.apple.com "Success" + gstatic 204, 3 of the last 5 rounds) and WiFiGuard (switch back when
// a better network returns); the code is our own.
//
//   failover  on Wi-Fi (or none), 3 of the last 5 probe rounds failed → `sudo -n networksetup
//             -setairportnetwork <dev> <hotspot>`; macOS takes the password from the System keychain.
//             macOS with no address at all leaves the first HOTSPOT_JOIN_GRACE_MS to macOS, then
//             tries once a minute: macOS's own Instant Hotspot auto-join can wake the iPhone, and
//             our networksetup call cancels it (measured 2026-11-06, §5).
//   return    on the hotspot, at 5, 10, 20, 30, 40, 50 and 60 min after landing and every 10 min
//             after that, only if another known Wi-Fi is visible with RSSI ≥ RETURN_MIN_RSSI_DBM in
//             a scan the radio actually ran (not airportd's ≤10s cache), while no model call runs →
//             disassociate (CoreWLAN through JXA, as the
//             console user — the router is a launchd agent in the user's session) so macOS
//             auto-joins the best known network in range; probe it; nothing associated within 8s →
//             rejoin the hotspot at once while the iPhone still advertises; each non-hotspot network
//             that appears (address or subnet, re-read after every probe) gets NETWORK_SETTLE_MS
//             from then, every time, inside a RETURN_LOOP_CEILING_MS loop; one that still has no
//             internet → rejoin it and wait for the next point. A network that went away (no
//             address, or the hotspot again) and comes back counts as a new one, with its own
//             settle. The times are fixed
//             from landing rather than a doubling backoff (owner's decision, 2026-10-20): at most
//             ~10 min on the hotspot after arriving at a known Wi-Fi. On the move, a read-only scan
//             replaces the old blind drop (2026-10-21): no known Wi-Fi in range → no leave, no hold.
//   change    a new address, subnet or network class resets the probe window, and a network that
//             just arrived also gets NETWORK_SETTLE_MS in which failures do not count (2026-11-06:
//             the switch's own EADDRNOTAVAIL probes sent a just-joined home Wi-Fi back to the
//             hotspot). Losing the address ("none") resets but does not settle: a dead Wi-Fi still
//             fails over on the old timing. A change is re-read after every await, so a network the
//             OS or the person joined meanwhile is not evicted by the tick that began before it.
//   gap       a return still postponed RETURN_FORCE_AFTER_MS past due (calls back-to-back, so never
//             a quiet moment — 2026-10-20) makes the gap itself: new model calls are held (hold.ts:
//             they wait, they are not refused), the running ones get up to RETURN_DRAIN_WAIT_MS to
//             finish, then the return above runs and the hold is released whatever the outcome.
//             The probe loop is capped so the hotspot is back before the earliest held call goes
//             ahead by itself (HOLD_MAX_MS, hold.ts), measured from the engagement.
//
// Never more than one switch per 60s; nothing switches while the user has pinned the network.
// "On the hotspot" is read from the address, not the SSID (macOS redacts it without Location;
// Windows 11 24H2 gates the query that returns it, see tether-win.ts): an iPhone hotspot hands out
// 172.20.10.0/28, and any other phone's network is learned. An Android hotspot hands out a /24 that
// is not fixed — 192.168.43.x up to Android 10 (IpServer WIFI_HOST_IFACE_ADDR), a random /24 of
// 192.168.0.0/16 from Android 11, of 192.168.0.0/16, 172.16.0.0/12 or 10.0.0.0/8 by Android 14
// (PrivateAddressCoordinator) — so after our own join of the hotspot SSID succeeds, the subnet the
// Wi-Fi interface then has (os.networkInterfaces(): address + netmask, no process, no privilege) is
// remembered as the hotspot's network and kept in <home>/tether.json.

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { TetherSettings } from "./config.ts";
import { SUDO, sudoRefused, type Activity, type Runner } from "./awake.ts";
import { HOLD_MAX_MS, HoldGate } from "./hold.ts";
import { HOTSPOT_NOT_VISIBLE_STEPS, WinTetherBackend } from "./tether-win.ts";

export const NETWORKSETUP = "/usr/sbin/networksetup";
export const OSASCRIPT = "/usr/bin/osascript";
/** wifihop's exact call (verified in its source, `mac_disassociate_js`): a zero-argument ObjC method is invoked by reading it. */
export const DISASSOCIATE_JS = 'ObjC.import("CoreWLAN"); $.CWWiFiClient.sharedWiFiClient.interface.disassociate; "ok";';
/**
 * Read-only scan for the saved SSIDs, with RSSI. One full scan first: it is the call that makes the
 * radio scan (measured 2026-11-06: ~9.5s cold; every scan answer for the next ~8-10s is airportd's
 * cache, ~25ms, and its membership can differ from a real scan's — 13 cached vs 11 fresh). The
 * directed queries after it are answered from that fresh snapshot; a non-empty set proves visibility
 * even if CWNetwork.ssid is redacted. `freshMs` says which kind of answer this was.
 */
export const SCAN_KNOWN_JS = `function run(argv) {
  ObjC.import("CoreWLAN");
  var wifi = $.CWWiFiClient.sharedWiFiClient.interfaceWithName(argv[0]);
  var names = JSON.parse(argv[1]);
  var started = Date.now();
  var error = Ref();
  var all = wifi.scanForNetworksWithNameError($(), error);
  if (!all || !isFinite(Number(all.count))) {
    throw new Error("CoreWLAN scan unavailable: " + (ObjC.unwrap(error[0].localizedDescription) || "no result set"));
  }
  var freshMs = Date.now() - started;
  var nets = [];
  var list = all.allObjects;
  for (var i = 0; i < Number(list.count); i++) {
    var n = list.objectAtIndex(i);
    var ssid = ObjC.unwrap(n.ssid);
    nets.push({ ssid: ssid ? String(ssid) : null, rssi: Number(n.rssiValue) });
  }
  var found = [];
  for (var k = 0; k < names.length; k++) {
    var why = Ref();
    var set = wifi.scanForNetworksWithNameError(names[k], why);
    var count = set ? Number(set.count) : NaN;
    if (!isFinite(count) || count < 0) {
      throw new Error("CoreWLAN scan unavailable: " + (ObjC.unwrap(why[0].localizedDescription) || "no result set"));
    }
    if (count === 0) continue;
    var best = null;
    var arr = set.allObjects;
    for (var j = 0; j < Number(arr.count); j++) {
      var rssi = Number(arr.objectAtIndex(j).rssiValue);
      if (best === null || rssi > best) best = rssi;
    }
    if (best !== null) found.push({ name: names[k], rssi: best });
  }
  return JSON.stringify({ freshMs: freshMs, nets: nets, found: found });
}`;

/** The scan's shape, as SCAN_KNOWN_JS returns it. */
export type KnownWifiScan = {
  /** How long the full scan took: a real radio scan takes seconds; ~25ms means airportd's cache answered. */
  freshMs: number;
  /** The full scan's own list (SSIDs may be redacted). */
  nets: { ssid: string | null; rssi: number }[];
  /** Directed hits: a saved name with its strongest RSSI, even if the full scan redacted it. */
  found: { name: string; rssi: number }[];
};

/** Parse and bound-check SCAN_KNOWN_JS's stdout; null for anything this module did not write. */
export function parseKnownWifiScan(stdout: string): KnownWifiScan | null {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return null;
  }
  const j = raw as { freshMs?: unknown; nets?: unknown; found?: unknown };
  if (!j || typeof j !== "object" || typeof j.freshMs !== "number" || !Number.isFinite(j.freshMs) || j.freshMs < 0) return null;
  if (!Array.isArray(j.nets) || !Array.isArray(j.found)) return null;
  const nets: KnownWifiScan["nets"] = [];
  for (const n of j.nets as unknown[]) {
    const x = n as { ssid?: unknown; rssi?: unknown };
    if (!x || typeof x.rssi !== "number" || !Number.isFinite(x.rssi)) return null;
    if (x.ssid !== null && typeof x.ssid !== "string") return null;
    nets.push({ ssid: x.ssid, rssi: x.rssi });
  }
  const found: KnownWifiScan["found"] = [];
  for (const f of j.found as unknown[]) {
    const x = f as { name?: unknown; rssi?: unknown };
    if (!x || typeof x.name !== "string" || typeof x.rssi !== "number" || !Number.isFinite(x.rssi)) return null;
    found.push({ name: x.name, rssi: x.rssi });
  }
  return { freshMs: j.freshMs, nets, found };
}

export const PROBE_URLS = {
  apple: "http://captive.apple.com/hotspot-detect.html",
  google: "http://connectivitycheck.gstatic.com/generate_204",
} as const;
export const PROBE_TIMEOUT_MS = 4_000;
export const MIN_SWITCH_INTERVAL_MS = 60_000;
/**
 * After a join that failed, the next try comes this much later per failure in a row (10, 20, 30 s…)
 * up to MIN_SWITCH_INTERVAL_MS. A failed join switched nothing, so the once-a-minute rule against
 * flapping does not apply: walking out of the office, the first join failed as the hotspot was only
 * just coming into range, and the Mac sat offline for the rest of the minute (2026-10-22).
 */
export const JOIN_RETRY_MS = 10_000;
/** How long a scan that saw a known Wi-Fi stands for a return still waiting on busy calls. */
export const KNOWN_VISIBLE_TRUST_MS = 60_000;
export const RETURN_PROBE_MS = 20_000;
/**
 * A saved Wi-Fi is worth leaving the hotspot for at this signal or better. Measured on the owner's
 * Mac (2026-11-06): home networks -36/-40 dBm; networks in the same building -64/-65; weak/foreign
 * ones -73, -79, -92. The weaker half is exactly the "visible" network that made the return drop a
 * working hotspot (18:37, §5), so -70 separates what is in the room from what the scan merely hears.
 */
export const RETURN_MIN_RSSI_DBM = -70;
/**
 * A full CoreWLAN scan takes seconds; an answer this fast came from airportd's scan cache (measured
 * 2026-11-06: ~9.5s cold, ~25ms cached, the cache standing about 8-10s). Visibility from a cached
 * answer is not trusted: its membership differed from the next real scan's (13 vs 11 networks).
 */
export const SCAN_FRESH_MIN_MS = 1_000;
/** How long to let the scan cache expire before asking again for a real scan (~10s measured). */
export const SCAN_CACHE_TTL_MS = 10_000;
/**
 * macOS with no Wi-Fi address: leave the join to macOS this long before calling networksetup. macOS
 * wakes a sleeping iPhone through Instant Hotspot and joins it by itself, while our networksetup join
 * cancels that auto-join in progress and cannot wake a phone with no client ("Auto-join COMPLETED …
 * error=(53 'Auto-join disabled'), wasCancelled=1", then "Could not find network PBJ", 2026-11-06).
 */
export const HOTSPOT_JOIN_GRACE_MS = 60_000;
/**
 * A changed Wi-Fi address, subnet or network class gets this long before its failed probes count.
 * The switch itself produces EADDRNOTAVAIL probes on the old address; on 2026-11-06 five such
 * failures were still in the window when the owner joined home Wi-Fi and sent it back to the hotspot.
 */
export const NETWORK_SETTLE_MS = 30_000;
/**
 * The whole return probe loop's ceiling for a quiet (idle) return, however many networks appear in
 * it: each newly appeared one gets its full NETWORK_SETTLE_MS (a Wi-Fi can appear, vanish and be
 * replaced while the loop watches), so without a ceiling a flapping radio could stretch it
 * indefinitely. A return with a held gap is bounded by the earliest held call instead: it goes
 * ahead HOLD_MAX_MS (120s) after the gate engaged, and the final hotspot rejoin needs up to
 * HOTSPOT_REJOIN_BUDGET_MS (networksetup ≤30s + JOIN_SETTLE_MS 15s = 45s) of that, so the loop and
 * every settle in it must end by engage + 120s − 45s = 75s (leaveHotspot). Without that cap the
 * drain (60s) + leave (≤15s) + this ceiling (100s) = 175s, and a held call would go out onto a
 * Wi-Fi with no internet before the hotspot came back. The failsafe on the hold itself still
 * covers a return that never came back to release it: engage + RETURN_HOLD_FAILSAFE_MS.
 */
export const RETURN_LOOP_CEILING_MS = 100_000;
/**
 * When to try the way back, counted from the moment the Mac landed on the hotspot: 5, 10, 20, 30,
 * 40, 50 and 60 min, then every 10 min for as long as it stays there (owner's decision, 2026-10-20 —
 * a fixed schedule rather than a doubling one: at most ~10 min on the hotspot after arriving at a
 * known Wi-Fi). Each point scans first; without a visible known network it never drops the hotspot.
 */
export const RETURN_SCHEDULE_MINUTES = [5, 10, 20, 30, 40, 50, 60] as const;
/** After the last scheduled point, every this long. */
export const RETURN_INTERVAL_AFTER_MS = 10 * 60_000;
/** A model call this recent counts as "Claude is working": no return attempt (it drops the link for seconds). */
export const RETURN_QUIET_MS = 20_000;
/** Failover waits at most this long for an in-flight call; a dead network cannot serve it anyway. */
export const FAILOVER_IDLE_WAIT_MS = 30_000;
/** A return postponed this long past due stops waiting for a quiet moment and makes one. */
export const RETURN_FORCE_AFTER_MS = 2 * 60_000;
/**
 * With new calls held, the running ones get this long to finish before the attempt is given up.
 * A long drain leaves the return probe loop less time (leaveHotspot ends the loop so the hotspot
 * is back inside a held call's HOLD_MAX_MS), and it stays well under the ~180s after which Claude
 * Code gave up on a call that had no answer yet (13 Google turns closed at 182–190s, 2026-10-20).
 */
export const RETURN_DRAIN_WAIT_MS = 60_000;
/** The hold releases itself after this even if the return never comes back to release it. */
export const RETURN_HOLD_FAILSAFE_MS = RETURN_DRAIN_WAIT_MS + 3 * 60_000;
const JOIN_SETTLE_MS = 15_000;
/**
 * The worst case for putting the hotspot back after the return loop: the networksetup join's own
 * timeout (30s) plus JOIN_SETTLE_MS. A return with a held gap cuts the loop short by this much so
 * the hotspot is back before the earliest held call goes ahead (RETURN_LOOP_CEILING_MS).
 */
const HOTSPOT_REJOIN_BUDGET_MS = 30_000 + JOIN_SETTLE_MS;
/** States that say why the last join failed; they stay (with their hint) until the next attempt. */
const JOIN_FAILURES: ReadonlySet<string> = new Set(["hotspot-not-visible", "join-failed", "needs-setup", "no-hotspot-profile", "needs-location"]);
/** Failures a moment later can cure (the phone coming into range); setup problems wait the full minute. */
const RETRIABLE_JOIN: ReadonlySet<string> = new Set(["hotspot-not-visible", "join-failed"]);

// ---- Pure helpers -------------------------------------------------------------------------------

/** The Wi-Fi device from `networksetup -listallhardwareports` ("Hardware Port: Wi-Fi\nDevice: en0"). */
export function parseWifiDevice(text: string): string | null {
  const blocks = text.split(/\n\s*\n/);
  for (const b of blocks) {
    if (!/Hardware Port:\s*(Wi-Fi|AirPort)\s*$/m.test(b)) continue;
    const dev = /Device:\s*(\S+)/.exec(b)?.[1];
    if (dev && /^en\d+$/.test(dev)) return dev;
  }
  return null;
}

/** `networksetup -listpreferredwirelessnetworks`: preserve SSID spaces, discard only the indent. */
export function parsePreferredNetworks(text: string): string[] {
  return [...new Set(text.split(/\r?\n/).filter((line) => line.startsWith("\t")).map((line) => line.slice(1)).filter(Boolean))];
}

/** The interface's IPv4 address, or null when it has none (not associated, or no DHCP yet). */
export function wifiIPv4(ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>, device: string): string | null {
  return ifaces[device]?.find((a) => a.family === "IPv4" && !a.internal)?.address ?? null;
}

/** An iPhone Personal Hotspot hands out 172.20.10.0/28 (172.20.10.0–15). */
export function isHotspotAddress(ip: string | null): boolean {
  const m = ip ? /^172\.20\.10\.(\d{1,3})$/.exec(ip) : null;
  return !!m && Number(m[1]) <= 15;
}

function ipv4ToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

function intToIpv4(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

/** "192.168.43.17" + "255.255.255.0" → "192.168.43.0/24"; null for anything else (no or a non-contiguous mask). */
export function ipv4Network(address: string, netmask: string): string | null {
  const a = ipv4ToInt(address);
  const m = ipv4ToInt(netmask);
  if (a === null || m === null) return null;
  const bits = m.toString(2).replace(/0+$/, "");
  if (m !== 0 && bits.includes("0")) return null;
  const len = m === 0 ? 0 : bits.length;
  if (len < 8 || len > 30) return null; // a /31 or /32 is no DHCP network; shorter than /8 is no hotspot
  return `${intToIpv4((a & m) >>> 0)}/${len}`;
}

/** Whether `ip` is inside `network` ("a.b.c.d/len"). */
export function inNetwork(ip: string | null, network: string | null): boolean {
  if (!ip || !network) return false;
  const [base, lenText] = network.split("/");
  const a = ipv4ToInt(ip);
  const b = base ? ipv4ToInt(base) : null;
  const len = Number(lenText);
  if (a === null || b === null || !Number.isInteger(len) || len < 0 || len > 32) return false;
  const mask = len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0;
  return ((a & mask) >>> 0) === ((b & mask) >>> 0);
}

/** 169.254.0.0/16: what an interface gives itself when DHCP did not answer — not a join. */
export function isLinkLocal(ip: string | null): boolean {
  return inNetwork(ip, "169.254.0.0/16");
}

export type Network = "wifi" | "hotspot" | "none";
/** The iPhone range, or the network remembered from our own join of the hotspot (`learned`). */
export function classifyNetwork(ip: string | null, learned: string | null = null): Network {
  return ip === null ? "none" : isHotspotAddress(ip) || inNetwork(ip, learned) ? "hotspot" : "wifi";
}

/** The interface's IPv4 network ("a.b.c.d/len"), from the same os.networkInterfaces() entry as wifiIPv4. */
export function wifiIPv4Network(ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>, device: string): string | null {
  const a = ifaces[device]?.find((x) => x.family === "IPv4" && !x.internal);
  return a ? ipv4Network(a.address, a.netmask) : null;
}

/** What `<home>/tether.json` keeps: the network a join of `ssid` landed on, outside the iPhone range. */
export type LearnedHotspot = { ssid: string; network: string; learnedAt: string };

export function readLearnedHotspot(file: string): LearnedHotspot | null {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8")) as { hotspot?: Partial<LearnedHotspot> };
    const h = j.hotspot;
    if (!h || typeof h.ssid !== "string" || typeof h.network !== "string") return null;
    const [base, len] = h.network.split("/");
    const bits = Number(len);
    // Only a canonical "network/len" this module could have written; anything else is forgotten.
    if (!base || !Number.isInteger(bits) || bits < 8 || bits > 30) return null;
    if (ipv4Network(base, intToIpv4((0xffffffff << (32 - bits)) >>> 0)) !== h.network) return null;
    return { ssid: h.ssid, network: h.network, learnedAt: String(h.learnedAt ?? "") };
  } catch {
    return null;
  }
}

export function writeLearnedHotspot(file: string, h: LearnedHotspot): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ hotspot: h }) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * The next scheduled return time at or after `now + minGapMs`, on the fixed schedule counted from
 * `landedAt` (5, 10, 20, 30, 40, 50, 60 min, then every 10). A point already passed is skipped, so a
 * long gap attempt or a slow tick never retries in the past or bursts two switches together.
 */
export function nextReturnPoint(landedAt: number, now: number, minGapMs = MIN_SWITCH_INTERVAL_MS): number {
  const floor = now + minGapMs;
  for (const minutes of RETURN_SCHEDULE_MINUTES) {
    const at = landedAt + minutes * 60_000;
    if (at >= floor) return at;
  }
  const last = landedAt + RETURN_SCHEDULE_MINUTES[RETURN_SCHEDULE_MINUTES.length - 1]! * 60_000;
  const steps = Math.max(1, Math.ceil((floor - last) / RETURN_INTERVAL_AFTER_MS));
  return last + steps * RETURN_INTERVAL_AFTER_MS;
}

/** The last five probe rounds; an outage is 3 failures among them, so a 1s blip never switches. */
export class ProbeWindow {
  private rounds: boolean[] = [];
  push(ok: boolean): void {
    this.rounds.push(ok);
    if (this.rounds.length > 5) this.rounds.shift();
  }
  failures(): number {
    return this.rounds.filter((ok) => !ok).length;
  }
  outage(): boolean {
    return this.failures() >= 3;
  }
  reset(): void {
    this.rounds = [];
  }
}

export type ProbeGet = (url: string, localAddress: string, timeoutMs: number) => Promise<{ status: number; body: string }>;

/**
 * One HTTP GET bound to a local address (so the request leaves through that interface). `timeoutMs`
 * is a whole-request deadline: Node's own `timeout` is only socket inactivity, and a captive portal
 * that trickles bytes kept a 4 s probe open 6.5 s, past the held-gap cap that counts on the bound.
 */
export const httpGet: ProbeGet = (url, localAddress, timeoutMs) =>
  new Promise((resolve, reject) => {
    const deadline = setTimeout(() => req.destroy(new Error("probe timed out")), timeoutMs);
    deadline.unref();
    const done = <T>(fn: (v: T) => void) => (v: T) => {
      clearTimeout(deadline);
      fn(v);
    };
    resolve = done(resolve);
    reject = done(reject);
    const req = http.get(url, { localAddress, timeout: timeoutMs, headers: { "cache-control": "no-cache" } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => {
        if (body.length < 4096) body += c;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("probe timed out")));
    req.on("error", reject);
  });

/** One round: both endpoints at once; the round fails only if both fail. */
export async function probeRound(localAddress: string, get: ProbeGet = httpGet): Promise<boolean> {
  const apple = get(PROBE_URLS.apple, localAddress, PROBE_TIMEOUT_MS).then((r) => r.status === 200 && r.body.includes("Success"), () => false);
  const google = get(PROBE_URLS.google, localAddress, PROBE_TIMEOUT_MS).then((r) => r.status === 204, () => false);
  const [a, g] = await Promise.all([apple, google]);
  return a || g;
}

export type JoinOutcome = "joined" | "needs-setup" | "hotspot-not-visible" | "join-failed" | "no-hotspot-profile" | "needs-location";
export type JoinFailure = Exclude<JoinOutcome, "joined">;

/**
 * `networksetup -setairportnetwork` reports failure on stdout and may still exit 0
 * ("Could not find network X." / "Failed to join network X."), so the text decides.
 */
export function classifyJoin(r: { code: number; stdout: string; stderr: string }): JoinFailure | null {
  if (sudoRefused(r)) return "needs-setup";
  const text = `${r.stdout}\n${r.stderr}`;
  if (/could not find network/i.test(text)) return "hotspot-not-visible";
  if (r.code !== 0 || /failed|error/i.test(text)) return "join-failed";
  return null;
}

// ---- Controller ---------------------------------------------------------------------------------

export type TetherState =
  | "off" | "unsupported" | "no-wifi-device" | "watching" | "no-wifi" | "outage" | "pinned"
  | "joining-hotspot" | "on-hotspot" | "returning" | "hotspot-not-visible" | "join-failed"
  | "needs-setup" | "no-hotspot-ssid" | "no-hotspot-profile" | "needs-location";

/** What one OS does for the controller. */
export interface TetherBackend {
  /** The Wi-Fi interface, as os.networkInterfaces() names it; null when there is none. */
  findWifi(): Promise<string | null>;
  /** Asks the OS to join the hotspot. null: the request went through, and the address decides. */
  join(ssid: string): Promise<JoinFailure | null>;
  /** What a join that went through but brought no hotspot address within 15s means here. */
  readonly noAddressOutcome: JoinFailure;
  /** Leaves the current network so the OS joins its best known one. An error text, or null. */
  leave(): Promise<string | null>;
  /** Once, when leave() gave no address after a few seconds: join a known network by name. */
  joinKnown?(ssid: string): Promise<void>;
  /**
   * macOS: an idle iPhone stops advertising, so when nothing has been associated
   * JOIN_KNOWN_AFTER_MS after leaving, the hotspot is joined again at once instead of probing on.
   */
  readonly rejoinHotspotIfUnassociated?: boolean;
  /** Read-only check before holding calls or leaving: null ONLY if another known Wi-Fi is visible. */
  returnBlocked(ssid: string): Promise<string | null>;
  readonly hints: Partial<Record<TetherState, string>>;
}

/** Waiting this long after leave() with no address at all, a backend may join a known network itself. */
export const JOIN_KNOWN_AFTER_MS = 8_000;

export type TetherStatus = {
  enabled: boolean;
  network: Network;
  state: TetherState;
  pinned: boolean;
  hotspotSsid: string;
  lastSwitch: { at: string; to: "hotspot" | "wifi"; ok: boolean; reason: string } | null;
  lastProbe: { at: string; ok: boolean; network: Network } | null;
  hint: string | null;
};

export type TetherDeps = {
  platform: NodeJS.Platform;
  run: Runner;
  settings: () => TetherSettings;
  activity: () => Activity;
  log: { info(m: string): void; warn(m: string): void };
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  interfaces?: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  /** One probe round through this local address. */
  probe?: (localAddress: string) => Promise<boolean>;
  /** Schedules the next tick after `ms`; returns a cancel. Tests pass a no-op. */
  schedule?: (fn: () => void, ms: number) => () => void;
  /** The gate the proxy and the ingress hold new model calls at; one of its own when not given. */
  hold?: HoldGate;
  /** Where the learned hotspot network is kept (`<home>/tether.json`); in memory only when not given. */
  stateFile?: string;
};

const MAC_HINTS: Partial<Record<TetherState, string>> = {
  "hotspot-not-visible": `The phone is not broadcasting its hotspot, so the Mac cannot see it. ${HOTSPOT_NOT_VISIBLE_STEPS}`,
  "needs-setup": "Run `clauderipple awake setup --ssid <hotspot name>` once: joining the hotspot needs the rule it installs (and the name must match it).",
  "no-hotspot-ssid": "Set the phone hotspot's name: `clauderipple awake setup --ssid <hotspot name>`.",
  "no-wifi": "Wi-Fi is not connected. macOS joins an iPhone hotspot by itself when no Wi-Fi is available if System Settings → Wi-Fi → \"Ask to join hotspots\" is Automatic; ClaudeRipple leaves the first minute to it, because a networksetup join cancels that auto-join. An Android hotspot is joined like any known Wi-Fi with Auto-Join on.",
  "join-failed": "Joining the hotspot failed. Check the hotspot name, and that the Mac has joined it once before (macOS keeps its password).",
  pinned: "Switching is paused because the network was pinned.",
};

class MacTetherBackend implements TetherBackend {
  readonly noAddressOutcome = "join-failed" as const;
  readonly hints = MAC_HINTS;
  readonly rejoinHotspotIfUnassociated = true as const;
  private readonly run: Runner;
  private readonly log: { info(m: string): void; warn(m: string): void };
  private readonly sleep: (ms: number) => Promise<void>;
  private device: string | null = null;

  constructor(run: Runner, log: { info(m: string): void; warn(m: string): void }, sleep: (ms: number) => Promise<void>) {
    this.run = run;
    this.log = log;
    this.sleep = sleep;
  }

  async findWifi(): Promise<string | null> {
    const r = await this.run(NETWORKSETUP, ["-listallhardwareports"]);
    this.device = r.code === 0 ? parseWifiDevice(r.stdout) : null;
    return this.device;
  }

  /** `sudo -n networksetup -setairportnetwork <dev> <ssid>`. */
  async join(ssid: string): Promise<JoinFailure | null> {
    const r = await this.run(SUDO, ["-n", NETWORKSETUP, "-setairportnetwork", this.device!, ssid], { timeoutMs: 30_000 });
    const failed = classifyJoin(r);
    if (failed && failed !== "needs-setup") this.log.warn(`tether: networksetup said: ${(r.stdout + r.stderr).trim().slice(0, 200)}`);
    return failed;
  }

  async returnBlocked(ssid: string): Promise<string | null> {
    const preferred = await this.run(NETWORKSETUP, ["-listpreferredwirelessnetworks", this.device!]);
    if (preferred.code !== 0) throw new Error(`preferred Wi-Fi list failed: ${(preferred.stderr || preferred.stdout).trim().slice(0, 200) || `exit ${preferred.code}`}`);
    const names = parsePreferredNetworks(preferred.stdout).filter((name) => name !== ssid);
    if (!names.length) return "no known Wi-Fi in range";
    let scan = await this.scanKnown(names);
    if (scan.freshMs < SCAN_FRESH_MIN_MS) {
      // A cached answer can name a network that is no longer there (2026-11-06): ask again once.
      this.log.info(`tether: the return scan was answered from cache after ${scan.freshMs}ms; scanning again once it expires`);
      await this.sleep(SCAN_CACHE_TTL_MS);
      scan = await this.scanKnown(names);
      if (scan.freshMs < SCAN_FRESH_MIN_MS) return "Wi-Fi visibility is unknown (the scan was answered from cache)";
    }
    const best = this.bestKnown(scan, names);
    if (best && best.rssi >= RETURN_MIN_RSSI_DBM) {
      this.log.info(`tether: a known Wi-Fi is visible (${best.name} ${best.rssi} dBm)`);
      return null;
    }
    if (best) return `the strongest known Wi-Fi is too weak (${best.name} ${best.rssi} dBm, needs ${RETURN_MIN_RSSI_DBM})`;
    return "no known Wi-Fi in range";
  }

  /** One full scan plus directed queries; throws on anything that is not an answer this module can read. */
  private async scanKnown(names: string[]): Promise<KnownWifiScan> {
    const r = await this.run(OSASCRIPT, ["-l", "JavaScript", "-e", SCAN_KNOWN_JS, this.device!, JSON.stringify(names)], { timeoutMs: 30_000 });
    if (r.code !== 0) throw new Error(`CoreWLAN scan failed: ${(r.stderr || r.stdout).trim().slice(0, 200) || `exit ${r.code}`}`);
    const scan = parseKnownWifiScan(r.stdout);
    if (!scan) throw new Error("CoreWLAN scan returned an unsupported result");
    return scan;
  }

  /** The strongest signal among the saved names, from the full scan's list or the directed hits. */
  private bestKnown(scan: KnownWifiScan, names: string[]): { name: string; rssi: number } | null {
    const wanted = new Set(names);
    let best: { name: string; rssi: number } | null = null;
    for (const n of scan.nets) {
      if (n.ssid === null || !wanted.has(n.ssid)) continue;
      if (!best || n.rssi > best.rssi) best = { name: n.ssid, rssi: n.rssi };
    }
    for (const f of scan.found) {
      if (!wanted.has(f.name)) continue;
      if (!best || f.rssi > best.rssi) best = { name: f.name, rssi: f.rssi };
    }
    return best;
  }

  async leave(): Promise<string | null> {
    const r = await this.run(OSASCRIPT, ["-l", "JavaScript", "-e", DISASSOCIATE_JS], { timeoutMs: 15_000 });
    return r.code === 0 ? null : (r.stderr || r.stdout).trim().slice(0, 200);
  }
}

export class TetherController {
  private readonly deps: TetherDeps;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly interfaces: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  private readonly probe: (localAddress: string) => Promise<boolean>;
  private readonly backend: TetherBackend | null;
  private readonly window = new ProbeWindow();
  private device: string | null = null;
  private network: Network = "none";
  private state: TetherState = "off";
  private pinned = false;
  private lastSwitchAt = 0;
  /** Hotspot joins that failed in a row; the retry gap grows with it (JOIN_RETRY_MS). */
  private joinFailures = 0;
  /** When a scan last saw a known Wi-Fi other than the hotspot. */
  private knownVisibleAt = -Infinity;
  private lastSwitch: TetherStatus["lastSwitch"] = null;
  private lastProbe: TetherStatus["lastProbe"] = null;
  /** When the Mac landed on the hotspot (ours or by hand); null off the hotspot. The schedule counts from here. */
  private landedOnHotspotAt: number | null = null;
  private nextReturnAt = 0;
  private busy: Promise<void> | null = null;
  private cancel: (() => void) | null = null;
  private lastLogged = "";
  private readonly hold: HoldGate;
  /** True while this controller has the gate engaged (stop() releases it). */
  private holding = false;
  private stopped = false;
  /** The hotspot's network learned from our own join (outside the iPhone range); see learn(). */
  private learned: LearnedHotspot | null;
  /** The subnet last watched as ordinary Wi-Fi: a join landing on it cannot be told apart from it. */
  private lastWifiNetwork: string | null = null;
  /** When the Wi-Fi interface was first seen with no IPv4 address; null while it has one. */
  private noAddressSince: number | null = null;
  /** The network the last tick saw (address, subnet, class), to notice a change and settle it. */
  private seenIp: string | null = null;
  private seenSubnet: string | null = null;
  private seenNetwork: Network = "none";
  private seenOnce = false;
  /** Until this time the new network's failed probes do not count toward an outage (NETWORK_SETTLE_MS). */
  private settleUntil = 0;

  constructor(deps: TetherDeps) {
    this.deps = deps;
    this.learned = deps.stateFile ? readLearnedHotspot(deps.stateFile) : null;
    this.hold = deps.hold ?? new HoldGate();
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.interfaces = deps.interfaces ?? os.networkInterfaces;
    this.probe = deps.probe ?? ((addr) => probeRound(addr));
    this.backend =
      deps.platform === "darwin" ? new MacTetherBackend(deps.run, deps.log, this.sleep) : deps.platform === "win32" ? new WinTetherBackend(deps.run, deps.log) : null;
    if (!this.backend) this.state = "unsupported";
  }

  get supported(): boolean {
    return this.backend !== null;
  }

  start(): void {
    if (!this.supported) return;
    this.stopped = false;
    this.loop();
  }

  /** Stops the loop; a hold this controller engaged is released now (a return in progress gives up). */
  stop(): void {
    this.stopped = true;
    this.cancel?.();
    this.cancel = null;
    if (this.holding) this.releaseHold("the controller stopped");
  }

  /** Run a tick soon (after the settings changed) without waiting for it. */
  kick(): void {
    if (this.supported) void this.tick();
  }

  setPin(on: boolean): void {
    if (this.pinned === on) return;
    this.pinned = on;
    this.deps.log.info(`tether: network ${on ? "pinned; switching paused" : "unpinned; switching resumes"}`);
    if (on) this.state = "pinned";
    this.window.reset();
  }

  status(): TetherStatus {
    const s = this.deps.settings();
    return {
      enabled: s.enabled,
      network: this.network,
      state: this.state,
      pinned: this.pinned,
      hotspotSsid: s.hotspotSsid,
      lastSwitch: this.lastSwitch,
      lastProbe: this.lastProbe,
      hint: this.backend?.hints[this.state] ?? null,
    };
  }

  private loop(): void {
    const schedule = this.deps.schedule ?? ((fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref();
      return () => clearTimeout(t);
    });
    const every = Math.max(5, this.deps.settings().probeEverySec) * 1000;
    this.cancel = schedule(() => {
      void this.tick().finally(() => {
        if (this.cancel) this.loop();
      });
    }, every);
  }

  tick(): Promise<void> {
    if (!this.supported) return Promise.resolve();
    if (!this.busy) this.busy = this.evaluate().catch((e: Error) => this.deps.log.warn(`tether: ${e.message}`)).finally(() => (this.busy = null));
    return this.busy;
  }

  private decide(line: string): void {
    if (line === this.lastLogged) return;
    this.lastLogged = line;
    this.deps.log.info(`tether: ${line}`);
  }

  private currentIp(): string | null {
    return this.device ? wifiIPv4(this.interfaces(), this.device) : null;
  }

  private currentNetwork(): string | null {
    return this.device ? wifiIPv4Network(this.interfaces(), this.device) : null;
  }

  /** The learned network, while it belongs to the hotspot name configured now. */
  private learnedNetwork(): string | null {
    return this.learned && this.learned.ssid === this.deps.settings().hotspotSsid ? this.learned.network : null;
  }

  private onHotspot(ip: string | null): boolean {
    return classifyNetwork(ip, this.learnedNetwork()) === "hotspot";
  }

  private idle(): boolean {
    const a = this.deps.activity();
    return a.inFlight === 0 && (a.lastStartedAt === undefined || this.now() - a.lastStartedAt >= RETURN_QUIET_MS);
  }

  /**
   * Notices a new Wi-Fi address, subnet or network class and resets the probe window, so failures
   * belonging to the network just left cannot count against the one the OS or the person joined.
   * The first observation is only a baseline: a start is not a change. Returns whether it was one.
   */
  private noteNetwork(ip: string | null, subnet: string | null, now: number): boolean {
    if (!this.seenOnce) {
      this.seenOnce = true;
      this.seenIp = ip;
      this.seenSubnet = subnet;
      this.seenNetwork = this.network;
      return false;
    }
    if (ip === this.seenIp && this.network === this.seenNetwork && (this.network === "none" || subnet === this.seenSubnet)) return false;
    const from = `${this.seenNetwork}${this.seenIp ? ` ${this.seenIp}` : ""}`;
    const to = `${this.network}${ip ? ` ${ip}` : ""}`;
    this.seenIp = ip;
    this.seenSubnet = subnet;
    this.seenNetwork = this.network;
    this.window.reset();
    this.joinFailures = 0;
    this.knownVisibleAt = -Infinity;
    // Only a network that just arrived settles: the switch's own probes fail until it is up, and
    // they are not its failures. A lost address has no new network to protect — a settle there
    // pushed Windows' first hotspot join from ~20s to ~50s after the loss (2026-11-06).
    this.settleUntil = ip !== null ? now + NETWORK_SETTLE_MS : 0;
    this.step(`network changed (${from} → ${to}); probe window reset${ip !== null ? `, ${NETWORK_SETTLE_MS / 1000}s settle` : ""}`);
    return true;
  }

  /**
   * Reads the Wi-Fi address now and applies what it says (class, subnet, and the reset/settle in
   * noteNetwork). A tick that awaits — a probe, a wait for in-flight calls — must ask again before
   * acting: the OS or the person may have joined another network meanwhile.
   */
  private sampleNetwork(now: number): { ip: string | null; changed: boolean } {
    const ip = this.currentIp();
    this.network = classifyNetwork(ip, this.learnedNetwork());
    const subnet = this.currentNetwork();
    const changed = this.noteNetwork(ip, subnet, now);
    if (this.network === "wifi") this.lastWifiNetwork = subnet;
    this.noAddressSince = ip === null ? (this.noAddressSince ?? now) : null;
    return { ip, changed };
  }

  /**
   * Reads the network again before disassociating, after an await (the visibility scan, the drain
   * wait for running calls). Leaving now would disassociate whatever the OS or the person joined
   * meanwhile (§8 "A change after an await wins"); a change, or a hotspot no longer held, stops the
   * leave. `sampleNetwork` has already reset the window and started the new network's settle, so
   * the next tick judges it. Returns true when it is not safe to leave; logged once per attempt.
   */
  private networkMovedBeforeLeave(when: string): boolean {
    const s = this.sampleNetwork(this.now());
    if (!s.changed && this.onHotspot(s.ip)) return false;
    this.step(`not leaving the hotspot: the network changed ${when} (now ${this.network}${s.ip ? ` ${s.ip}` : ""}); the new network is judged by the next tick`);
    return true;
  }

  private async evaluate(): Promise<void> {
    const settings = this.deps.settings();
    if (!settings.enabled) {
      if (this.state !== "off") this.decide("disabled");
      this.state = "off";
      this.landedOnHotspotAt = null;
      this.window.reset();
      return;
    }
    if (!this.device) {
      this.device = await this.backend!.findWifi();
      if (!this.device) {
        this.state = "no-wifi-device";
        this.decide("no Wi-Fi interface found");
        return;
      }
    }
    const now = this.now();
    const ip = this.sampleNetwork(now).ip;
    let settling = now < this.settleUntil;
    let ok = ip ? await this.probe(ip) : false;
    this.lastProbe = { at: new Date(this.now()).toISOString(), ok, network: this.network };
    const after = this.sampleNetwork(this.now());
    if (after.changed) {
      // A probe takes seconds: whatever this round found belongs to the address the tick began on.
      // A network that arrived meanwhile is judged by the next tick, once it has had its settle —
      // failing over now would evict the Wi-Fi the OS or the person just joined. A lost address is
      // simply a failure, and one with nothing to protect the hotspot join stays right.
      if (after.ip !== null) return;
      ok = false;
      settling = false;
    }
    // The switch's own failures (a probe bound to the old address fails EADDRNOTAVAIL) are not the
    // new network's: during its settle time only successes count (2026-11-06).
    if (!settling || ok) this.window.push(ok);
    if (this.pinned) {
      this.state = "pinned";
      return;
    }
    if (this.network === "hotspot") {
      // Landed here by our own failover or by hand: either way, plan the way back from here.
      this.joinFailures = 0;
      if (this.landedOnHotspotAt === null) {
        this.landedOnHotspotAt = this.now();
        this.nextReturnAt = nextReturnPoint(this.landedOnHotspotAt, this.now());
      }
      if (this.state !== "on-hotspot") this.decide(`on the hotspot; next try for Wi-Fi in ${Math.round((this.nextReturnAt - this.now()) / 1000)}s`);
      this.state = "on-hotspot";
      if (this.now() >= this.nextReturnAt) await this.tryReturn(settings);
      return;
    }
    // On Wi-Fi (or none): the way back is no longer pending, and landing again starts the schedule over.
    this.landedOnHotspotAt = null;
    if (!this.window.outage()) {
      if (this.network === "wifi") this.joinFailures = 0;
      this.state = this.network === "wifi" ? "watching" : "no-wifi";
      if (this.network === "wifi") this.decide(`watching Wi-Fi (${5 - this.window.failures()}/5 recent probes ok)`);
      else this.decide("Wi-Fi has no address");
      return;
    }
    await this.failover(settings);
  }

  /**
   * macOS with no address at all: the first HOTSPOT_JOIN_GRACE_MS belongs to macOS. Its Instant
   * Hotspot auto-join can wake the iPhone; a networksetup join cancels that auto-join and cannot
   * wake a hidden phone (2026-11-06). Says so, and returns true when the join is not ours yet.
   */
  private leaveJoinToOs(): boolean {
    if (this.deps.platform !== "darwin" || this.network !== "none") return false;
    if (this.now() - (this.noAddressSince ?? this.now()) >= HOTSPOT_JOIN_GRACE_MS) return false;
    this.state = "no-wifi";
    this.decide(`Wi-Fi is not connected; leaving the hotspot join to macOS for ${HOTSPOT_JOIN_GRACE_MS / 1000}s (its auto-join can wake the iPhone; a networksetup join cancels it)`);
    return true;
  }

  private async failover(settings: TetherSettings): Promise<void> {
    const why = this.network === "wifi" ? "Wi-Fi has no internet (3 of the last 5 probes failed)" : "Wi-Fi is not connected";
    if (!settings.hotspotSsid) {
      this.state = "no-hotspot-ssid";
      this.decide(`${why}, but no hotspot name is set`);
      return;
    }
    // macOS with no address at all: past the grace, one try a minute — here a failed join switched
    // nothing either, but the 10 s ladder is what kept cutting macOS's next auto-join short.
    const leaveToOs = this.deps.platform === "darwin" && this.network === "none";
    if (this.leaveJoinToOs()) return;
    const since = this.now() - this.lastSwitchAt;
    const retrying = !leaveToOs && this.joinFailures > 0 && RETRIABLE_JOIN.has(this.state);
    const gap = retrying ? Math.min(MIN_SWITCH_INTERVAL_MS, JOIN_RETRY_MS * this.joinFailures) : MIN_SWITCH_INTERVAL_MS;
    if (since < gap) {
      // A failed join keeps saying why (and its hint) until the next attempt.
      if (!JOIN_FAILURES.has(this.state)) this.state = "outage";
      this.decide(`${why}; waiting ${Math.ceil((gap - since) / 1000)}s (${retrying ? "trying the hotspot again" : "at most one switch per minute"})`);
      return;
    }
    // A call in flight on a dead network cannot finish anyway; give it a short chance, no more.
    const waitUntil = this.now() + FAILOVER_IDLE_WAIT_MS;
    while (this.deps.activity().inFlight > 0 && this.now() < waitUntil) await this.sleep(1_000);
    // Waiting that long gives the OS or the person time to join another network; joining the
    // hotspot now would evict it. The change is handled (reset, settle) and the next tick judges
    // the network that arrived. A lost address has nothing to evict: the hotspot join stays right.
    if (this.sampleNetwork(this.now()).changed && this.network !== "none") return;
    // …but a loss during that wait gives macOS its own grace from the moment it happened.
    if (this.leaveJoinToOs()) return;
    this.state = "joining-hotspot";
    this.lastSwitchAt = this.now();
    this.decide(`${why}: joining hotspot "${settings.hotspotSsid}"`);
    const outcome = await this.join(settings.hotspotSsid);
    this.recordSwitch("hotspot", outcome === "joined", outcome === "joined" ? why : outcome);
    this.joinFailures = outcome === "joined" ? 0 : this.joinFailures + 1;
    if (outcome === "joined" && !this.onHotspot(this.currentIp())) {
      // Joined, but on a network that could not be remembered (see learn()): it reads as Wi-Fi.
      this.window.reset();
      this.network = "wifi";
      this.state = "watching";
      this.decide("joined the hotspot, but its network cannot be told apart from Wi-Fi; watching it as Wi-Fi (no way back is planned)");
    } else if (outcome === "joined") {
      this.window.reset();
      this.network = "hotspot";
      this.state = "on-hotspot";
      this.landedOnHotspotAt = this.now();
      this.nextReturnAt = nextReturnPoint(this.landedOnHotspotAt, this.now());
      this.decide(`joined the hotspot; next try for Wi-Fi in ${Math.round((this.nextReturnAt - this.now()) / 1000)}s`);
    } else {
      this.state = outcome;
      this.decide(`could not join the hotspot: ${outcome}`);
    }
  }

  /**
   * Asks the OS to join, then waits for the hotspot's address: one in the iPhone range or the learned
   * network, or else — after a join the OS accepted — any new address that is not link-local, whose
   * network is then learned. Neither OS lets us read the SSID without Location (macOS redacts it;
   * Windows 24H2 gates `netsh wlan show interfaces`), so "the OS accepted a join of this SSID, and
   * the address changed" is the strongest evidence there is.
   */
  private async join(ssid: string): Promise<JoinOutcome> {
    const before = this.currentIp();
    const wifiBefore = [before && !this.onHotspot(before) ? this.currentNetwork() : null, this.lastWifiNetwork];
    const failed = await this.backend!.join(ssid);
    if (failed) return failed;
    const deadline = this.now() + JOIN_SETTLE_MS;
    for (;;) {
      const ip = this.currentIp();
      if (this.onHotspot(ip)) return "joined";
      if (ip && ip !== before && !isLinkLocal(ip)) {
        this.learn(ssid, ip, wifiBefore);
        return "joined";
      }
      if (this.now() >= deadline) return this.backend!.noAddressOutcome;
      await this.sleep(1_000);
    }
  }

  /**
   * Remembers the network our join of `ssid` landed on. Only a join we made replaces it, and never
   * with a network just watched as ordinary Wi-Fi: that one would read as the hotspot from then on.
   */
  private learn(ssid: string, ip: string, wifiBefore: (string | null)[]): void {
    const network = this.currentNetwork();
    if (!network) {
      this.step(`joined "${ssid}" at ${ip}, but its netmask could not be read; its network is not remembered`);
      return;
    }
    if (wifiBefore.includes(network)) {
      this.step(`joined "${ssid}", but its network ${network} is the one watched as Wi-Fi before; not remembering it (the two could not be told apart)`);
      return;
    }
    if (this.learned?.ssid === ssid && this.learned.network === network) return;
    const was = this.learned?.ssid === ssid ? ` (was ${this.learned.network})` : "";
    this.learned = { ssid, network, learnedAt: new Date(this.now()).toISOString() };
    this.step(`remembering ${network} as hotspot "${ssid}"'s network${was}`);
    if (!this.deps.stateFile) return;
    try {
      writeLearnedHotspot(this.deps.stateFile, this.learned);
    } catch (e) {
      this.deps.log.warn(`tether: could not save the hotspot's network: ${(e as Error).message}`);
    }
  }

  private async tryReturn(settings: TetherSettings): Promise<void> {
    if (this.now() - this.lastSwitchAt < MIN_SWITCH_INTERVAL_MS) return;
    // A return postponed for busy calls comes back every tick; one scan that saw a known Wi-Fi is
    // trusted for a minute rather than repeated each time (a scan takes seconds on the radio).
    if (this.now() - this.knownVisibleAt >= KNOWN_VISIBLE_TRUST_MS) {
      let blocked: string | null;
      try {
        blocked = await this.backend!.returnBlocked(settings.hotspotSsid);
      } catch (e) {
        blocked = `known Wi-Fi scan failed: ${e instanceof Error ? e.message : String(e)}`;
      }
      if (blocked) {
        this.backOff(blocked);
        return;
      }
      this.knownVisibleAt = this.now();
    }
    // A scan is asynchronous: a pin/stop/settings change or an OS join meanwhile cancels the return.
    const current = this.deps.settings();
    if (this.stopped || this.pinned || !current.enabled || current.hotspotSsid !== settings.hotspotSsid) return;
    // The scan above is an await: leaving now would disassociate a Wi-Fi the person or the OS
    // joined meanwhile (§8 "A change after an await wins"). The change is handled and settled, and
    // the next tick judges the new network.
    if (this.networkMovedBeforeLeave("while the return was being prepared")) return;
    const idle = this.idle();
    if (!idle && (this.now() - this.nextReturnAt < RETURN_FORCE_AFTER_MS || this.hold.closed)) {
      this.decide(`Wi-Fi return postponed: a model call is running or just started (after ${RETURN_FORCE_AFTER_MS / 1000}s of this, new calls are held to make a gap)`);
      return;
    }
    if (idle) await this.leaveHotspot(settings);
    else await this.returnWithGap(settings);
  }

  /**
   * Calls never stop (Claude and subagents back-to-back), so make the quiet moment: hold new model
   * calls, let the running ones finish, go back to Wi-Fi, release. The hold is released on every
   * path out of here, a thrown error included.
   */
  private async returnWithGap(settings: TetherSettings): Promise<void> {
    const late = Math.round((this.now() - this.nextReturnAt) / 1000);
    if (!this.hold.engage("going back to Wi-Fi", RETURN_HOLD_FAILSAFE_MS)) return;
    this.holding = true;
    // The earliest call held by this engagement goes ahead HOLD_MAX_MS from here; the return must
    // be done by then (leaveHotspot caps its loop against this).
    const gateEngagedAt = this.now();
    try {
      const running = this.deps.activity().inFlight;
      this.step(`Wi-Fi return postponed ${late}s past due while model calls keep running: holding new model calls to make a gap (waiting up to ${RETURN_DRAIN_WAIT_MS / 1000}s for ${running} running)`);
      const started = this.now();
      const until = started + RETURN_DRAIN_WAIT_MS;
      while (!this.stopped && !this.pinned && this.deps.activity().inFlight > 0 && this.now() < until) await this.sleep(1_000);
      // stop() already released; a pin made meanwhile pauses switching, so the attempt is dropped.
      if (this.stopped || this.pinned) return;
      const left = this.deps.activity().inFlight;
      if (left > 0) {
        this.backOff(`${left} model call${left === 1 ? "" : "s"} still running after ${Math.round((this.now() - started) / 1000)}s; held calls released`);
        return;
      }
      this.step(`running model calls finished after ${Math.round((this.now() - started) / 1000)}s; ${this.hold.waiting} held`);
      // The drain is an await too: a Wi-Fi joined during it must not be disassociated by the leave
      // that was decided before it arrived.
      if (this.networkMovedBeforeLeave("while the drain waited for running calls")) return;
      await this.leaveHotspot(settings, gateEngagedAt);
    } finally {
      this.releaseHold();
    }
  }

  private releaseHold(why?: string): void {
    if (!this.holding) return;
    this.holding = false;
    const n = this.hold.release();
    this.step(`hold released${why ? ` (${why})` : ""}; ${n} held model call${n === 1 ? "" : "s"} going ahead`);
  }

  /** A one-off step: always logged, and the next state line is logged again after it. */
  private step(line: string): void {
    this.lastLogged = "";
    this.deps.log.info(`tether: ${line}`);
  }

  /**
   * Leave the hotspot so the OS joins its best known network; keep it only if it has internet.
   * `gateEngagedAt` is set by returnWithGap: the earliest call held there goes ahead HOLD_MAX_MS
   * after it, so the loop must leave HOTSPOT_REJOIN_BUDGET_MS for putting the hotspot back first.
   */
  private async leaveHotspot(settings: TetherSettings, gateEngagedAt: number | null = null): Promise<void> {
    const backend = this.backend!;
    this.state = "returning";
    this.lastSwitchAt = this.now();
    this.decide(`trying to go back to Wi-Fi: leaving the hotspot so ${this.deps.platform === "win32" ? "Windows" : "macOS"} joins the best known network`);
    const left = await backend.leave();
    if (left !== null) {
      this.deps.log.warn(`tether: leaving the hotspot failed: ${left}`);
      this.state = "on-hotspot";
      this.backOff("leaving the hotspot failed");
      return;
    }
    // Back on Wi-Fi only after two good probes through it (one could be a lucky blip).
    let good = 0;
    let askedKnown = false;
    /** Set when the hotspot was joined back at 8s (macOS); its outcome decides the reason below. */
    let earlyRejoin: JoinOutcome | null = null;
    const started = this.now();
    // A Wi-Fi macOS joins can get its address seconds after we leave and still be initialising
    // (its own DHCP, EADDRNOTAVAIL probes): each non-hotspot network that appears in this loop gets
    // NETWORK_SETTLE_MS from the moment it was seen before it is called dead. A probe takes seconds
    // and the OS can join another network meanwhile, so the address AND subnet are read again after
    // every probe: a change wins, resets the good-probe count and settles the new network from then
    // (§8 "A change after an await wins"). The whole loop is bounded by RETURN_LOOP_CEILING_MS,
    // and with a held gap by the earliest held call too: that one goes ahead HOLD_MAX_MS after the
    // gate engaged, so this loop and every settle in it end HOTSPOT_REJOIN_BUDGET_MS before that,
    // measured from the engagement (a long drain and leave eat into the same budget). A probe that
    // could still be running at that bound is not started — the rejoin goes ahead instead.
    const limit = started + RETURN_LOOP_CEILING_MS;
    const gapCap = gateEngagedAt === null ? Infinity : gateEngagedAt + HOLD_MAX_MS - HOTSPOT_REJOIN_BUDGET_MS;
    const ceiling = Math.min(limit, gapCap);
    let deadline = started + RETURN_PROBE_MS;
    if (deadline > ceiling) {
      // Whatever the engagement left is what the loop gets; never a negative wait.
      const remaining = Math.max(0, ceiling - started);
      this.step(`the held-call budget leaves ${Math.round(remaining / 1000)}s for the return probe loop (the earliest held call goes ahead ${HOLD_MAX_MS / 1000}s after the hold engaged, and the hotspot needs up to ${HOTSPOT_REJOIN_BUDGET_MS / 1000}s of that); the base ${RETURN_PROBE_MS / 1000}s wait is cut to fit`);
      deadline = Math.max(started, ceiling);
    }
    /** The non-hotspot network (address + subnet) the loop has already admitted and settled. */
    let seenWifi: string | null = null;
    /** Reads the interface now; the key makes a subnet-only change a change too. */
    const sample = (): { ip: string | null; key: string } => {
      const ip = this.currentIp();
      return { ip, key: `${ip ?? "none"}/${this.currentNetwork() ?? "none"}` };
    };
    /** A non-hotspot network not seen yet in this loop gets its full settle and a fresh good count. */
    const admit = (s: { ip: string | null; key: string }): void => {
      // No address, or the hotspot again: the Wi-Fi seen before is not the one that will come
      // back, so a reappearance of the same address and subnet is a new network (§8) — without
      // this, Wi-Fi → none → the same Wi-Fi got no fresh settle and was called dead on the
      // deadline that belonged to the earlier appearance.
      if (s.ip === null || this.onHotspot(s.ip)) {
        seenWifi = null;
        return;
      }
      if (s.key === seenWifi) return;
      seenWifi = s.key;
      good = 0;
      deadline = Math.min(ceiling, Math.max(deadline, this.now() + NETWORK_SETTLE_MS));
    };
    /** Set when the loop stopped because a probe would not fit, not because the bound was reached. */
    let probeSkipped = false;
    while (this.now() < deadline && this.now() < ceiling) {
      // Never sleep past a bound: with a held gap the hotspot rejoin is budgeted from the ceiling,
      // so a last wait that ran past it would take that time from the hotspot.
      const remaining = Math.min(2_000, deadline - this.now(), ceiling - this.now());
      await this.sleep(Math.max(0, remaining));
      if (this.now() >= ceiling) break;
      const before = sample();
      admit(before);
      const ip = before.ip;
      if (!ip && !askedKnown && this.now() - started >= JOIN_KNOWN_AFTER_MS) {
        if (backend.rejoinHotspotIfUnassociated) {
          // An idle iPhone stops advertising (2026-11-06), so waiting out the rest of the 20s can
          // lose the only way back; go now, while it still advertises.
          askedKnown = true;
          this.step(`no network was joined ${Math.round((this.now() - started) / 1000)}s after leaving; rejoining the hotspot at once (an idle iPhone stops advertising)`);
          earlyRejoin = await this.join(settings.hotspotSsid);
          break;
        }
        if (backend.joinKnown) {
          askedKnown = true;
          await backend.joinKnown(settings.hotspotSsid);
        }
      }
      if (ip && !this.onHotspot(ip)) {
        // A probe cannot be recalled. One started so late that it would still be running when the
        // bound arrives would take the rejoin past that bound (a 4s probe past the 75s held-gap cap
        // puts the hotspot back after the earliest held call's 120s), so go straight to the rejoin.
        if (this.now() + PROBE_TIMEOUT_MS > ceiling) {
          probeSkipped = true;
          break;
        }
        const ok = await this.probe(ip);
        const after = sample();
        if (after.key !== before.key) {
          // The result belongs to the network this round began on; the one that arrived now is
          // judged from its own settle, not the deadline that was running before it appeared.
          admit(after);
          good = 0;
          continue;
        }
        if (!ok) good = 0;
        else if (++good >= 2) break;
      } else good = 0;
    }
    const ceilingHit = this.now() >= ceiling || probeSkipped;
    this.window.reset();
    if (good >= 2) {
      this.network = "wifi";
      this.state = "watching";
      this.landedOnHotspotAt = null;
      this.recordSwitch("wifi", true, "a known Wi-Fi with internet was in range");
      this.decide("back on Wi-Fi with internet");
      return;
    }
    if (ceilingHit) {
      this.step(gapCap <= limit
        ? `the return probe loop stopped at the held-call budget (${Math.round(Math.max(0, ceiling - started) / 1000)}s, so the hotspot is back by the time a held call goes ahead at ${HOLD_MAX_MS / 1000}s) with the Wi-Fi still unsettled; rejoining the hotspot`
        : `the return probe loop hit its ${RETURN_LOOP_CEILING_MS / 1000}s ceiling with the Wi-Fi still unsettled; rejoining the hotspot`);
    }
    const ip = this.currentIp();
    let reason: string;
    const osName = this.deps.platform === "win32" ? "Windows" : "macOS";
    let rejoined = false;
    if (earlyRejoin !== null) {
      rejoined = earlyRejoin === "joined";
      reason = `no network was joined ${JOIN_KNOWN_AFTER_MS / 1000}s after leaving; rejoined the hotspot at once${rejoined ? "" : `; that failed: ${earlyRejoin}`}`;
    } else if (this.onHotspot(ip)) reason = `${osName} rejoined the hotspot (no better network in range)`;
    else {
      reason = ip ? `the Wi-Fi ${osName} chose has no internet` : "no network was joined";
      const outcome = await this.join(settings.hotspotSsid);
      rejoined = outcome === "joined";
      if (!rejoined) reason += `; rejoining the hotspot failed: ${outcome}`;
    }
    this.network = classifyNetwork(this.currentIp(), this.learnedNetwork());
    this.recordSwitch("wifi", false, reason);
    if (this.network !== "hotspot" && rejoined) {
      // Rejoined, but on a network that could not be remembered (see learn()): it reads as Wi-Fi.
      this.state = "watching";
      this.landedOnHotspotAt = null;
      this.step(`${reason}; rejoined the hotspot, but its network cannot be told apart from Wi-Fi; watching it as Wi-Fi`);
      return;
    }
    this.state = this.network === "hotspot" ? "on-hotspot" : "join-failed";
    this.backOff(reason);
  }

  /**
   * Stay on the hotspot until the next scheduled point (never doubling; see RETURN_SCHEDULE_MINUTES).
   * A point already passed — a slow tick, a long gap attempt — is skipped for the next one at least
   * MIN_SWITCH_INTERVAL_MS out, so a failed try never lands on top of the one just made.
   */
  private backOff(reason: string): void {
    const landed = this.landedOnHotspotAt ?? this.now();
    this.nextReturnAt = nextReturnPoint(landed, this.now());
    this.lastLogged = "";
    this.decide(`staying on the hotspot: ${reason}; next try in ${Math.round((this.nextReturnAt - this.now()) / 1000)}s`);
  }

  private recordSwitch(to: "hotspot" | "wifi", ok: boolean, reason: string): void {
    this.lastSwitch = { at: new Date(this.now()).toISOString(), to, ok, reason };
  }
}
