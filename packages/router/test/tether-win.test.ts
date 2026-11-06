import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import type os from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  FIND_WIFI_PS, WIN_HINTS, autoProfiles, classifyNetshConnect, hotspotProfile, listWifiProfiles, needsLocation, parseAdapterName, parseProfileNames,
  parseProfileXml, parseVisibleSsids, quotable,
} from "../src/tether-win.ts";
import { TetherController, isHotspotAddress } from "../src/tether.ts";
import { HoldGate } from "../src/hold.ts";
import type { Activity, RunOptions, RunResult } from "../src/awake.ts";
import { TETHER_DEFAULTS, type TetherSettings } from "../src/config.ts";

// netsh's documented layout (English). Not measured on Windows for this change — see ARCHITECTURE §8.
const SHOW_PROFILES = `
Profiles on interface Wi-Fi:

Group policy profiles (read only)
---------------------------------
    <None>

User profiles
-------------
    All User Profile     : Home
    All User Profile     : PBJ’s iPhone
    All User Profile     : Cafe
`;
// Translated labels: the names after " : " are what is read.
const SHOW_PROFILES_KO = `
Wi-Fi 인터페이스의 프로필:

그룹 정책 프로필(읽기 전용)
---------------------------------
    <없음>

사용자 프로필
-------------
    모든 사용자 프로필     : Home
    모든 사용자 프로필     : PBJ’s iPhone
`;
const LOCATION = "Network shell commands need location permission to access WLAN information. Turn on Location services on the Location page in Privacy & security settings.\n\nHere is the URI for the Location page in the Settings app:\nms-settings:privacy-location\n";

const profileXml = (name: string, ssid: string, mode: "auto" | "manual") => `﻿<?xml version="1.0"?>
<WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1">
	<name>${name}</name>
	<SSIDConfig>
		<SSID>
			<hex>00</hex>
			<name>${ssid}</name>
		</SSID>
	</SSIDConfig>
	<connectionType>ESS</connectionType>
	<connectionMode>${mode}</connectionMode>
	<MSM><security><authEncryption><authentication>WPA2PSK</authentication></authEncryption></security></MSM>
</WLANProfile>
`;

test("adapter name, location refusal, and what netsh can quote", () => {
  assert.equal(parseAdapterName("﻿Wi-Fi\r\n"), "Wi-Fi");
  assert.equal(parseAdapterName("\r\n"), null);
  assert.equal(parseAdapterName('Wi"Fi\r\n'), null);
  assert.match(FIND_WIFI_PS, /NdisPhysicalMedium -eq 9 -or \$_\.NdisPhysicalMedium -eq 1/);
  assert.doesNotMatch(FIND_WIFI_PS, /netsh|show interfaces/, "the Location-gated query is not used");
  assert.equal(needsLocation({ code: 1, stdout: LOCATION, stderr: "" }), true);
  assert.equal(needsLocation({ code: 1, stdout: "There is no profile assigned", stderr: "" }), false);
  assert.equal(quotable("PBJ’s iPhone"), true);
  assert.equal(quotable('a" & calc'), false);
});

test("profile names in preference order, whatever the display language", () => {
  assert.deepEqual(parseProfileNames(SHOW_PROFILES), ["Home", "PBJ’s iPhone", "Cafe"]);
  assert.deepEqual(parseProfileNames(SHOW_PROFILES_KO), ["Home", "PBJ’s iPhone"]);
});

test("profile XML: name, SSID and auto-connect, entities decoded", () => {
  assert.deepEqual(parseProfileXml(profileXml("Home", "Home", "auto")), { name: "Home", ssid: "Home", auto: true });
  assert.deepEqual(parseProfileXml(profileXml("Hotspot", "PBJ&apos;s iPhone", "manual")), { name: "Hotspot", ssid: "PBJ's iPhone", auto: false });
  assert.equal(parseProfileXml("<nothing/>"), null);
});

test("netsh connect: exit code and location decide; the address decides after", () => {
  assert.equal(classifyNetshConnect({ code: 0, stdout: "Connection request was completed successfully.\n", stderr: "" }), null);
  assert.equal(classifyNetshConnect({ code: 1, stdout: LOCATION, stderr: "" }), "needs-location");
  assert.equal(classifyNetshConnect({ code: 1, stdout: 'The network specified by profile "X" is not available to connect.\n', stderr: "" }), "hotspot-not-visible");
  assert.equal(classifyNetshConnect({ code: 1, stdout: 'There is no profile "X" assigned to the specified interface.\n', stderr: "" }), "no-hotspot-profile");
  assert.equal(classifyNetshConnect({ code: 1, stdout: "알 수 없는 오류\n", stderr: "" }), "join-failed");
});

