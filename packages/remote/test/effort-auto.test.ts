// The phone's Auto option: the one router write the host makes, its stale-revision retry, the
// request that runs it, and the capability that tells a phone the option exists.
import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { RouterClient } from "../src/router.ts";
import type { Fetch } from "../src/router.ts";
import { HostServer } from "../src/server.ts";
import type { Peer as ServerPeer, ServerOptions } from "../src/server.ts";
import type { ClientMsg, HostMsg } from "../src/protocol.ts";

type Init = { signal?: AbortSignal; method?: string; headers?: Record<string, string>; body?: string };
type Call = { url: string; init: Init | undefined };
const reply = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

function recording(handle: (url: string, init: Init | undefined) => ReturnType<typeof reply>): { calls: Call[]; fetch: Fetch } {
  const calls: Call[] = [];
  const fetch: Fetch = async (url, init) => {
    calls.push({ url, init });
    return handle(url, init);
  };
  return { calls, fetch };
}

test("Auto is written with the revision that was read, leaving every other setting alone", async () => {
  const settings = { activeMode: "m1", effortAuto: false, floor: "medium", modes: [{ id: "m1", name: "Saver" }] };
  const { calls, fetch } = recording((_url, init) => init?.method === "PUT"
    ? reply(200, { settings: { ...settings, effortAuto: true }, revision: 8 })
    : reply(200, { settings, revision: 7 }));
  assert.equal(await new RouterClient("http://router/", fetch).setEffortAuto(true), true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.init?.method, undefined, "the read is a plain GET");
  const put = calls[1]!;
  assert.equal(put.url, "http://router/api/mod-settings");
  assert.equal(put.init?.method, "PUT");
  assert.equal(put.init?.headers?.["content-type"], "application/json");
  assert.deepEqual(JSON.parse(put.init!.body!), { schemaVersion: 1, revision: 7, settings: { ...settings, effortAuto: true } });
});

test("a stale save retries from the 409 snapshot, at most three attempts", async () => {
  const first = { settings: { effortAuto: false, floor: "low" }, revision: 3 };
  const second = { settings: { effortAuto: false, floor: "high" }, revision: 5 };
  let puts = 0;
  const { calls, fetch } = recording((_url, init) => {
    if (init?.method !== "PUT") return reply(200, first);
    return puts++ === 0 ? reply(409, second) : reply(200, { settings: { ...second.settings, effortAuto: true }, revision: 6 });
  });
  assert.equal(await new RouterClient("http://router", fetch).setEffortAuto(true), true);
  assert.deepEqual(calls.map(call => call.init?.method ?? "GET"), ["GET", "PUT", "PUT"]);
  assert.equal(JSON.parse(calls[1]!.init!.body!).revision, 3);
  assert.deepEqual(JSON.parse(calls[2]!.init!.body!), { schemaVersion: 1, revision: 5, settings: { effortAuto: true, floor: "high" } });

  let stale = 0;
  const always = recording((_url, init) => init?.method !== "PUT"
    ? reply(200, first)
    : reply(409, { settings: first.settings, revision: ++stale }));
  await assert.rejects(new RouterClient("http://router", always.fetch).setEffortAuto(false), /revision changed too often/);
  assert.equal(always.calls.filter(call => call.init?.method === "PUT").length, 3, "three attempts, then it stops");
});

test("a router that refuses the write or has no settings is an error, not a silent success", async () => {
  const refused = recording((_url, init) => init?.method === "PUT" ? reply(500, { error: "no" }) : reply(200, { settings: { effortAuto: false }, revision: 1 }));
  await assert.rejects(new RouterClient("http://router", refused.fetch).setEffortAuto(true), /HTTP 500/);
  assert.equal(refused.calls.filter(call => call.init?.method === "PUT").length, 1, "a 500 is not retried");

  const empty = recording(() => reply(200, { revision: 1 }));
  await assert.rejects(new RouterClient("http://router", empty.fetch).setEffortAuto(true), /no mod settings/);
});

// ---- the host's answer to the phone -----------------------------------------------------------

