import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULTS, awakeSettings, ssidProblem, tetherSettings, validate, type Config } from "../src/config.ts";
import { Logger } from "../src/log.ts";
import { startAdmin } from "../src/admin.ts";
import { RequestLog } from "../src/requestlog.ts";
import { parsePowerChange, persistPowerChange, type PowerApi, type PowerStatus } from "../src/power.ts";

const STATUS: PowerStatus = {
  platform: "darwin",
  awake: { mode: "working", applied: true, reason: "working: 1 model call running", setup: "ok", battery: { percent: 55, onBattery: false }, thermal: "normal", lidClosed: true, until: null, conflict: null },
  tether: { enabled: true, network: "wifi", state: "watching", pinned: false, hotspotSsid: "PBJ", lastSwitch: null, lastProbe: { at: "2026-10-20T12:00:00.000Z", ok: true, network: "wifi" }, hint: null },
};

type RunCli = (args: string[], timeout?: number) => Promise<{ ok: boolean; output: string }>;

async function withAdmin(power: PowerApi | undefined, fn: (o: { port: number; configFile: string }) => Promise<void>, runCli?: RunCli): Promise<void> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-power-"));
  const prevHome = process.env.CLAUDERIPPLE_HOME;
  process.env.CLAUDERIPPLE_HOME = home;
  const configFile = path.join(home, "config.json");
  const cfg: Config = { ...DEFAULTS, admin: { port: 0 } };
  fs.writeFileSync(configFile, JSON.stringify({ ...cfg, routes: { keep: { provider: "x", model: "y" } }, tether: { hotspotSsid: "PBJ" } }, null, 2));
  const admin = await startAdmin({
    config: () => cfg,
    configFile,
    log: new Logger(null, 1_000_000, 1, false),
    stats: () => ({ inFlight: 0, messagesInFlight: 0, started: 0, completed: 0, failed: 0 }),
    health: () => 0,
    version: "0.0.0-test",
    requests: new RequestLog(path.join(home, "logs", "requests.jsonl")),
    ...(power ? { power } : {}),
    ...(runCli ? { runCli } : {}),
  });
  try {
    await fn({ port: admin.port, configFile });
  } finally {
    admin.close();
    if (prevHome === undefined) delete process.env.CLAUDERIPPLE_HOME;
    else process.env.CLAUDERIPPLE_HOME = prevHome;
  }
}

function fakePower() {
  const log: string[] = [];
  const api: PowerApi = {
    status: () => STATUS,
    pin: (on) => void log.push(`pin ${on}`),
    poke: async () => void log.push("poke"),
  };
  return { api, log };
}

test("GET /api/power returns the contract shape", async () => {
  const p = fakePower();
  await withAdmin(p.api, async ({ port }) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/power`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as PowerStatus;
    assert.equal(body.platform, "darwin");
    assert.deepEqual(Object.keys(body.awake).sort(), ["applied", "battery", "conflict", "lidClosed", "mode", "reason", "setup", "thermal", "until"]);
    for (const k of ["enabled", "network", "state", "lastSwitch", "lastProbe", "hint"]) assert.ok(k in body.tether, k);
  });
});

test("PUT /api/power saves mode/until/enabled into the file as it is on disk, pins in memory, and re-evaluates", async () => {
  const p = fakePower();
  await withAdmin(p.api, async ({ port, configFile }) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/power`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ awake: { mode: "on", until: "2026-10-20T18:30:00+09:00" }, tether: { enabled: true, pin: true } }),
    });
    assert.equal(res.status, 200);
    const saved = JSON.parse(fs.readFileSync(configFile, "utf8")) as Config;
    assert.deepEqual(saved.awake, { mode: "on", until: "2026-10-20T09:30:00.000Z" });
    assert.deepEqual(saved.tether, { hotspotSsid: "PBJ", enabled: true }, "other tether fields are kept");
    assert.deepEqual(saved.routes, { keep: { provider: "x", model: "y" } }, "the rest of the file is untouched");
    assert.equal("pin" in (saved.tether as object), false, "pin is never saved");
    assert.deepEqual(p.log, ["pin true", "poke"]);
    // until: null clears it.
    await fetch(`http://127.0.0.1:${port}/api/power`, { method: "PUT", body: JSON.stringify({ awake: { until: null } }) });
    assert.deepEqual((JSON.parse(fs.readFileSync(configFile, "utf8")) as Config).awake, { mode: "on" });
  });
});