// ---- A fake Windows: netsh, Get-NetAdapter, and a Wi-Fi interface ------------------------------

type Profile = { name: string; ssid: string; mode: "auto" | "manual" };
type Net = {
  ip: string | null;
  profiles: Profile[];
  location: boolean;
  probeOk: (ip: string) => boolean;
  /** Where `netsh wlan connect name=<profile>` lands, per profile name; undefined = nothing. */
  lands: Record<string, string | undefined>;
  /** Where Windows auto-joins after a disconnect (null = nothing). */
  autoJoin: string | null;
  connectCode: number;
  visible: string[];
  scan: RunResult | Error | null;
  profileError: "show" | "export" | null;
};

function rig(o: { net?: Partial<Net>; settings?: Partial<TetherSettings>; activity?: () => Activity; stateFile?: string } = {}) {
  const clock = { t: 1_000_000 };
  const calls: { line: string; opts?: RunOptions }[] = [];
  const lines: string[] = [];
  const net: Net = {
    ip: "192.168.1.4",
    profiles: [
      { name: "Home", ssid: "Home", mode: "auto" },
      { name: "PBJ’s iPhone", ssid: "PBJ’s iPhone", mode: "manual" },
    ],
    location: false,
    probeOk: () => true,
    lands: { "PBJ’s iPhone": "172.20.10.3", Home: "192.168.1.4" },
    autoJoin: "192.168.1.4",
    connectCode: 0,
    visible: ["Home", "PBJ’s iPhone"],
    scan: null,
    profileError: null,
    ...o.net,
  };
  let settings: TetherSettings = { ...TETHER_DEFAULTS, enabled: true, hotspotSsid: "PBJ’s iPhone", ...o.settings };
  const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
  const run = async (file: string, args: string[], opts?: RunOptions): Promise<RunResult> => {
    const exe = path.win32.basename(file).toLowerCase();
    const line = `${exe} ${exe === "powershell.exe" ? "<script>" : args.join(" ")}`;
    calls.push({ line, ...(opts ? { opts } : {}) });
    if (exe === "powershell.exe") {
      assert.ok(opts?.env && !Object.keys(opts.env).some((k) => k.toLowerCase() === "psmodulepath"), "PSModulePath removed");
      return ok("Wi-Fi\r\n");
    }
    assert.equal(exe, "netsh.exe");
    if (net.location) return { code: 1, stdout: LOCATION, stderr: "" };
    if (net.profileError && line.includes(`wlan ${net.profileError === "show" ? "show profiles" : "export profile"}`)) return { code: 1, stdout: "", stderr: "profiles unavailable" };
    if (line === 'netsh.exe wlan show networks mode=ssid interface="Wi-Fi"') {
      assert.equal(opts?.verbatim, true);
      if (net.scan instanceof Error) throw net.scan;
      return net.scan ?? ok(`\nInterface name : Wi-Fi\n${net.profiles.length} networks visible.\n${net.visible.map((ssid, i) => `SSID ${i + 1} : ${ssid}\n    Network type : Infrastructure\n    Authentication : WPA2-Personal`).join("\n")}\n`);
    }
    if (line === "netsh.exe wlan show profiles") return ok(`\nUser profiles\n-------------\n${net.profiles.map((p) => `    All User Profile     : ${p.name}`).join("\n")}\n`);
    if (line.startsWith("netsh.exe wlan export profile folder=")) {
      assert.equal(opts?.verbatim, true);
      const dir = /folder="([^"]+)"/.exec(line)![1]!;
      // Files are listed alphabetically by the file system, not in preference order.
      for (const p of [...net.profiles].reverse()) fs.writeFileSync(path.join(dir, `Wi-Fi-${p.name}.xml`), profileXml(p.name, p.ssid, p.mode));
      return ok("Interface profile \"Home\" is saved in file ...\n");
    }
    const connect = /^netsh\.exe wlan connect name="([^"]+)" interface="Wi-Fi"$/.exec(line);
    if (connect) {
      assert.equal(opts?.verbatim, true, "quotes reach netsh as written");
      if (net.connectCode !== 0) return { code: net.connectCode, stdout: "There is no profile assigned\n", stderr: "" };
      const to = net.lands[connect[1]!];
      if (to !== undefined) net.ip = to;
      return ok("Connection request was completed successfully.\n");
    }
    if (line === 'netsh.exe wlan disconnect interface="Wi-Fi"') {
      net.ip = net.autoJoin;
      return ok('Disconnection request was completed successfully for interface "Wi-Fi".\n');
    }
    throw new Error(`unexpected command: ${line}`);
  };
  const iface = (address: string): os.NetworkInterfaceInfo => ({ address, family: "IPv4", internal: false, netmask: "255.255.255.0", mac: "", cidr: null }) as os.NetworkInterfaceInfo;
  const hold = new HoldGate();
  const c = new TetherController({
    hold,
    platform: "win32",
    run,
    settings: () => settings,
    activity: o.activity ?? (() => ({ inFlight: 0 })),
    log: { info: (m) => lines.push(m), warn: (m) => lines.push(`WARN ${m}`) },
    now: () => clock.t,
    sleep: async (ms) => { clock.t += ms; },
    interfaces: () => (net.ip ? { "Wi-Fi": [iface(net.ip)], Ethernet: [iface("10.0.0.9")] } : { Ethernet: [iface("10.0.0.9")] }),
    probe: async (ip) => net.probeOk(ip),
    schedule: () => () => {},
    ...(o.stateFile ? { stateFile: o.stateFile } : {}),
  });
  const ticks = async (n: number): Promise<void> => {
    for (let i = 0; i < n; i++) {
      await c.tick();
      clock.t += settings.probeEverySec * 1000;
    }
  };
  const count = (re: RegExp) => calls.filter((x) => re.test(x.line)).length;
  return { c, hold, run, clock, calls, lines, net, ticks, count, set: (s: Partial<TetherSettings>) => (settings = { ...settings, ...s }) };
}