class Peer extends EventEmitter implements ServerPeer {
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  readonly frames: HostMsg[] = [];
  send(text: string): void { this.frames.push(JSON.parse(text) as HostMsg); }
  close(): void { this.terminate(); }
  terminate(): void { this.readyState = 3; this.emit("close"); }
  receive(msg: ClientMsg): void { this.emit("message", JSON.stringify(msg)); }
  async take<T extends HostMsg["t"]>(kind: T, matches: (msg: Extract<HostMsg, { t: T }>) => boolean = () => true): Promise<Extract<HostMsg, { t: T }>> {
    const deadline = performance.now() + 5000;
    for (;;) {
      const index = this.frames.findIndex(frame => frame.t === kind && matches(frame as Extract<HostMsg, { t: T }>));
      if (index !== -1) return this.frames.splice(index, 1)[0] as Extract<HostMsg, { t: T }>;
      assert.ok(performance.now() < deadline, `no ${kind} frame arrived: ${JSON.stringify(this.frames)}`);
      await new Promise(resolve => setTimeout(resolve, 2));
    }
  }
}

const webDir = fileURLToPath(new URL("../web", import.meta.url));
const token = "effort-auto-test-token";

/** A host whose router keeps `effortAuto` in memory, the way the router's mod settings file does. */
function fakeRouter(writable: boolean) {
  let effortAuto = false;
  let revision = 4;
  const calls: boolean[] = [];
  return {
    calls,
    status: async () => ({ ok: true as const, proxyEnv: {} }),
    models: async () => [],
    limits: async () => ({ providers: [] }),
    modSettings: async () => ({ settings: { effortAuto, floor: "medium" }, revision }),
    ...(writable ? {
      setEffortAuto: async (on: boolean) => { calls.push(on); effortAuto = on; revision++; return effortAuto; },
    } : {}),
  };
}

async function hostWith(t: TestContext, router: ReturnType<typeof fakeRouter>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ripple-effort-auto-"));
  const sessions = { list: () => [], groups: () => undefined, watchAttached: () => {}, pollDesktop: async () => {}, pollQueued: () => {}, prepareRefresh: () => true } as unknown as ServerOptions["sessions"];
  const server = new HostServer({ listen: "127.0.0.1", port: 0, token, webDir, sessions, router, hostName: "test", version: "1", recentCli: async () => [] });
  await server.listen();
  t.after(async () => { await server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const phone = new Peer();
  server.connected(phone);
  phone.receive({ t: "hello", token, clientId: "phone-one" });
  const ready = await phone.take("ready");
  return { server, phone, ready };
}

test("the host advertises the Auto write only when its router can make it", async t => {
  const capable = await hostWith(t, fakeRouter(true));
  assert.equal(capable.ready.host.capabilities?.effortAuto, true, "a writable router says so in ready");
  const plain = await hostWith(t, fakeRouter(false));
  assert.equal(plain.ready.host.capabilities?.effortAuto, undefined, "an older host leaves it out");
});

test("effort_auto answers the stored value and every phone hears the new ripple at once", async t => {
  const router = fakeRouter(true);
  const { server, phone } = await hostWith(t, router);
  const other = new Peer();
  server.connected(other);
  other.receive({ t: "hello", token, clientId: "phone-two" });
  await other.take("ready");

  phone.receive({ t: "req", reqId: "auto-on", op: { op: "effort_auto", on: true } });
  const answer = await phone.take("res", msg => msg.reqId === "auto-on");
  assert.deepEqual(answer, { t: "res", reqId: "auto-on", ok: true, data: { effortAuto: true } });
  assert.deepEqual(router.calls, [true]);
  // The refresh is part of the answer, not the next 15-second poll.
  for (const peer of [phone, other]) {
    const host = await peer.take("host", msg => msg.host.ripple?.effortAuto === true);
    assert.equal(host.host.ripple?.effortAuto, true);
  }

  phone.receive({ t: "req", reqId: "auto-off", op: { op: "effort_auto", on: false } });
  assert.deepEqual(await phone.take("res", msg => msg.reqId === "auto-off"), { t: "res", reqId: "auto-off", ok: true, data: { effortAuto: false } });
  assert.deepEqual(router.calls, [true, false]);
});

test("a host that cannot write mod settings refuses effort_auto instead of pretending", async t => {
  const { phone } = await hostWith(t, fakeRouter(false));
  phone.receive({ t: "req", reqId: "auto", op: { op: "effort_auto", on: true } });
  const answer = await phone.take("res", msg => msg.reqId === "auto");
  assert.equal(answer.ok, false);
  if (!answer.ok) assert.match(answer.error, /cannot change the Auto setting/);
});