test("PUT /api/power refuses bad input, cross-site pages, and answers 501 without the feature", async () => {
  const p = fakePower();
  await withAdmin(p.api, async ({ port, configFile }) => {
    const before = fs.readFileSync(configFile, "utf8");
    for (const body of [{ awake: { mode: "always" } }, { awake: { until: "soon" } }, { tether: { enabled: "yes" } }, { tether: { hotspotSsid: "Evil" } }, { other: 1 }]) {
      const res = await fetch(`http://127.0.0.1:${port}/api/power`, { method: "PUT", body: JSON.stringify(body) });
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    const cross = await fetch(`http://127.0.0.1:${port}/api/power`, { method: "PUT", headers: { origin: "https://evil.example" }, body: JSON.stringify({ awake: { mode: "on" } }) });
    assert.equal(cross.status, 403);
    assert.equal(fs.readFileSync(configFile, "utf8"), before);
    assert.deepEqual(p.log, []);
  });
  await withAdmin(undefined, async ({ port }) => {
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/power`)).status, 501);
  });
});

test("POST /api/power/setup runs `awake setup --ssid` in the background, GET reports it, and the result re-evaluates", async () => {
  const p = fakePower();
  const calls: { args: string[]; timeout?: number }[] = [];
  let finish!: (r: { ok: boolean; output: string }) => void;
  const runCli: RunCli = (args, timeout) => {
    calls.push({ args, ...(timeout === undefined ? {} : { timeout }) });
    return new Promise((resolve) => { finish = resolve; });
  };
  await withAdmin(p.api, async ({ port }) => {
    const base = `http://127.0.0.1:${port}/api/power/setup`;
    assert.deepEqual(await (await fetch(base)).json(), { running: false });
    const started = await fetch(base, { method: "POST", headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}` }, body: JSON.stringify({ ssid: "Name’s iPhone" }) });
    assert.equal(started.status, 202);
    assert.deepEqual(await started.json(), { started: true });
    assert.deepEqual(calls.map((c) => c.args), [["awake", "setup", "--ssid", "Name’s iPhone"]]);
    assert.ok((calls[0]!.timeout ?? 0) >= 300_000, "a password dialog gets minutes, not the default");
    const running = (await (await fetch(base)).json()) as { running: boolean; startedAt?: string };
    assert.equal(running.running, true);
    assert.ok(running.startedAt);
    // A second press while the dialog is up does not open another.
    assert.equal((await fetch(base, { method: "POST", body: "{}" })).status, 409);
    assert.equal(calls.length, 1);
    finish({ ok: true, output: "✓ installed /etc/sudoers.d/clauderipple" });
    let done: { running: boolean; ok?: boolean; output?: string } = { running: true };
    for (let i = 0; i < 50 && done.running; i++) {
      await new Promise((r) => setTimeout(r, 10));
      done = (await (await fetch(base)).json()) as typeof done;
    }
    assert.equal(done.running, false);
    assert.equal(done.ok, true);
    assert.match(done.output ?? "", /installed/);
    assert.deepEqual(p.log, ["poke"], "the rule is looked for again right away");
    // Without a name: pmset only.
    assert.equal((await fetch(base, { method: "POST" })).status, 202);
    assert.deepEqual(calls[1]!.args, ["awake", "setup"]);
    finish({ ok: false, output: "✗ cancelled; nothing was changed" });
  }, runCli);
});

test("POST /api/power/setup refuses a bad name, unknown fields and cross-site pages before any dialog", async () => {
  const p = fakePower();
  const calls: string[][] = [];
  const runCli: RunCli = async (args) => { calls.push(args); return { ok: true, output: "" }; };
  await withAdmin(p.api, async ({ port }) => {
    const base = `http://127.0.0.1:${port}/api/power/setup`;
    for (const body of [{ ssid: "a;b" }, { ssid: "" }, { ssid: "박의 iPhone" }, { ssid: 5 }, { ssid: "PBJ", remove: true }, [], "x"]) {
      const res = await fetch(base, { method: "POST", body: JSON.stringify(body) });
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.equal((await fetch(base, { method: "POST", body: "{" })).status, 400);
    const cross = await fetch(base, { method: "POST", headers: { origin: "https://evil.example" }, body: JSON.stringify({ ssid: "PBJ" }) });
    assert.equal(cross.status, 403);
    assert.deepEqual(calls, []);
  }, runCli);
  await withAdmin(undefined, async ({ port }) => {
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/power/setup`, { method: "POST", body: "{}" })).status, 501);
  }, runCli);
  assert.deepEqual(calls, []);
});

test("parsePowerChange accepts exactly the contract", () => {
  assert.deepEqual(parsePowerChange({ awake: { mode: "working" } }), { awake: { mode: "working" } });
  assert.deepEqual(parsePowerChange({ tether: { pin: false } }), { tether: { pin: false } });
  assert.equal(typeof parsePowerChange([]), "string");
  assert.match(String(parsePowerChange({ tether: { hotspotSsid: "x" } })), /awake setup --ssid/);
  assert.match(String(parsePowerChange({ awake: { batteryFloorPercent: 5 } })), /unknown field "awake.batteryFloorPercent"/);
});

test("persistPowerChange writes only what changed and nothing for a pin", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cr-power-"));
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, JSON.stringify({ awake: { batteryFloorPercent: 30 } }));
  assert.equal(persistPowerChange(file, { tether: { pin: true } }), false);
  assert.equal(persistPowerChange(file, { awake: { mode: "working" }, tether: { hotspotSsid: "PBJ" } }), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { awake: { batteryFloorPercent: 30, mode: "working" }, tether: { hotspotSsid: "PBJ" } });
});

test("config: off by default, validated when present", () => {
  assert.deepEqual(awakeSettings(DEFAULTS), { mode: "off", batteryFloorPercent: 20 });
  assert.deepEqual(tetherSettings(DEFAULTS), { enabled: false, hotspotSsid: "", probeEverySec: 10 });
  assert.deepEqual(validate({ ...DEFAULTS, awake: { mode: "working" }, tether: { enabled: true, hotspotSsid: "PBJ" } }), []);
  const bad = validate({ ...DEFAULTS, awake: { mode: "always" as "on", until: "x", batteryFloorPercent: 120 }, tether: { enabled: 1 as unknown as boolean, hotspotSsid: "a,b", probeEverySec: 1 } });
  assert.equal(bad.length, 6, bad.join("\n"));
});

test("hotspot names: what an iPhone uses passes, anything sudoers or a shell would read does not", () => {
  for (const ok of ["PBJ", "iPhone", "Name’s iPhone", "Name's iPhone", "my-phone_2.4"]) assert.equal(ssidProblem(ok), null, ok);
  for (const bad of ["", "a,b", "a:b", "a=b", "a\\b", "a*", "a?", "[a]", "#x", 'a"b', "a\nb", " lead", "trail ", "two  spaces", "-n", "x".repeat(33), "ÄÖÜÄÖÜÄÖÜÄÖÜÄÖÜÄÖÜ", "a;b", "$(x)", "`x`"]) {
    assert.notEqual(ssidProblem(bad), null, JSON.stringify(bad));
  }
});