test("listWifiProfiles: preference order from show profiles, SSID and mode from the XML; the temp folder is removed", async () => {
  const r = rig({ net: { profiles: [{ name: "Home", ssid: "Home", mode: "auto" }, { name: "Hot", ssid: "PBJ’s iPhone", mode: "manual" }, { name: "Cafe", ssid: "Cafe", mode: "auto" }] } });
  const run = r.run;
  const list = await listWifiProfiles(run);
  assert.deepEqual(list.profiles.map((p) => p.name), ["Home", "Hot", "Cafe"]);
  assert.equal(hotspotProfile(list.profiles, "PBJ’s iPhone")?.name, "Hot", "matched by SSID");
  assert.deepEqual(autoProfiles(list.profiles, "PBJ’s iPhone").map((p) => p.name), ["Home", "Cafe"]);
  const dir = /folder="([^"]+)"/.exec(r.calls.find((c) => c.line.includes("export"))!.line)![1]!;
  assert.equal(fs.existsSync(dir), false);
  r.net.location = true;
  assert.deepEqual(await listWifiProfiles(run), { profiles: [], location: true });
});

test("Windows failover: the third failed round joins the saved hotspot profile by name on the Wi-Fi adapter", async () => {
  const r = rig({ net: { probeOk: (ip) => isHotspotAddress(ip) } });
  await r.ticks(2);
  assert.equal(r.count(/wlan connect/), 0);
  await r.ticks(1);
  assert.ok(r.calls.some((x) => x.line === 'netsh.exe wlan connect name="PBJ’s iPhone" interface="Wi-Fi"'));
  const s = r.c.status();
  assert.equal(s.state, "on-hotspot");
  assert.equal(s.network, "hotspot");
  assert.equal(r.count(/powershell/), 1, "the adapter is looked up once");
});

test("Windows failover without a saved hotspot profile, or without Location: the reason and its hint, no connect", async () => {
  const a = rig({ net: { probeOk: () => false, profiles: [{ name: "Home", ssid: "Home", mode: "auto" }] } });
  await a.ticks(3);
  assert.equal(a.count(/wlan connect/), 0);
  assert.equal(a.c.status().state, "no-hotspot-profile");
  assert.equal(a.c.status().hint, WIN_HINTS["no-hotspot-profile"]);
  const b = rig({ net: { probeOk: () => false, location: true } });
  await b.ticks(3);
  assert.equal(b.c.status().state, "needs-location");
  assert.match(b.c.status().hint ?? "", /Privacy & security → Location/);
});

