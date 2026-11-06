import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type os from "node:os";
import {
  classifyJoin, classifyNetwork, DISASSOCIATE_JS, HOTSPOT_JOIN_GRACE_MS, NETWORK_SETTLE_MS, parseKnownWifiScan, parsePreferredNetworks, parseWifiDevice, PROBE_TIMEOUT_MS, ProbeWindow,
  probeRound, readLearnedHotspot, RETURN_DRAIN_WAIT_MS, RETURN_FORCE_AFTER_MS, RETURN_HOLD_FAILSAFE_MS, RETURN_LOOP_CEILING_MS, RETURN_MIN_RSSI_DBM, RETURN_PROBE_MS, SCAN_KNOWN_JS, inNetwork, ipv4Network, isHotspotAddress, isLinkLocal,
  httpGet, nextReturnPoint, TetherController, wifiIPv4, wifiIPv4Network, writeLearnedHotspot,
  type ProbeGet,
} from "../src/tether.ts";
import type { Activity, RunResult } from "../src/awake.ts";
import { HOLD_MAX_MS, HoldGate } from "../src/hold.ts";
import { ConfigStore, DEFAULTS, TETHER_DEFAULTS, tetherSettings, validate, type TetherSettings } from "../src/config.ts";

// `networksetup -listallhardwareports` measured on this project's Mac (2026-10-20), shortened.
const PORTS = `
Hardware Port: Ethernet Adapter (en3)
Device: en3
Ethernet Address: 76:96:15:5c:73:5c

Hardware Port: Thunderbolt Bridge
Device: bridge0
Ethernet Address: 36:1c:58:21:90:80

Hardware Port: Wi-Fi
Device: en0
Ethernet Address: c0:c7:db:32:f6:de

Hardware Port: Thunderbolt 1
Device: en1
Ethernet Address: 36:1c:58:21:90:80

VLAN Configurations
===================
`;

test("the Wi-Fi device is read from the hardware ports", () => {
  assert.equal(parseWifiDevice(PORTS), "en0");
  assert.equal(parseWifiDevice(PORTS.replace("Device: en0", "Device: en1").replace("Hardware Port: Thunderbolt 1\nDevice: en1", "Hardware Port: Thunderbolt 1\nDevice: en9")), "en1");
  assert.equal(parseWifiDevice("Hardware Port: Ethernet\nDevice: en0\n"), null);
});

test("hotspot subnet: 172.20.10.0/28 only", () => {
  for (const ip of ["172.20.10.2", "172.20.10.14", "172.20.10.15", "172.20.10.0"]) assert.equal(isHotspotAddress(ip), true, ip);
  for (const ip of ["172.20.10.16", "172.20.100.2", "192.168.219.51", "10.0.0.2"]) assert.equal(isHotspotAddress(ip), false, ip);
  assert.equal(isHotspotAddress(null), false);
  assert.equal(classifyNetwork(null), "none");
  assert.equal(classifyNetwork("172.20.10.3"), "hotspot");
  assert.equal(classifyNetwork("192.168.1.4"), "wifi");
});

const iface = (address: string, family: "IPv4" | "IPv6" = "IPv4", netmask = family === "IPv4" ? "255.255.255.0" : "ffff:ffff:ffff:ffff::"): os.NetworkInterfaceInfo =>
  ({ address, family, internal: false, netmask, mac: "", cidr: null, ...(family === "IPv6" ? { scopeid: 0 } : {}) }) as os.NetworkInterfaceInfo;

test("the Wi-Fi IPv4 ignores IPv6 and other interfaces", () => {
  assert.equal(wifiIPv4({ en0: [iface("fe80::1", "IPv6"), iface("192.168.1.4")], en3: [iface("10.0.0.2")] }, "en0"), "192.168.1.4");
  assert.equal(wifiIPv4({ en0: [iface("fe80::1", "IPv6")] }, "en0"), null);
  assert.equal(wifiIPv4({}, "en0"), null);
});

test("probe window: blips are ignored, 3 failures of the last 5 is an outage", () => {
  const w = new ProbeWindow();
  for (const ok of [false, true, true, false, true]) w.push(ok);
  assert.equal(w.outage(), false);
  w.push(false); // window: T T F T F → 2 failures
  assert.equal(w.outage(), false);
  w.push(false); // T F T F F → 3
  assert.equal(w.outage(), true);
  w.reset();
  assert.equal(w.outage(), false);
});

test("a probe round needs either endpoint's exact answer, bound to the given address", async () => {
  const seen: string[] = [];
  const get = (apple: { status: number; body: string } | Error, google: { status: number; body: string } | Error): ProbeGet => async (url, local, timeout) => {
    seen.push(`${local} ${timeout}`);
    const r = url.includes("apple") ? apple : google;
    if (r instanceof Error) throw r;
    return r;
  };
  const down = new Error("ETIMEDOUT");
  assert.equal(await probeRound("192.168.1.4", get({ status: 200, body: "<HTML>Success</HTML>" }, down)), true);
  assert.equal(await probeRound("192.168.1.4", get(down, { status: 204, body: "" })), true);
  assert.equal(await probeRound("192.168.1.4", get(down, down)), false);
  // A captive portal answers 200 with its own page, and rewrites the 204 into one.
  assert.equal(await probeRound("192.168.1.4", get({ status: 200, body: "<html>Log in</html>" }, { status: 200, body: "login" })), false);
  assert.ok(seen.every((s) => s === "192.168.1.4 4000"));
});

test("networksetup's join output decides the outcome, whatever its exit code", () => {
  assert.equal(classifyJoin({ code: 0, stdout: "", stderr: "" }), null);
  assert.equal(classifyJoin({ code: 0, stdout: "Could not find network PBJ.\n", stderr: "" }), "hotspot-not-visible");
  assert.equal(classifyJoin({ code: 0, stdout: "Failed to join network PBJ.\nError: -3900  The operation couldn’t be completed.\n", stderr: "" }), "join-failed");
  assert.equal(classifyJoin({ code: 1, stdout: "", stderr: "sudo: a password is required\n" }), "needs-setup");
  assert.equal(classifyJoin({ code: 1, stdout: "", stderr: "Sorry, user pbj is not allowed to execute '/usr/sbin/networksetup -setairportnetwork en0 Other' as root\n" }), "needs-setup");
});

test("the disassociate call is wifihop's exact JXA", () => {
  assert.equal(DISASSOCIATE_JS, 'ObjC.import("CoreWLAN"); $.CWWiFiClient.sharedWiFiClient.interface.disassociate; "ok";');
});

test("the visibility scan asks the radio once and reports RSSI; a threshold below -70 dBm is not evidence", () => {
  // The measured shape (2026-11-06): one full scan starts the radio scan, directed hits carry RSSI.
  assert.match(SCAN_KNOWN_JS, /scanForNetworksWithNameError\(\$\(\), error\)/);
  assert.match(SCAN_KNOWN_JS, /rssiValue/);
  assert.equal(RETURN_MIN_RSSI_DBM, -70);
  assert.deepEqual(parseKnownWifiScan(JSON.stringify({ freshMs: 9_500, nets: [{ ssid: "Home", rssi: -40 }, { ssid: null, rssi: -82 }], found: [{ name: "Home", rssi: -40 }] })), {
    freshMs: 9_500,
    nets: [{ ssid: "Home", rssi: -40 }, { ssid: null, rssi: -82 }],
    found: [{ name: "Home", rssi: -40 }],
  });
  assert.equal(parseKnownWifiScan("visible\n"), null, "the old text answer is not a scan result");
  assert.equal(parseKnownWifiScan(JSON.stringify({ freshMs: "9", nets: [], found: [] })), null);
  assert.equal(parseKnownWifiScan(JSON.stringify({ freshMs: 1, nets: [{ ssid: "Home" }], found: [] })), null);
});