test("Windows failover: connect accepted but no hotspot address reads as not broadcasting, retried within seconds", async () => {
  const r = rig({ net: { probeOk: () => false, lands: {} } });
  await r.ticks(3);
  assert.equal(r.c.status().state, "hotspot-not-visible");
  assert.match(r.c.status().hint ?? "", /phone's hotspot\. On an iPhone, open Settings → Personal Hotspot/);
  assert.match(r.c.status().hint ?? "", /On Android, turn Wi-Fi hotspot on/);
  const n = r.count(/wlan connect/);
  // The join's own wait for an address moves this clock too, so only the first retry's timing is exact.
  await r.ticks(1);
  assert.equal(r.count(/wlan connect/), n + 1, "10 s later, not a minute");
  await r.ticks(6);
  assert.ok(r.count(/wlan connect/) < n + 1 + 6, "the gap grows: not one join per tick");
});

test("Windows return: disconnect, and Windows' own auto-connect brings Wi-Fi back", async () => {
  const r = rig({ net: { ip: "172.20.10.3" } });
  await r.ticks(31);
  assert.equal(r.count(/wlan disconnect/), 1);
  assert.equal(r.count(/wlan connect/), 0);
  assert.equal(r.c.status().state, "watching");
  assert.equal(r.c.status().lastSwitch?.ok, true);
  assert.ok(r.lines.some((l) => /so Windows joins the best known network/.test(l)));
});

test("netsh visible SSIDs: English/Korean fields, no BSSID or hidden/duplicate name false positives", () => {
  const shown = `Interface name : Wi-Fi\r\nThere are 3 networks currently visible.\r\nSSID 1 : Home\r\n    Network type : Infrastructure\r\n    BSSID 1 : aa:bb:cc:dd:ee:ff\r\nSSID 2 : 맘보 2층\r\n    네트워크 종류 : 인프라\r\nSSID 3 : \r\nSSID 4 : Home\r\n`;
  assert.deepEqual(parseVisibleSsids(shown), ["Home", "맘보 2층"]);
  assert.deepEqual(parseVisibleSsids("There are 0 networks currently visible.\n"), []);
  assert.deepEqual(parseVisibleSsids("All User Profile : Home\n    BSSID 1 : Home\n"), []);
});

for (const busy of [false, true]) {
  const scenarios: { name: string; net: Partial<Net>; reason: RegExp }[] = [
    { name: "hotspot and unknown only", net: { visible: ["PBJ’s iPhone", "Stranger"] }, reason: /no known Wi-Fi in range/ },
    { name: "empty scan", net: { visible: [] }, reason: /no known Wi-Fi in range/ },
    { name: "scan error", net: { scan: { code: 1, stdout: "", stderr: "scan failed" } }, reason: /scan failed/ },
    { name: "Location refused during scan", net: { scan: { code: 0, stdout: LOCATION, stderr: "" } }, reason: /Location on to scan/ },
    { name: "unsupported scan", net: { scan: { code: 0, stdout: "command is not supported", stderr: "" } }, reason: /no known Wi-Fi in range/ },
    { name: "scan runner throws", net: { scan: new Error("scan timeout") }, reason: /scan failed.*scan timeout/ },
    { name: "profile list fails", net: { profileError: "show" }, reason: /scan failed.*profiles unavailable/ },
    { name: "profile export fails", net: { profileError: "export" }, reason: /scan failed.*profiles unavailable/ },
    { name: "only manual known network visible", net: { visible: ["Cafe"], profiles: [{ name: "Home", ssid: "Home", mode: "auto" }, { name: "Cafe", ssid: "Cafe", mode: "manual" }] }, reason: /no known Wi-Fi in range/ },
  ];
  for (const scenario of scenarios) test(`Windows ${busy ? "gap" : "quiet"} return stays: ${scenario.name}`, async () => {
    const r = rig({ net: { ip: "172.20.10.3", ...scenario.net }, activity: () => ({ inFlight: busy ? 1 : 0 }) });
    await r.ticks(busy ? 43 : 31);
    assert.equal(r.count(/wlan disconnect|wlan connect/), 0);
    assert.equal(r.hold.engaged, false);
    assert.ok(!r.lines.some((line) => /holding new model calls|hold released/.test(line)));
    assert.equal(r.c.status().lastSwitch, null);
    assert.equal(r.c.status().state, "on-hotspot");
    const stays = r.lines.filter((line) => line.startsWith("tether: staying on the hotspot:"));
    assert.equal(stays.length, 1);
    assert.match(stays[0]!, scenario.reason);
  });
}

test("Windows visibility matches the profile's SSID, not its name", async () => {
  const profiles: Profile[] = [{ name: "Home profile", ssid: "맘보 2층", mode: "auto" }, { name: "Hotspot alias", ssid: "PBJ’s iPhone", mode: "auto" }];
  const visible = rig({ net: { ip: "172.20.10.3", profiles, visible: ["맘보 2층"] } });
  await visible.ticks(31);
  assert.equal(visible.count(/wlan disconnect/), 1);
  const nameOnly = rig({ net: { ip: "172.20.10.3", profiles, visible: ["Home profile", "PBJ’s iPhone"] } });
  await nameOnly.ticks(31);
  assert.equal(nameOnly.count(/wlan disconnect/), 0);
});

test("Windows return: nothing auto-joins after the disconnect, so the first automatic profile is asked for by name", async () => {
  const r = rig({ net: { ip: "172.20.10.3", autoJoin: null } });
  await r.ticks(31);
  assert.equal(r.count(/wlan disconnect/), 1);
  assert.ok(r.calls.some((x) => x.line === 'netsh.exe wlan connect name="Home" interface="Wi-Fi"'));
  assert.equal(r.c.status().network, "wifi");
  assert.equal(r.c.status().state, "watching");
});

test("Windows return: no other automatic Wi-Fi means no attempt at all, and the next scheduled point is planned", async () => {
  const r = rig({ net: { ip: "172.20.10.3", profiles: [{ name: "PBJ’s iPhone", ssid: "PBJ’s iPhone", mode: "auto" }, { name: "Old", ssid: "Old", mode: "manual" }] } });
  await r.ticks(31);
  assert.equal(r.count(/wlan disconnect/), 0);
  assert.equal(r.c.status().state, "on-hotspot");
  // 5 min point reached at 300s and refused; the next is the 10 min point, ~290s later.
  assert.ok(r.lines.some((l) => /staying on the hotspot: no other Wi-Fi on this PC is set to connect automatically; next try in (29[0-9]|300)s/.test(l)), r.lines.join("\n"));
});

test("Windows return: Windows rejoins the hotspot by itself → stay, back off", async () => {
  const r = rig({ net: { ip: "172.20.10.3", autoJoin: "172.20.10.3" } });
  await r.ticks(31);
  assert.equal(r.count(/wlan disconnect/), 1);
  assert.equal(r.c.status().state, "on-hotspot");
  assert.match(r.c.status().lastSwitch?.reason ?? "", /Windows rejoined the hotspot/);
});

test("Windows, Android hotspot: our connect lands on a new subnet, it is remembered, a new controller and a by-hand join read it as the hotspot", async () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "cr-tether-win-android-"));
  try {
    const file = path.join(dir, "tether.json");
    const pixel = { name: "Pixel 9", ssid: "Pixel 9", mode: "manual" as const };
    const net = {
      profiles: [{ name: "Home", ssid: "Home", mode: "auto" as const }, pixel],
      lands: { "Pixel 9": "10.42.17.5", Home: "192.168.1.4" },
      probeOk: (ip: string) => ip.startsWith("10.42.17."),
    };
    const r = rig({ stateFile: file, settings: { hotspotSsid: "Pixel 9" }, net });
    await r.ticks(3);
    assert.ok(r.calls.some((x) => x.line === 'netsh.exe wlan connect name="Pixel 9" interface="Wi-Fi"'));
    assert.equal(r.c.status().state, "on-hotspot");
    assert.equal(r.c.status().network, "hotspot");
    assert.ok(r.lines.includes('tether: remembering 10.42.17.0/24 as hotspot "Pixel 9"\'s network'), r.lines.join("\n"));
    assert.equal(r.count(/show interfaces/), 0, "the Location-gated query is still not used");
    // The way back: disconnect, Windows auto-joins Home, which works.
    r.net.probeOk = () => true;
    await r.ticks(31);
    assert.equal(r.count(/wlan disconnect/), 1);
    assert.equal(r.c.status().network, "wifi");
    // A restarted router already on the phone (joined by hand).
    const again = rig({ stateFile: file, settings: { hotspotSsid: "Pixel 9" }, net: { ...net, ip: "10.42.17.9" } });
    await again.ticks(1);
    assert.equal(again.c.status().state, "on-hotspot");
    assert.equal(again.count(/wlan connect/), 0);
    // Home Wi-Fi on another subnet is not misread under the same memory.
    const home = rig({ stateFile: file, settings: { hotspotSsid: "Pixel 9" }, net: { ...net, probeOk: () => true } });
    await home.ticks(5);
    assert.equal(home.c.status().state, "watching");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Windows with no address still joins on the third failed round: the macOS-only 60s grace is not applied", async () => {
  const r = rig({ net: { ip: null, probeOk: () => false } });
  await r.ticks(2);
  assert.equal(r.count(/wlan connect/), 0);
  await r.ticks(1);
  assert.equal(r.count(/wlan connect/), 1);
  assert.equal(r.c.status().network, "hotspot", "the connect's 172.20.10.3 is recognised as the iPhone range");
});

// ---- 2026-11-06 red team: a change during a tick, and a lost address ------------------------

test("Windows: a network joined while the tick probes is not evicted by the failover it started", async () => {
  let probes = 0;
  const r: ReturnType<typeof rig> = rig({
    net: {
      probeOk: () => {
        // The third failing round: while its probe is out, the OS or the person joins a working Wi-Fi.
        if (++probes === 3) {
          r.net.ip = "10.0.0.50";
          r.net.probeOk = () => true;
        }
        return false;
      },
    },
  });
  await r.ticks(3);
  assert.equal(r.count(/wlan connect/), 0, "the Wi-Fi that arrived is not evicted");
  assert.equal(r.c.status().lastSwitch, null, "no switch happened");
  assert.equal(r.c.status().network, "wifi");
  assert.ok(r.lines.some((l) => /network changed \(wifi 192\.168\.1\.4 → wifi 10\.0\.0\.50\); probe window reset, 30s settle$/.test(l)), r.lines.join("\n"));
  await r.ticks(1);
  assert.equal(r.c.status().state, "watching");
  assert.equal(r.count(/wlan connect/), 0);
});

test("Windows: a network joined while failover waits for in-flight calls is not evicted", async () => {
  const busy = { inFlight: 0, changeAt: 0, changed: false };
  const r: ReturnType<typeof rig> = rig({
    net: { probeOk: () => false },
    activity: () => {
      // 3 s into the wait for the running call, the OS or the person joins a working Wi-Fi.
      if (busy.changeAt > 0 && !busy.changed && r.clock.t >= busy.changeAt) {
        busy.changed = true;
        busy.inFlight = 0;
        r.net.ip = "10.0.0.50";
        r.net.probeOk = () => true;
      }
      return { inFlight: busy.inFlight };
    },
  });
  await r.ticks(2); // two failed rounds
  assert.equal(r.count(/wlan connect/), 0);
  busy.inFlight = 1; // a model call is running: the failover waits for it
  busy.changeAt = r.clock.t + 3_000;
  await r.ticks(1);
  assert.equal(busy.changed, true, "the wait ran into the change");
  assert.equal(r.count(/wlan connect/), 0, "the Wi-Fi that arrived is not evicted");
  assert.equal(r.c.status().lastSwitch, null, "no switch happened");
  assert.equal(r.c.status().network, "wifi");
  await r.ticks(1);
  assert.equal(r.c.status().state, "watching");
  assert.equal(r.count(/wlan connect/), 0);
});