test("a config that still carries tether.returnEverySec loads without error and the key is ignored", () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "cr-tether-cfg-"));
  try {
    const file = path.join(dir, "config.json");
    fs.writeFileSync(file, JSON.stringify({ tether: { enabled: true, hotspotSsid: "PBJ", probeEverySec: 10, returnEverySec: 180 } }));
    let errors: string[] = ["not called"];
    const cfg = new ConfigStore(file, (_c, e) => { errors = e; }).get();
    assert.deepEqual(errors, [], "an extra key is not refused");
    assert.equal(cfg.tether?.enabled, true);
    const s = tetherSettings(cfg);
    assert.deepEqual(s, { enabled: true, hotspotSsid: "PBJ", probeEverySec: 10 });
    assert.equal("returnEverySec" in s, false, "the key is dropped, not carried");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- Controller with a fake Mac and a fake network ----------------------------------------------

type Net = { ip: string | null; netmask: string; probeOk: (ip: string) => boolean; joinOutput: RunResult; joinLandsOn: string | null; disassociateLandsOn: string | null; preferred: RunResult; scan: RunResult | Error };

/** A scan answer the Mac backend trusts: a real radio scan (seconds) that saw `Home` at -40 dBm. */
const FRESH_HOME = { code: 0, stdout: JSON.stringify({ freshMs: 9_500, nets: [{ ssid: "Home", rssi: -40 }], found: [{ name: "Home", rssi: -40 }] }), stderr: "" };
/** A scan answer from airportd's cache (measured 2026-11-06: ~25ms); not evidence by itself. */
const CACHED_HOME = { code: 0, stdout: JSON.stringify({ freshMs: 25, nets: [{ ssid: "Home", rssi: -40 }], found: [] }), stderr: "" };

function rig(o: { settings?: Partial<TetherSettings>; net?: Partial<Net>; activity?: () => Activity; platform?: NodeJS.Platform; hold?: HoldGate; onLeave?: () => void; onJoin?: () => void; onScan?: () => void; onSleep?: () => void; stateFile?: string } = {}) {
  const clock = { t: 1_000_000 };
  const calls: string[] = [];
  const lines: string[] = [];
  const net: Net = {
    ip: "192.168.1.4",
    netmask: "255.255.255.0",
    probeOk: () => true,
    joinOutput: { code: 0, stdout: "", stderr: "" },
    joinLandsOn: "172.20.10.2",
    disassociateLandsOn: "172.20.10.2",
    preferred: { code: 0, stdout: "Preferred networks on en0:\n\tPBJ\n\tHome\n", stderr: "" },
    scan: FRESH_HOME,
    ...o.net,
  };
  let settings: TetherSettings = { ...TETHER_DEFAULTS, enabled: true, hotspotSsid: "PBJ", ...o.settings };
  const run = async (file: string, args: string[]): Promise<RunResult> => {
    const line = [file, ...args].join(" ");
    calls.push(line);
    if (line === "/usr/sbin/networksetup -listallhardwareports") return { code: 0, stdout: PORTS, stderr: "" };
    if (line.startsWith("/usr/bin/sudo -n /usr/sbin/networksetup -setairportnetwork en0 ")) {
      o.onJoin?.();
      if (!classifyJoin(net.joinOutput)) net.ip = net.joinLandsOn;
      return net.joinOutput;
    }
    if (args[0] === "-listpreferredwirelessnetworks") return net.preferred;
    if (file === "/usr/bin/osascript" && args[3] === SCAN_KNOWN_JS) {
      assert.equal(args[4], "en0");
      const names: string[] = JSON.parse(args[5]!);
      assert.ok(!names.includes(settings.hotspotSsid), "the hotspot cannot make the scan positive");
      o.onScan?.();
      if (net.scan instanceof Error) throw net.scan;
      return net.scan;
    }
    if (file === "/usr/bin/osascript" && args[3] === DISASSOCIATE_JS) {
      o.onLeave?.();
      net.ip = net.disassociateLandsOn;
      return { code: 0, stdout: "ok\n", stderr: "" };
    }
    throw new Error(`unexpected command: ${line}`);
  };
  const c = new TetherController({
    platform: o.platform ?? "darwin",
    run,
    settings: () => settings,
    activity: o.activity ?? (() => ({ inFlight: 0 })),
    log: { info: (m) => lines.push(m), warn: (m) => lines.push(`WARN ${m}`) },
    now: () => clock.t,
    sleep: async (ms) => { clock.t += ms; o.onSleep?.(); },
    interfaces: () => (net.ip ? { en0: [iface(net.ip, "IPv4", net.netmask)] } : {}),
    probe: async (ip) => net.probeOk(ip),
    schedule: () => () => {},
    ...(o.hold ? { hold: o.hold } : {}),
    ...(o.stateFile ? { stateFile: o.stateFile } : {}),
  });
  /** One tick every probeEverySec, like the real loop. */
  const ticks = async (n: number): Promise<void> => {
    for (let i = 0; i < n; i++) {
      await c.tick();
      clock.t += settings.probeEverySec * 1000;
    }
  };
  const joins = () => calls.filter((l) => l.includes("-setairportnetwork")).length;
  const returns = () => calls.filter((l) => l === `/usr/bin/osascript -l JavaScript -e ${DISASSOCIATE_JS}`).length;
  return { c, clock, calls, lines, net, ticks, joins, returns, set: (s: Partial<TetherSettings>) => (settings = { ...settings, ...s }) };
}

test("on Linux, or disabled: no command and no probe", async () => {
  const a = rig({ platform: "linux" });
  a.c.start();
  await a.ticks(5);
  assert.deepEqual(a.calls, []);
  assert.equal(a.c.status().state, "unsupported");
  const b = rig({ settings: { enabled: false } });
  await b.ticks(5);
  assert.deepEqual(b.calls, []);
  assert.equal(b.c.status().state, "off");
});

test("blips never switch: two failures in any five rounds", async () => {
  const pattern = [false, true, true, false, true, true, false, true, true, false, true, true];
  let i = 0;
  const r = rig({ net: { probeOk: () => pattern[i++ % pattern.length]! } });
  await r.ticks(pattern.length);
  assert.equal(r.joins(), 0);
  assert.equal(r.c.status().state, "watching");
});

test("Wi-Fi up without internet: the third failure joins the hotspot by name through sudo -n", async () => {
  const r = rig({ net: { probeOk: (ip) => isHotspotAddress(ip) } });
  await r.ticks(2);
  assert.equal(r.joins(), 0);
  await r.ticks(1);
  assert.equal(r.joins(), 1);
  assert.ok(r.calls.includes("/usr/bin/sudo -n /usr/sbin/networksetup -setairportnetwork en0 PBJ"));
  const s = r.c.status();
  assert.equal(s.state, "on-hotspot");
  assert.equal(s.network, "hotspot");
  assert.equal(s.lastSwitch?.to, "hotspot");
  assert.equal(s.lastSwitch?.ok, true);
  assert.ok(r.lines.some((l) => /no internet .*joining hotspot "PBJ"/.test(l)), "the decision is logged with its reason");
});

test("a hotspot that is not broadcasting says so, with the hint, and retries 10 s, then 20 s later", async () => {
  const r = rig({ net: { probeOk: () => false, joinOutput: { code: 0, stdout: "Could not find network PBJ.\n", stderr: "" } } });
  await r.ticks(3);
  assert.equal(r.joins(), 1);
  let s = r.c.status();
  assert.equal(s.state, "hotspot-not-visible");
  assert.match(s.hint ?? "", /On an iPhone, open Settings → Personal Hotspot/);
  assert.match(s.hint ?? "", /On Android, turn Wi-Fi hotspot on/);
  assert.doesNotMatch(s.hint ?? "", /^The iPhone/, "the phone is not assumed to be an iPhone");
  await r.ticks(1); // 10 s after the first failure
  assert.equal(r.joins(), 2);
  await r.ticks(1); // the second failure waits 20 s
  assert.equal(r.joins(), 2);
  s = r.c.status();
  assert.equal(s.state, "hotspot-not-visible", "the reason and hint stay until the next attempt");
  await r.ticks(1);
  assert.equal(r.joins(), 3);
});

test("sudo refusing the join reads as needs-setup", async () => {
  const r = rig({ net: { probeOk: () => false, joinOutput: { code: 1, stdout: "", stderr: "sudo: a password is required\n" } } });
  await r.ticks(3);
  assert.equal(r.c.status().state, "needs-setup");
  assert.match(r.c.status().hint ?? "", /awake setup --ssid/);
});

test("no hotspot name: an outage is reported, nothing is run", async () => {
  const r = rig({ settings: { hotspotSsid: "" }, net: { probeOk: () => false } });
  await r.ticks(4);
  assert.equal(r.joins(), 0);
  assert.equal(r.c.status().state, "no-hotspot-ssid");
});

test("failover waits for a running call, but at most 30s", async () => {
  const r = rig({ net: { probeOk: (ip) => isHotspotAddress(ip) }, activity: () => ({ inFlight: 1, lastStartedAt: 0 }) });
  await r.ticks(2);
  const before = r.clock.t;
  await r.c.tick();
  assert.equal(r.joins(), 1);
  assert.ok(r.clock.t - before >= 30_000 && r.clock.t - before < 32_000, `waited ${r.clock.t - before}ms`);
});

test("the schedule is 5, 10, 20, 30, 40, 50 and 60 minutes after landing, then every 10", () => {
  const landed = 1_000_000;
  const at = (minutes: number) => landed + minutes * 60_000;
  const gap = 60_000;
  assert.equal(nextReturnPoint(landed, landed, gap), at(5));
  assert.equal(nextReturnPoint(landed, at(5), gap), at(10));
  assert.equal(nextReturnPoint(landed, at(10), gap), at(20));
  assert.equal(nextReturnPoint(landed, at(20), gap), at(30));
  assert.equal(nextReturnPoint(landed, at(30), gap), at(40));
  assert.equal(nextReturnPoint(landed, at(50), gap), at(60));
  assert.equal(nextReturnPoint(landed, at(60), gap), at(70));
  assert.equal(nextReturnPoint(landed, at(70), gap), at(80));
  assert.equal(nextReturnPoint(landed, at(600), gap), at(610));
  // A point at or past `now` is skipped: the next one, at least MIN_SWITCH_INTERVAL_MS out.
  assert.equal(nextReturnPoint(landed, at(5) + 1, 0), at(10));
  assert.equal(nextReturnPoint(landed, at(9) + 59_000, 60_000), at(20), "a 60s floor pushes past the 10 min point");
});

test("the way back: 5 minutes after landing, idle, disassociate and keep the Wi-Fi macOS joins if it works", async () => {
  const r = rig({ net: { ip: "172.20.10.2", disassociateLandsOn: "192.168.1.4" } });
  await r.ticks(1);
  assert.equal(r.c.status().state, "on-hotspot");
  await r.ticks(29); // 290s: not yet
  assert.equal(r.returns(), 0);
  await r.ticks(1);
  assert.equal(r.returns(), 1);
  assert.ok(r.calls.includes(`/usr/bin/osascript -l JavaScript -e ${DISASSOCIATE_JS}`));
  const s = r.c.status();
  assert.equal(s.network, "wifi");
  assert.equal(s.state, "watching");
  assert.equal(s.lastSwitch?.to, "wifi");
  assert.equal(s.lastSwitch?.ok, true);
  assert.equal(r.joins(), 0);
});

for (const cancel of ["pin", "stop", "disable", "rename", "OS joined Wi-Fi", "new model call"] as const) {
  test(`a scan that completes after ${cancel} cannot leave the hotspot`, async () => {
    let activity: Activity = { inFlight: 0 };
    const r = rig({
      net: { ip: "172.20.10.2" },
      activity: () => activity,
      onScan: () => {
        if (cancel === "pin") r.c.setPin(true);
        if (cancel === "stop") r.c.stop();
        if (cancel === "disable") r.set({ enabled: false });
        if (cancel === "rename") r.set({ hotspotSsid: "Other phone" });
        if (cancel === "OS joined Wi-Fi") r.net.ip = "192.168.1.4";
        if (cancel === "new model call") activity = { inFlight: 1, lastStartedAt: r.clock.t };
      },
    });
    await r.ticks(31);
    assert.equal(r.returns(), 0);
    assert.equal(r.joins(), 0);
    assert.ok(!r.lines.some((line) => /holding new model calls/.test(line)));
  });
}

test("preferred SSIDs preserve spaces and Unicode, with only the list indent removed", () => {
  assert.deepEqual(parsePreferredNetworks("Preferred networks on en0:\r\n\tPBJ\r\n\t맘보 2층\r\n\t Home \r\n\tPBJ\r\n"), ["PBJ", "맘보 2층", " Home "]);
  assert.deepEqual(parsePreferredNetworks("There are no preferred wireless networks on en0.\n"), []);
});

for (const busy of [false, true]) {
  const cases: { name: string; net: Partial<Net>; reason: RegExp }[] = [
    { name: "none visible", net: { scan: { code: 0, stdout: JSON.stringify({ freshMs: 9_500, nets: [], found: [] }), stderr: "" } }, reason: /no known Wi-Fi in range/ },
    { name: "only a weak known Wi-Fi", net: { scan: { code: 0, stdout: JSON.stringify({ freshMs: 9_500, nets: [], found: [{ name: "Home", rssi: -82 }] }), stderr: "" } }, reason: /too weak \(Home -82 dBm, needs -70\)/ },
    { name: "scan nonzero", net: { scan: { code: 1, stdout: "", stderr: "Location denied" } }, reason: /scan failed.*Location denied/ },
    { name: "scan crash", net: { scan: { code: 139, stdout: "", stderr: "" } }, reason: /scan failed.*exit 139/ },
    { name: "runner error", net: { scan: new Error("scan timed out") }, reason: /scan failed.*scan timed out/ },
    { name: "unsupported output", net: { scan: { code: 0, stdout: "unknown", stderr: "" } }, reason: /scan failed.*unsupported/ },
    { name: "preferred list error", net: { preferred: { code: 1, stdout: "", stderr: "cannot read preferences" } }, reason: /scan failed.*cannot read preferences/ },
    { name: "hotspot only", net: { preferred: { code: 0, stdout: "Preferred networks on en0:\n\tPBJ\n", stderr: "" } }, reason: /no known Wi-Fi in range/ },
    { name: "no saved networks", net: { preferred: { code: 0, stdout: "There are no preferred wireless networks on en0.\n", stderr: "" } }, reason: /no known Wi-Fi in range/ },
  ];
  for (const scenario of cases) test(`${busy ? "gap" : "quiet"} return stays without leaving or holding: ${scenario.name}`, async () => {
    const hold = new HoldGate();
    const r = rig({ net: { ip: "172.20.10.2", ...scenario.net }, hold, activity: () => ({ inFlight: busy ? 1 : 0 }) });
    await r.ticks(busy ? 43 : 31);
    const stays = () => r.lines.filter((line) => line.startsWith("tether: staying on the hotspot:"));
    assert.equal(r.returns(), 0);
    assert.equal(r.joins(), 0);
    assert.equal(hold.engaged, false);
    assert.ok(!r.lines.some((line) => /holding new model calls|hold released/.test(line)), "the gate was never engaged");
    assert.equal(r.c.status().lastSwitch, null);
    assert.equal(r.c.status().network, "hotspot");
    assert.equal(stays().length, 1);
    assert.match(stays()[0]!, scenario.reason);
    // Stay logs once per point, not per probe. Next point is still 10 min from landing.
    r.clock.t = 1_000_000 + 599_000;
    await r.c.tick();
    assert.equal(stays().length, 1);
    r.clock.t = 1_000_000 + 600_000 + (busy ? RETURN_FORCE_AFTER_MS : 0);
    await r.c.tick();
    assert.equal(stays().length, 2);
    assert.equal(r.returns(), 0);
    assert.equal(r.joins(), 0);
    assert.ok(!r.lines.some((line) => /holding new model calls|hold released/.test(line)));
  });
}

test("the way back waits while a model call runs or one started in the last 20s", async () => {
  let activity: Activity = { inFlight: 1 };
  const r = rig({ net: { ip: "172.20.10.2", disassociateLandsOn: "192.168.1.4" }, activity: () => activity });
  await r.ticks(31); // 300s: due, but a call is running
  assert.equal(r.returns(), 0);
  activity = { inFlight: 0, lastStartedAt: r.clock.t - 5_000 };
  await r.ticks(1);
  assert.equal(r.returns(), 0);
  activity = { inFlight: 0, lastStartedAt: r.clock.t - 25_000 };
  await r.ticks(1);
  assert.equal(r.returns(), 1);
});

test("no better network: stay on the hotspot and try at the fixed points 5, 10, 20, 30, 40, 50 and 60 min, then every 10", async () => {
  const r = rig({ net: { ip: "172.20.10.2", disassociateLandsOn: "172.20.10.2" } });
  await r.ticks(1);
  const attempted = () => r.returns();
  const attemptsAt: number[] = [];
  for (let i = 0; i < 1000 && attemptsAt.length < 9; i++) {
    const n = r.returns();
    await r.ticks(1);
    if (r.returns() > n) attemptsAt.push(r.clock.t);
  }
  assert.equal(attemptsAt.length, 9, `attempts ${attemptsAt.length}, returns ${attempted()}`);
  const landed = 1_000_000;
  // Each attempt lands on a tick at the scheduled point (or up to one tick after), plus the ~20s
  // spent probing and the 10s tick step before the clock is read again.
  const points = [5, 10, 20, 30, 40, 50, 60, 70, 80].map((m) => m * 60_000);
  attemptsAt.forEach((t, i) => {
    const late = t - landed - points[i]!;
    assert.ok(late >= 0 && late < 31_000, `attempt ${i + 1} at +${(t - landed) / 1000}s, expected +${points[i]! / 1000}s (+0..30s)`);
  });
  assert.equal(r.joins(), 0, "macOS put us back on the hotspot itself");
  assert.equal(r.c.status().state, "on-hotspot");
});

test("a failed try does not double: each failure moves to the next scheduled point", async () => {
  const r = rig({ net: { ip: "172.20.10.2", disassociateLandsOn: "172.20.10.2" } });
  await r.ticks(1);
  // 5 min point: attempt fails, next is the 10 min point (300s away), not 600s.
  await r.ticks(30);
  assert.equal(r.returns(), 1);
  assert.ok(r.lines.some((l) => /staying on the hotspot: .*; next try in 2[0-9][0-9]s/.test(l)), r.lines.join("\n"));
});

test("leaving the hotspot for Wi-Fi resets the schedule: landing again starts at 5 min", async () => {
  const r = rig({ net: { ip: "172.20.10.2", disassociateLandsOn: "192.168.1.4" } });
  await r.ticks(31); // first return at the 5 min point
  assert.equal(r.returns(), 1);
  assert.equal(r.c.status().network, "wifi");
  // By hand (or another failover) back on the hotspot: the 5 min wait starts over.
  await r.ticks(60); // 10 more minutes on Wi-Fi
  assert.equal(r.returns(), 1);
  r.net.ip = "172.20.10.2";
  r.net.disassociateLandsOn = "192.168.1.4";
  await r.ticks(29);
  assert.equal(r.returns(), 1, "not yet: the schedule was reset by the landing");
  await r.ticks(2);
  assert.equal(r.returns(), 2);
});

test("the Wi-Fi macOS picks has no internet: rejoin the hotspot", async () => {
  const r = rig({ net: { ip: "172.20.10.2", disassociateLandsOn: "192.168.50.7", probeOk: (ip) => isHotspotAddress(ip) } });
  await r.ticks(31);
  assert.equal(r.returns(), 1);
  assert.equal(r.joins(), 1);
  assert.equal(r.c.status().network, "hotspot");
  assert.equal(r.c.status().lastSwitch?.ok, false);
  assert.match(r.c.status().lastSwitch?.reason ?? "", /no internet/);
});

test("never more than one switch per minute: a fresh return is not followed by an instant failover", async () => {
  let wifiDead = false;
  const r = rig({ net: { ip: "172.20.10.2", disassociateLandsOn: "192.168.1.4", probeOk: (ip) => isHotspotAddress(ip) || !wifiDead } });
  await r.ticks(31);
  assert.equal(r.returns(), 1);
  const back = r.clock.t;
  wifiDead = true;
  await r.ticks(3);
  assert.equal(r.joins(), 0, `still within a minute of the return (${(r.clock.t - back) / 1000}s)`);
  await r.ticks(4);
  assert.equal(r.joins(), 1);
});

test("a pinned network is never switched", async () => {
  const r = rig({ net: { probeOk: () => false } });
  r.c.setPin(true);
  await r.ticks(10);
  assert.equal(r.joins(), 0);
  assert.equal(r.c.status().state, "pinned");
  r.c.setPin(false);
  await r.ticks(3);
  assert.equal(r.joins(), 1);
});

// ---- A phone that is not an iPhone: the hotspot's network is learned from our own join (2026-10-20) ----

test("IPv4 networks: address + netmask, membership, link-local, and the learned network in the classification", () => {
  assert.equal(ipv4Network("192.168.43.17", "255.255.255.0"), "192.168.43.0/24");
  assert.equal(ipv4Network("10.42.17.5", "255.255.255.0"), "10.42.17.0/24");
  assert.equal(ipv4Network("172.20.10.2", "255.255.255.240"), "172.20.10.0/28");
  assert.equal(ipv4Network("192.168.43.17", ""), null);
  assert.equal(ipv4Network("192.168.43.17", "255.0.255.0"), null, "a non-contiguous mask is refused");
  assert.equal(ipv4Network("192.168.43.17", "255.255.255.255"), null);
  assert.equal(inNetwork("192.168.43.200", "192.168.43.0/24"), true);
  assert.equal(inNetwork("192.168.44.2", "192.168.43.0/24"), false);
  assert.equal(inNetwork(null, "192.168.43.0/24"), false);
  assert.equal(inNetwork("192.168.43.2", null), false);
  assert.equal(isLinkLocal("169.254.12.3"), true);
  assert.equal(isLinkLocal("192.168.43.2"), false);
  assert.equal(classifyNetwork("192.168.43.9", "192.168.43.0/24"), "hotspot");
  assert.equal(classifyNetwork("192.168.1.4", "192.168.43.0/24"), "wifi");
  assert.equal(classifyNetwork("172.20.10.3", null), "hotspot", "the iPhone range needs no memory");
  assert.equal(wifiIPv4Network({ en0: [iface("fe80::1", "IPv6"), iface("192.168.43.17")] }, "en0"), "192.168.43.0/24");
});

test("tether.json: what was written is read back; anything else is forgotten", () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "cr-tether-mem-"));
  try {
    const file = path.join(dir, "tether.json");
    assert.equal(readLearnedHotspot(file), null);
    writeLearnedHotspot(file, { ssid: "Pixel", network: "192.168.43.0/24", learnedAt: "2026-10-20T10:00:00.000Z" });
    assert.deepEqual(readLearnedHotspot(file), { ssid: "Pixel", network: "192.168.43.0/24", learnedAt: "2026-10-20T10:00:00.000Z" });
    for (const bad of ["{", "{}", JSON.stringify({ hotspot: { ssid: "Pixel", network: "192.168.43.7/24" } }), JSON.stringify({ hotspot: { ssid: "Pixel", network: "0.0.0.0/0" } })]) {
      fs.writeFileSync(file, bad);
      assert.equal(readLearnedHotspot(file), null, bad);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A rig whose hotspot is an Android phone: our join lands in `androidIp`, whose network has internet. */
function androidRig(stateFile: string, o: { home?: string; androidIp?: string; settings?: Partial<TetherSettings>; net?: Partial<Net> } = {}) {
  const android = o.androidIp ?? "192.168.43.17";
  const androidNet = ipv4Network(android, "255.255.255.0")!;
  return rig({
    stateFile,
    settings: { hotspotSsid: "Pixel", ...o.settings },
    net: { ip: o.home ?? "192.168.1.4", joinLandsOn: android, probeOk: (ip) => inNetwork(ip, androidNet), ...o.net },
  });
}

function withDir(fn: (file: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), "cr-tether-android-"));
    try {
      await fn(path.join(dir, "tether.json"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

test("Android hotspot: after our join its network is remembered, it reads as the hotspot, and the way back is planned", withDir(async (file) => {
  const r = androidRig(file, { net: { disassociateLandsOn: "192.168.43.17" } });
  await r.ticks(3);
  assert.equal(r.joins(), 1);
  let s = r.c.status();
  assert.equal(s.state, "on-hotspot");
  assert.equal(s.network, "hotspot");
  assert.equal(s.lastSwitch?.ok, true);
  assert.ok(r.lines.includes('tether: remembering 192.168.43.0/24 as hotspot "Pixel"\'s network'), r.lines.join("\n"));
  assert.equal(readLearnedHotspot(file)?.network, "192.168.43.0/24");
  await r.ticks(5);
  s = r.c.status();
  assert.equal(s.state, "on-hotspot", "not mistaken for Wi-Fi on the next ticks");
  await r.ticks(30); // the 5 min point
  assert.equal(r.returns(), 1, "the way back is tried");
  assert.match(r.c.status().lastSwitch?.reason ?? "", /macOS rejoined the hotspot/);
}));

test("Android hotspot: the memory survives a new controller, a by-hand join is recognised, home Wi-Fi is not misread", withDir(async (file) => {
  const first = androidRig(file);
  await first.ticks(3);
  assert.equal(first.c.status().network, "hotspot");
  // A restarted router, already on the phone's hotspot (joined by hand, another address in it).
  const second = androidRig(file, { home: "192.168.43.30" });
  await second.ticks(1);
  assert.equal(second.c.status().network, "hotspot");
  assert.equal(second.c.status().state, "on-hotspot");
  assert.equal(second.joins(), 0);
  // Home Wi-Fi on another subnet stays Wi-Fi under the same memory.
  const third = androidRig(file, { net: { probeOk: () => true } });
  await third.ticks(10);
  assert.equal(third.c.status().network, "wifi");
  assert.equal(third.c.status().state, "watching");
  // The way back lands on home Wi-Fi; then a by-hand join to the phone is recognised by the same controller.
  const fourth = androidRig(file, { home: "192.168.43.30", net: { disassociateLandsOn: "192.168.1.4", probeOk: () => true } });
  await fourth.ticks(31);
  assert.equal(fourth.c.status().network, "wifi");
  assert.equal(fourth.c.status().lastSwitch?.ok, true);
  fourth.net.ip = "192.168.43.31";
  await fourth.ticks(1);
  assert.equal(fourth.c.status().network, "hotspot");
  assert.equal(fourth.c.status().state, "on-hotspot");
}));

test("Android hotspot: a join that lands on the subnet watched as Wi-Fi is not remembered (ambiguous), and says so", withDir(async (file) => {
  const r = androidRig(file, { home: "192.168.43.4", androidIp: "192.168.43.17", net: { probeOk: (ip) => ip !== "192.168.43.4" } });
  await r.ticks(3);
  assert.equal(r.joins(), 1);
  assert.ok(r.lines.some((l) => /joined "Pixel", but its network 192\.168\.43\.0\/24 is the one watched as Wi-Fi before; not remembering it/.test(l)), r.lines.join("\n"));
  assert.equal(fs.existsSync(file), false, "nothing written");
  const s = r.c.status();
  assert.equal(s.network, "wifi");
  assert.equal(s.state, "watching");
  await r.ticks(40);
  assert.equal(r.returns(), 0, "no way back is planned from a network that reads as Wi-Fi");
}));

test("Android hotspot: a new subnet after a later join replaces the memory; only our join of the hotspot does", withDir(async (file) => {
  writeLearnedHotspot(file, { ssid: "Pixel", network: "192.168.43.0/24", learnedAt: "2026-10-19T00:00:00.000Z" });
  const r = androidRig(file, { androidIp: "192.168.77.5" });
  await r.ticks(3);
  assert.equal(r.c.status().state, "on-hotspot");
  assert.ok(r.lines.includes('tether: remembering 192.168.77.0/24 as hotspot "Pixel"\'s network (was 192.168.43.0/24)'), r.lines.join("\n"));
  assert.equal(readLearnedHotspot(file)?.network, "192.168.77.0/24");
}));

test("a learned network belongs to its hotspot name: another configured name ignores it", withDir(async (file) => {
  writeLearnedHotspot(file, { ssid: "Old Phone", network: "192.168.43.0/24", learnedAt: "2026-10-19T00:00:00.000Z" });
  const r = androidRig(file, { home: "192.168.43.30", net: { probeOk: () => true } });
  await r.ticks(3);
  assert.equal(r.c.status().network, "wifi");
}));

test("iPhone range: recognised with no memory, and nothing is written", withDir(async (file) => {
  const r = rig({ stateFile: file, net: { probeOk: (ip) => isHotspotAddress(ip) } });
  await r.ticks(3);
  assert.equal(r.c.status().state, "on-hotspot");
  assert.equal(fs.existsSync(file), false);
  const byHand = rig({ stateFile: file, net: { ip: "172.20.10.4" } });
  await byHand.ticks(1);
  assert.equal(byHand.c.status().state, "on-hotspot");
}));

test("after a join, a self-assigned (169.254) address or an unchanged one is no join; an unreadable netmask is not remembered", withDir(async (file) => {
  const ll = androidRig(file, { androidIp: "169.254.3.4", net: { probeOk: () => false } });
  await ll.ticks(3);
  assert.equal(ll.c.status().state, "join-failed");
  const same = androidRig(file, { androidIp: "192.168.1.4", net: { probeOk: () => false } });
  await same.ticks(3);
  assert.equal(same.c.status().state, "join-failed");
  const noMask = androidRig(file, { net: { netmask: "" } });
  await noMask.ticks(3);
  assert.ok(noMask.lines.some((l) => /joined "Pixel" at 192\.168\.43\.17, but its netmask could not be read/.test(l)), noMask.lines.join("\n"));
  assert.equal(fs.existsSync(file), false);
}));

// ---- Making a gap when calls never stop (2026-10-20: postponed from 19:22:54 until the hotspot went) ----

/** Calls run back-to-back until `quietAfterMs` after the gate engages; one new call arrives at the gate as it engages. */
function gapRig(o: { quietAfterMs: number; onLeave?: () => void; onJoin?: () => void; net?: Partial<Net>; onEngagedTick?: (sinceMs: number, r: ReturnType<typeof rig>) => void }) {
  const hold = new HoldGate();
  const events: string[] = [];
  let engagedAt: number | null = null;
  let held: Promise<unknown> = Promise.resolve();
  const r: ReturnType<typeof rig> = rig({
    hold,
    net: { ip: "172.20.10.2", disassociateLandsOn: "192.168.1.4", ...o.net },
    activity: () => {
      if (hold.engaged && engagedAt === null) {
        engagedAt = r.clock.t;
        events.push("engaged");
        held = hold.wait().then((h) => events.push(`held call goes ahead after ${h.timedOut ? "the longest hold" : "release"}`));
      }
      if (engagedAt !== null) o.onEngagedTick?.(r.clock.t - engagedAt, r);
      const busy = engagedAt === null || r.clock.t - engagedAt < o.quietAfterMs;
      return busy ? { inFlight: 1, lastStartedAt: r.clock.t } : { inFlight: 0, lastStartedAt: engagedAt! };
    },
    onLeave: () => {
      events.push(`leave (holding ${hold.waiting})`);
      o.onLeave?.();
    },
    ...(o.onJoin ? { onJoin: o.onJoin } : {}),
  });
  return { ...r, hold, events, held: () => held, engagedAt: () => engagedAt };
}

test("calls never stop: 2 min past due new calls are held, the running ones finish, the return runs, the hold is released", async () => {
  const r = gapRig({ quietAfterMs: 7_000 });
  // First tick plans the return at the 5 min point; 120s past that is 420s in.
  await r.ticks(42); // ticks at 0..410s
  assert.equal(r.events.length, 0, "inside the grace period nothing is held");
  assert.equal(r.returns(), 0);
  assert.ok(r.lines.some((l) => /Wi-Fi return postponed: a model call is running/.test(l)));
  await r.ticks(1); // 420s: 120s past due
  await r.held();
  assert.deepEqual(r.events, ["engaged", "leave (holding 1)", "held call goes ahead after release"]);
  assert.equal(r.engagedAt()! - 1_000_000, 300_000 + RETURN_FORCE_AFTER_MS);
  assert.equal(r.returns(), 1);
  assert.equal(r.hold.engaged, false);
  assert.equal(r.hold.waiting, 0);
  const s = r.c.status();
  assert.equal(s.network, "wifi");
  assert.equal(s.lastSwitch?.ok, true);
  const log = r.lines.join("\n");
  assert.match(log, /tether: Wi-Fi return postponed 120s past due while model calls keep running: holding new model calls to make a gap \(waiting up to 60s for 1 running\)/);
  assert.match(log, /tether: running model calls finished after 7s; 1 held/);
  assert.match(log, /tether: back on Wi-Fi with internet/);
  assert.match(log, /tether: hold released; 1 held model call going ahead/);
  assert.ok(log.indexOf("back on Wi-Fi") < log.indexOf("hold released"), "released after the return, not before");
});

test("calls that do not finish within the drain wait: release, back off to the next point, no switch", async () => {
  const r = gapRig({ quietAfterMs: Infinity });
  await r.ticks(42); // the 5 min point is due at 300s; 120s past it at 420s
  const before = r.clock.t;
  await r.c.tick();
  await r.held();
  const waited = r.clock.t - before;
  assert.ok(waited >= RETURN_DRAIN_WAIT_MS && waited < RETURN_DRAIN_WAIT_MS + 2_000, `waited ${waited}ms`);
  assert.deepEqual(r.events, ["engaged", "held call goes ahead after release"]);
  assert.equal(r.returns(), 0, "the hotspot was not left");
  assert.equal(r.hold.engaged, false);
  assert.equal(r.c.status().state, "on-hotspot");
  const log = r.lines.join("\n");
  // The drain ends at 480s, past the 5 min point, so the next is the 10 min point: 120s away.
  assert.match(log, /staying on the hotspot: 1 model call still running after 60s; held calls released; next try in 120s/);
  assert.match(log, /hold released; 1 held model call going ahead/);
});

test("an error in the middle of the return still releases the hold", async () => {
  const r = gapRig({ quietAfterMs: 3_000, onLeave: () => { throw new Error("osascript exploded"); } });
  await r.ticks(43);
  await r.held();
  assert.deepEqual(r.events, ["engaged", "leave (holding 1)", "held call goes ahead after release"]);
  assert.equal(r.hold.engaged, false);
  assert.equal(r.hold.waiting, 0);
  assert.ok(r.lines.includes("WARN tether: osascript exploded"), r.lines.join("\n"));
  assert.ok(r.lines.some((l) => /hold released; 1 held model call going ahead/.test(l)));
});

test("stop() while waiting for running calls releases the hold at once and gives the return up", async () => {
  let stopped = false;
  const r = gapRig({
    quietAfterMs: Infinity,
    onEngagedTick: (since, rr) => {
      if (since >= 5_000 && !stopped) {
        stopped = true;
        rr.c.stop();
      }
    },
  });
  await r.ticks(43);
  await r.held();
  assert.equal(r.hold.engaged, false);
  assert.deepEqual(r.events, ["engaged", "held call goes ahead after release"]);
  assert.equal(r.returns(), 0);
  assert.ok(r.lines.some((l) => /hold released \(the controller stopped\); 1 held model call going ahead/.test(l)), r.lines.join("\n"));
});

test("a draining router (closed gate) holds nothing: the return just stays postponed", async () => {
  const r = gapRig({ quietAfterMs: Infinity });
  r.hold.close();
  await r.ticks(60);
  assert.deepEqual(r.events, []);
  assert.equal(r.returns(), 0);
  assert.equal(r.c.status().state, "on-hotspot");
});

// A Wi-Fi that is still associated but answers no probe: the first join failed while the hotspot
// was only just in range, and the once-a-minute rule kept the Mac offline for the rest of the minute
// (2026-10-22). A failed join switched nothing: try again after 10 s, then 20 s, then 30 s. The
// no-address case is different on macOS and is tested below (the join is macOS's own first).
test("an associated Wi-Fi with no internet: a failed hotspot join is tried again within seconds", async () => {
  const r = rig({ net: { probeOk: () => false, joinOutput: { code: 0, stdout: "Failed to join network PBJ.", stderr: "" } } });
  await r.ticks(3); // outage, then the first join
  assert.equal(r.joins(), 1);
  assert.equal(r.c.status().state, "join-failed");
  r.net.joinOutput = { code: 0, stdout: "", stderr: "" };
  await r.ticks(1); // 10 s later, not a minute
  assert.equal(r.joins(), 2, r.lines.join("\n"));
  assert.equal(r.c.status().network, "hotspot");
});

// ---- 2026-11-06: a hidden iPhone, a cached scan and a just-joined Wi-Fi --------------------------

test("macOS, no Wi-Fi address: the join is left to macOS for 60s, then one try a minute", async () => {
  const r = rig({ net: { ip: null, probeOk: () => false, joinOutput: { code: 0, stdout: "Failed to join network PBJ.", stderr: "" } } });
  await r.ticks(6); // 0..50s: three failed rounds by 20s, still inside the grace
  assert.equal(r.joins(), 0, "networksetup is not called while macOS may be auto-joining");
  assert.equal(r.c.status().state, "no-wifi");
  const grace = r.lines.filter((l) => l.includes(`leaving the hotspot join to macOS for ${HOTSPOT_JOIN_GRACE_MS / 1000}s`));
  assert.equal(grace.length, 1, "the grace is logged once, not on every tick");
  await r.ticks(1); // 60s: the grace is over
  assert.equal(r.joins(), 1);
  assert.equal(r.c.status().state, "join-failed");
  await r.ticks(5); // 70..110s: a failed join here does not get the 10 s ladder
  assert.equal(r.joins(), 1);
  await r.ticks(1); // 120s
  assert.equal(r.joins(), 2);
});

test("macOS: an address lost while failover waits for a call still gets its own auto-join grace", async () => {
  const busy = { inFlight: 0, loseAt: 0, lost: false };
  const r: ReturnType<typeof rig> = rig({
    net: { probeOk: () => false },
    activity: () => {
      if (busy.loseAt > 0 && !busy.lost && r.clock.t >= busy.loseAt) {
        busy.lost = true;
        busy.inFlight = 0;
        r.net.ip = null;
      }
      return { inFlight: busy.inFlight };
    },
  });
  await r.ticks(2); // two failed rounds
  busy.inFlight = 1; // a model call is running: the failover waits for it
  busy.loseAt = r.clock.t + 3_000;
  await r.ticks(1);
  assert.equal(busy.lost, true, "the wait ran into the loss");
  assert.equal(r.joins(), 0, "networksetup is not called: the grace counts from the loss");
  assert.equal(r.c.status().state, "no-wifi");
  await r.ticks(6); // the grace passes from the loss, not from the tick
  assert.equal(r.joins(), 1);
});

test("the way back needs a saved Wi-Fi at -70 dBm or better; a weak one stays on the hotspot", async () => {
  const r = rig({ net: { ip: "172.20.10.2", scan: { code: 0, stdout: JSON.stringify({ freshMs: 9_500, nets: [], found: [{ name: "Home", rssi: -82 }] }), stderr: "" } } });
  await r.ticks(31); // the 5 min point
  assert.equal(r.returns(), 0);
  assert.equal(r.joins(), 0);
  assert.ok(r.lines.some((l) => /strongest known Wi-Fi is too weak \(Home -82 dBm, needs -70\)/.test(l)), r.lines.join("\n"));
});

test("a scan answered from airportd's cache is not trusted: it is asked again once the cache expires", async () => {
  let scans = 0;
  const r: ReturnType<typeof rig> = rig({
    net: { ip: "172.20.10.2", disassociateLandsOn: "192.168.1.4", scan: CACHED_HOME },
    onScan: () => {
      if (++scans === 2) r.net.scan = FRESH_HOME;
    },
  });
  await r.ticks(31);
  assert.equal(scans, 2);
  assert.equal(r.returns(), 1);
  assert.equal(r.c.status().network, "wifi");
  assert.ok(r.lines.some((l) => /the return scan was answered from cache after 25ms; scanning again/.test(l)), r.lines.join("\n"));
});

test("a scan answered from cache twice is unknown visibility: the hotspot is kept", async () => {
  const r = rig({ net: { ip: "172.20.10.2", scan: CACHED_HOME } });
  await r.ticks(31);
  assert.equal(r.returns(), 0);
  assert.equal(r.joins(), 0);
  assert.ok(r.lines.some((l) => /staying on the hotspot: Wi-Fi visibility is unknown \(the scan was answered from cache\)/.test(l)), r.lines.join("\n"));
});

test("leaving with nothing joined: the hotspot is rejoined at 8s, not after the 20s probe", async () => {
  let leftAt = 0;
  let joinAt = 0;
  const r: ReturnType<typeof rig> = rig({
    net: { ip: "172.20.10.2", disassociateLandsOn: null },
    onLeave: () => { leftAt = r.clock.t; },
    onJoin: () => { joinAt = r.clock.t; },
  });
  await r.ticks(31); // the 5 min point
  assert.equal(r.returns(), 1);
  assert.equal(r.joins(), 1);
  assert.equal(joinAt - leftAt, 8_000, `rejoined after ${joinAt - leftAt}ms`);
  assert.ok(r.lines.some((l) => /no network was joined 8s after leaving; rejoining the hotspot at once/.test(l)), r.lines.join("\n"));
  assert.match(r.c.status().lastSwitch?.reason ?? "", /rejoined the hotspot at once/);
  assert.equal(r.c.status().state, "on-hotspot");
});

test("the Wi-Fi macOS joins is given its settle time before it is called dead", async () => {
  let leftAt = 0;
  const probes: number[] = [];
  const r: ReturnType<typeof rig> = rig({
    net: {
      ip: "172.20.10.2",
      disassociateLandsOn: "192.168.50.7",
      // The network macOS joins answers only 26s after we leave (its own DHCP, EADDRNOTAVAIL
      // probes through an address seconds old): the 20s base window would call it dead.
      probeOk: (ip) => {
        probes.push(r.clock.t - leftAt);
        return isHotspotAddress(ip) || r.clock.t - leftAt >= 26_000;
      },
    },
    onLeave: () => { leftAt = r.clock.t; },
  });
  await r.ticks(31); // the 5 min point
  const late = probes.filter((t) => t > RETURN_PROBE_MS);
  assert.ok(late.length >= 2, `two good probes after the base window: ${probes.join(", ")}`);
  assert.equal(r.returns(), 1);
  assert.equal(r.joins(), 0, "a Wi-Fi that was still coming up is not dropped for the hotspot");
  const s = r.c.status();
  assert.equal(s.network, "wifi");
  assert.equal(s.state, "watching");
  assert.equal(s.lastSwitch?.ok, true);
  assert.ok(!r.lines.some((l) => /has no internet|rejoined the hotspot at once/.test(l)), r.lines.join("\n"));
});

test("holding calls through a settling return stays inside the hold failsafe", () => {
  // returnWithGap holds for the drain wait plus leaveHotspot: the OS calls at either end (leave
  // up to 15s, the final join up to 30s + JOIN_SETTLE_MS 15s) and the probe loop, which is bounded
  // by RETURN_LOOP_CEILING_MS however many networks appear and get their settle.
  const osBudget = 15_000 + 30_000 + 15_000;
  const worst = RETURN_DRAIN_WAIT_MS + RETURN_LOOP_CEILING_MS + osBudget;
  assert.ok(worst < RETURN_HOLD_FAILSAFE_MS, `held at most ${worst}ms, failsafe ${RETURN_HOLD_FAILSAFE_MS}ms`);
});

// 2026-11-07 red team: a call held at the gate goes ahead by itself HOLD_MAX_MS (120s) after the
// gate engaged, while the drain + leave + loop + rejoin could run to ~220s — so a held call could
// go out onto a Wi-Fi with no internet before the hotspot was back. The loop now ends early enough
// that the rejoin's worst case still fits inside the 120s, measured from the engagement.
test("a held gap ends its return in time for the hotspot to be back before a held call's 120s", async () => {
  const rejoinBudget = 30_000 + 15_000; // networksetup join ≤30s + JOIN_SETTLE_MS
  let joinAt: number | null = null;
  let moves = 0;
  const r = gapRig({
    quietAfterMs: 58_000, // a long drain: the budget the loop has left is below the 20s base wait
    onJoin: () => { joinAt ??= r.clock.t - (r.engagedAt() ?? 0); },
    net: {
      ip: "172.20.10.2",
      disassociateLandsOn: "192.168.50.7",
      // A radio that never settles: every probe finds another network, each of which would get its
      // own NETWORK_SETTLE_MS and push the loop to RETURN_LOOP_CEILING_MS.
      probeOk: (ip) => {
        if (isHotspotAddress(ip)) return true;
        r.net.ip = `10.9.${++moves}.7`;
        return false;
      },
    },
  });
  await r.ticks(43); // the 5 min point + 120s
  await r.held();
  assert.equal(r.returns(), 1, "the hotspot was left");
  assert.equal(r.joins(), 1, "the hotspot was put back by our own join");
  assert.ok(joinAt !== null, r.lines.join("\n"));
  assert.ok(joinAt! <= HOLD_MAX_MS - rejoinBudget, `the rejoin started ${joinAt}ms after the hold engaged; the loop must leave ${rejoinBudget}ms for it\n${r.lines.join("\n")}`);
  assert.ok(joinAt! + rejoinBudget <= HOLD_MAX_MS, `the hotspot is back ${joinAt! + rejoinBudget}ms after the hold engaged, past a held call's ${HOLD_MAX_MS}ms\n${r.lines.join("\n")}`);
  assert.equal(r.hold.engaged, false);
  assert.equal(r.c.status().network, "hotspot");
  const log = r.lines.join("\n");
  assert.match(log, /the held-call budget leaves 17s for the return probe loop/);
  assert.match(log, /the return probe loop stopped at the held-call budget \(17s, so the hotspot is back by the time a held call goes ahead at 120s\)/);
});

// 2026-11-07 red team: a probe cannot be recalled, and one started just before the held-gap cap ran
// 4s past it (58s drain + failing 4s probes → the rejoin began at +76s instead of ≤ +75s, so the
// hotspot was back only after the 120s the earliest held call waits). A probe that would not finish
// inside the cap is not started; the rejoin goes ahead.
test("a probe that would run past the held-gap cap is not started: the rejoin starts within it", async () => {
  const rejoinBudget = 30_000 + 15_000; // networksetup join ≤30s + JOIN_SETTLE_MS
  let joinAt: number | null = null;
  const r = gapRig({
    quietAfterMs: 58_000,
    onJoin: () => { joinAt ??= r.clock.t - (r.engagedAt() ?? 0); },
    net: {
      ip: "172.20.10.2",
      disassociateLandsOn: "192.168.50.7",
      // Every probe through the left-behind Wi-Fi takes its full timeout and fails.
      probeOk: (ip) => {
        if (isHotspotAddress(ip)) return true;
        r.clock.t += PROBE_TIMEOUT_MS;
        return false;
      },
    },
  });
  await r.ticks(43); // the 5 min point + 120s
  await r.held();
  assert.equal(r.returns(), 1, "the hotspot was left");
  assert.equal(r.joins(), 1, "the hotspot was put back by our own join");
  assert.ok(joinAt !== null, r.lines.join("\n"));
  assert.ok(joinAt! <= HOLD_MAX_MS - rejoinBudget, `the rejoin started ${joinAt}ms after the hold engaged; it must start by ${HOLD_MAX_MS - rejoinBudget}ms\n${r.lines.join("\n")}`);
  assert.ok(joinAt! + rejoinBudget <= HOLD_MAX_MS, `the hotspot is back ${joinAt! + rejoinBudget}ms after the hold engaged, past a held call's ${HOLD_MAX_MS}ms\n${r.lines.join("\n")}`);
  assert.equal(r.hold.engaged, false);
  assert.equal(r.c.status().network, "hotspot");
  assert.match(r.lines.join("\n"), /the return probe loop stopped at the held-call budget \(17s, so the hotspot is back by the time a held call goes ahead at 120s\)/);
});

// 2026-11-07 red team: a Wi-Fi joined during the drain was disassociated by the leave decided
// before it arrived. The network is read again after the drain; a change (or a hotspot already
// lost) stops the leave, the hold is released, and the next tick judges the new network.
test("a Wi-Fi joined while calls drain is not disassociated by the return", async () => {
  let joinedAt: number | null = null;
  const r: ReturnType<typeof gapRig> = gapRig({
    quietAfterMs: 58_000,
    onEngagedTick: (since, rr) => {
      if (joinedAt === null && since >= 30_000) {
        joinedAt = since;
        rr.net.ip = "192.168.1.4"; // the person joins home Wi-Fi while the calls drain
      }
    },
  });
  await r.ticks(43); // the 5 min point + 120s
  await r.held();
  assert.equal(joinedAt, 30_000, "the Wi-Fi arrived mid-drain");
  assert.equal(r.returns(), 0, "the Wi-Fi joined during the drain was not disassociated");
  assert.equal(r.joins(), 0);
  assert.ok(!r.events.some((e) => e.startsWith("leave")), r.events.join(", "));
  assert.equal(r.hold.engaged, false);
  assert.equal(r.hold.waiting, 0);
  assert.ok(
    r.lines.some((l) => /not leaving the hotspot: the network changed while the drain waited for running calls \(now wifi 192\.168\.1\.4\); the new network is judged by the next tick/.test(l)),
    r.lines.join("\n"),
  );
  // sampleNetwork() reset the window and started the new network's settle; the next tick watches it.
  await r.ticks(1);
  assert.equal(r.c.status().network, "wifi");
  assert.equal(r.c.status().state, "watching");
  assert.equal(r.c.status().lastSwitch, null, "no switch was recorded");
});

test("an address change during the last probe is not lost to the old deadline", async () => {
  let aProbes = 0;
  const r: ReturnType<typeof rig> = rig({
    net: {
      ip: "172.20.10.2",
      disassociateLandsOn: "192.168.1.4",
      probeOk: (ip) => {
        if (ip !== "192.168.1.4") return true;
        // The OS moves to another Wi-Fi while the probe through the old address is running: the
        // round belongs to the old network, and the 32s deadline it was running under must not
        // rejoin the hotspot 0s after this one appeared.
        if (++aProbes === 16) {
          r.net.ip = "10.9.9.9";
          return false;
        }
        return false;
      },
    },
  });
  await r.ticks(31); // the 5 min point
  assert.equal(r.returns(), 1);
  assert.equal(r.joins(), 0, "the network that appeared during the last probe was not evicted");
  const s = r.c.status();
  assert.equal(s.network, "wifi");
  assert.equal(s.state, "watching");
  assert.equal(s.lastSwitch?.ok, true);
});

test("a subnet-only change during the last probe settles the new network too", async () => {
  let probes = 0;
  let moved = false;
  const r: ReturnType<typeof rig> = rig({
    net: {
      ip: "172.20.10.2",
      disassociateLandsOn: "192.168.1.4",
      probeOk: () => {
        if (moved) return true;
        // Same address, different mask: the OS moved to another Wi-Fi's subnet while probing.
        if (++probes === 16) {
          moved = true;
          r.net.netmask = "255.255.0.0";
        }
        return false;
      },
    },
  });
  await r.ticks(31); // the 5 min point
  assert.equal(r.returns(), 1);
  assert.equal(r.joins(), 0, "a subnet-only change is a change too");
  assert.equal(r.c.status().network, "wifi");
  assert.equal(r.c.status().lastSwitch?.ok, true);
});

test("a second network at 28s still gets its full 30s settle, not one capped past the base window", async () => {
  let leftAt = 0;
  const probes: number[] = [];
  const r: ReturnType<typeof rig> = rig({
    net: {
      ip: "172.20.10.2",
      disassociateLandsOn: "192.168.1.4",
      probeOk: (ip) => {
        const t = r.clock.t - leftAt;
        probes.push(t);
        // At 28s the OS moves from the first Wi-Fi to another, which only answers at 52s: the old
        // cap (a settle past the 20s base window, i.e. 50s) evicted it at 50s.
        if (ip === "192.168.1.4" && t >= 28_000) r.net.ip = "10.9.9.9";
        return ip === "10.9.9.9" && t >= 52_000;
      },
    },
    onLeave: () => { leftAt = r.clock.t; },
  });
  await r.ticks(31); // the 5 min point
  assert.equal(r.returns(), 1);
  assert.equal(r.joins(), 0, "the second network got its full 30s");
  assert.ok(probes.some((t) => t > 50_000), `probed past the old cap: ${probes.join(", ")}`);
  assert.equal(r.c.status().network, "wifi");
});

// A Wi-Fi that drops out and comes back is not the network the loop saw before: its reappearance
// is a new network with its own settle (2026-11-07 red team: the same address and subnet came back
// after "none" and was judged on the deadline of its first appearance).
test("Wi-Fi → none → the same Wi-Fi is a new network: it gets a full settle", async () => {
  const probes: number[] = [];
  let leftAt = 0;
  const r: ReturnType<typeof rig> = rig({
    net: {
      ip: "172.20.10.2",
      disassociateLandsOn: "192.168.1.4",
      // The Wi-Fi answers only from 34s after we left: with the settle belonging to the first
      // appearance (deadline 32s) it would be called dead a second before it came up.
      probeOk: (ip) => {
        if (isHotspotAddress(ip)) return true;
        if (ip !== "192.168.1.4") return false;
        const t = r.clock.t - leftAt;
        probes.push(t);
        return t >= 34_000;
      },
    },
    onLeave: () => { leftAt = r.clock.t; },
    onSleep: () => {
      if (!leftAt) return;
      const t = r.clock.t - leftAt;
      if (t === 6_000) r.net.ip = null; // the Wi-Fi drops out while the loop watches…
      else if (t === 8_000) r.net.ip = "192.168.1.4"; // …and the same address and subnet come back
    },
  });
  await r.ticks(31); // the 5 min point
  assert.equal(r.returns(), 1);
  assert.equal(r.joins(), 0, "the reappearing Wi-Fi got a fresh settle instead of the old deadline");
  assert.equal(r.c.status().network, "wifi");
  assert.equal(r.c.status().state, "watching");
  assert.equal(r.c.status().lastSwitch?.ok, true);
  assert.ok(probes.some((t) => t > 32_000), `probed past the deadline of the first appearance: ${probes.join(", ")}`);
});

test("a network the OS just joined is not failed over on the network left behind's probe failures", async () => {
  const r = rig({ net: { ip: "172.20.10.2", probeOk: () => false } });
  await r.ticks(5); // the hotspot's probes all failed: the window is full of failures
  assert.equal(r.joins(), 0);
  let ok = false;
  // The owner joins home Wi-Fi: address, subnet and class all change, and the switch's own probes fail.
  r.net.ip = "192.168.1.4";
  r.net.probeOk = () => ok;
  await r.ticks(4); // 0..30s of the new network: settle time
  assert.equal(r.joins(), 0, "the old failures were not carried over");
  assert.ok(r.lines.some((l) => new RegExp(`network changed \\(hotspot 172\\.20\\.10\\.2 → wifi 192\\.168\\.1\\.4\\); probe window reset, ${NETWORK_SETTLE_MS / 1000}s settle`).test(l)), r.lines.join("\n"));
  ok = true;
  await r.ticks(3);
  assert.equal(r.joins(), 0);
  assert.equal(r.c.status().state, "watching");
});

test("a new address within the same class resets the probe window too", async () => {
  const r = rig({ net: { ip: "192.168.1.4", probeOk: () => false } });
  await r.ticks(2); // two failures, one short of an outage
  r.net.ip = "192.168.2.9"; // the OS moved to another Wi-Fi
  await r.ticks(4); // in the old window this would already be an outage
  assert.equal(r.joins(), 0);
});

test("httpGet's timeout bounds the whole request, not only socket silence (a trickling portal)", async () => {
  const http = await import("node:http");
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    const tick = setInterval(() => res.write("."), 100);
    res.on("close", () => clearInterval(tick));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const { port } = server.address() as { port: number };
    const started = Date.now();
    await assert.rejects(httpGet(`http://127.0.0.1:${port}/`, "127.0.0.1", 500), /probe timed out/);
    assert.ok(Date.now() - started < 1_500, `took ${Date.now() - started}ms`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