test("Windows: an address lost while failover waits for a call still joins at once", async () => {
  // Nothing is left to evict, so the join the tick already decided on goes ahead: a change to "none"
  // must not cost three more failed rounds the way a settle would.
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
  assert.equal(r.count(/wlan connect/), 1, "joined on this tick");
  assert.equal(r.c.status().network, "hotspot");
});

test("Windows: losing the Wi-Fi address fails over on the timing it had before the settle logic", async () => {
  const r = rig({ net: { probeOk: () => true } });
  await r.ticks(4); // healthy Wi-Fi: the window is all successes
  assert.equal(r.c.status().state, "watching");
  r.net.ip = null;
  r.net.probeOk = () => false;
  // Before any settle logic the loss was the third failed round: three 10 s ticks, so 20 s. A
  // settle on the loss would ignore those rounds and put the first join at ~50 s.
  await r.ticks(2);
  assert.equal(r.count(/wlan connect/), 0, "two failed rounds are not yet an outage");
  await r.ticks(1);
  assert.equal(r.count(/wlan connect/), 1);
  assert.equal(r.c.status().network, "hotspot");
  const loss = r.lines.find((l) => l.includes("network changed (wifi 192.168.1.4 → none)"));
  assert.ok(loss, r.lines.join("\n"));
  assert.match(loss, /; probe window reset$/, "a lost address gets no settle");
});
