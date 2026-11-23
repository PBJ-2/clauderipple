// The host as a daily service: its launchd plist, the power hold while a turn runs, and when
// notifications go out.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PowerHold } from "../src/power.ts";
import type { Held } from "../src/power.ts";
import { Notifier, loadVapid, pushFor } from "../src/push.ts";
import type { Sender } from "../src/push.ts";
import { LABEL, agentPath, cliLoginWarning, dropStaleClaudePath, install, parseLaunchctlPrint, plist, putClaudeOnPath, specFor, uninstall } from "../src/service.ts";
import { insideDesktopClaudeCache, withoutDesktopClaudeCache } from "../../cli/src/claude-auth.ts";
import type { EventBody, PushSubscriptionJSON, SessionSummary } from "../src/protocol.ts";
import { posixModes, posixPaths } from "../../../test/capabilities.ts";

const tmp = (t: { after(fn: () => void): void }): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ripple-host-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// ---- launchd -------------------------------------------------------------------------------------

test("the plist runs this checkout's main.ts with an absolute node, KeepAlive, a 10 s throttle and one log", () => {
  const spec = specFor({ script: "/Users/me/Ripple & Co/packages/remote/src/main.ts", claudePath: "/Users/me/.local/bin/claude", node: "/opt/node/bin/node", home: "/Users/me" });
  const xml = plist(spec);
  assert.match(xml, new RegExp(`<key>Label</key>\\s*<string>${LABEL}</string>`));
  const args = [...xml.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
  const start = args.indexOf("/opt/node/bin/node");
  assert.deepEqual(args.slice(start, start + 3), ["/opt/node/bin/node", "--disable-warning=ExperimentalWarning", "/Users/me/Ripple &amp; Co/packages/remote/src/main.ts"]);
  assert.deepEqual(spec.args, [], "the service must read saved settings, not overwrite bind on restart");
  assert.equal(args.includes("--bind"), false);
  assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(xml, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(xml, /<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/);
  assert.match(xml, /<key>ProcessType<\/key>\s*<string>Interactive<\/string>/);
  assert.match(xml, /<key>HOME<\/key>\s*<string>\/Users\/me<\/string>/);
  if (posixPaths) {
    assert.match(xml, /<key>StandardOutPath<\/key>\s*<string>\/Users\/me\/\.clauderipple\/logs\/host\.log<\/string>/);
    assert.match(xml, /<key>StandardErrorPath<\/key>\s*<string>\/Users\/me\/\.clauderipple\/logs\/host\.log<\/string>/);
    assert.match(xml, /<key>WorkingDirectory<\/key>\s*<string>\/Users\/me\/Ripple &amp; Co<\/string>/);
    // `claude` and node are found without a login shell's PATH.
    const pathValue = /<key>PATH<\/key>\s*<string>([^<]*)<\/string>/.exec(xml)![1]!.split(":");
    assert.equal(pathValue[0], "/Users/me/.local/bin");
    assert.equal(pathValue[1], "/opt/node/bin");
    assert.ok(pathValue.includes("/usr/bin") && pathValue.includes("/bin"));
  }
});

// The launchd agent's PATH: other platforms pass the inherited PATH through.
test("agentPath has no duplicates and works without a claude", { skip: process.platform !== "darwin" && "launchd only" }, () => {
  assert.equal(agentPath(undefined, "/usr/local/bin/node"), "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin");
});

// #162: the Windows launcher kept `...\claude-code\2.1.304\<hash>` on PATH after the app moved on,
// and findClaude reads PATH before the cache.
const WIN_CACHE = ["C:\\Users\\me\\AppData\\Local\\Claude\\claude-code", "C:\\Users\\me\\AppData\\Local\\Claude-Data\\Claude_x\\claude-code"];
const STALE_WIN = "C:\\Users\\me\\AppData\\Local\\Claude\\claude-code\\2.1.304\\0123456789ab";

test("agentPath leaves Claude Desktop's versioned CLI cache out of the baked PATH on every platform", () => {
  const baked = agentPath(`${STALE_WIN}\\claude.exe`, "C:\\Program Files\\nodejs\\node.exe", { platform: "win32", cacheRoots: WIN_CACHE, pathValue: `${STALE_WIN};C:\\Tools;c:\\users\\me\\appdata\\local\\claude\\claude-code\\2.1.310\\ffff;C:\\Tools;"C:\\Program Files\\Git\\cmd"` });
  assert.equal(baked, 'C:\\Program Files\\nodejs;C:\\Tools;"C:\\Program Files\\Git\\cmd"');
  assert.equal(agentPath("/usr/local/bin/claude", "/usr/bin/node", { platform: "linux", cacheRoots: ["/home/me/.config/Claude/claude-code"], pathValue: "/home/me/.config/Claude/claude-code/2.1.304:/home/me/bin:/usr/bin" }), "/usr/local/bin:/usr/bin:/home/me/bin");
  // macOS bakes a fixed list; a launcher inside the app's cache is the one entry it must not keep.
  const mac = "/Users/me/Library/Application Support/Claude/claude-code";
  assert.equal(agentPath(`${mac}/2.1.304/claude.app/Contents/MacOS/claude`, "/opt/node/bin/node", { platform: "darwin", cacheRoots: [mac] }), "/opt/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin");
});

test("only directories inside the cache are stale: lookalike names, other drives and relative entries stay", () => {
  const root = WIN_CACHE[0]!;
  assert.equal(insideDesktopClaudeCache(root, WIN_CACHE, "win32"), true);
  assert.equal(insideDesktopClaudeCache(`${root}\\`, WIN_CACHE, "win32"), true);
  assert.equal(insideDesktopClaudeCache(`"${STALE_WIN}"`, WIN_CACHE, "win32"), true);
  assert.equal(insideDesktopClaudeCache(STALE_WIN.toUpperCase(), WIN_CACHE, "win32"), true, "Windows paths compare without case");
  assert.equal(insideDesktopClaudeCache(`${root}-old\\2.1.304`, WIN_CACHE, "win32"), false);
  assert.equal(insideDesktopClaudeCache("D:\\Claude\\claude-code\\2.1.304", WIN_CACHE, "win32"), false);
  assert.equal(insideDesktopClaudeCache("claude-code\\2.1.304", WIN_CACHE, "win32"), false);
  assert.equal(insideDesktopClaudeCache("", WIN_CACHE, "win32"), false);
  assert.equal(insideDesktopClaudeCache("/home/me/.config/claude/claude-code/2.1.304", ["/home/me/.config/Claude/claude-code"], "linux"), false, "POSIX paths are case-sensitive");
  assert.equal(insideDesktopClaudeCache("/home/me/.config/Claude/claude-code-2/2.1.304", ["/home/me/.config/Claude/claude-code"], "linux"), false);
  assert.equal(withoutDesktopClaudeCache(`${STALE_WIN};;C:\\Tools`, WIN_CACHE, "win32"), ";C:\\Tools", "an empty entry keeps its place");
});

test("a host that starts with a stale PATH entry drops it and puts the launcher it found first", () => {
  const env: Record<string, string | undefined> = { Path: `${STALE_WIN};C:\\Tools;C:\\Windows\\System32` };
  dropStaleClaudePath(env, { platform: "win32", cacheRoots: WIN_CACHE });
  assert.deepEqual(env, { Path: "C:\\Tools;C:\\Windows\\System32" }, "the Windows spelling of the variable is kept");
  putClaudeOnPath(env, "C:\\Users\\me\\AppData\\Local\\Claude\\claude-code\\2.1.310\\aaaa1111bbbb\\claude.exe", "win32");
  assert.equal(env.Path, "C:\\Users\\me\\AppData\\Local\\Claude\\claude-code\\2.1.310\\aaaa1111bbbb;C:\\Tools;C:\\Windows\\System32");
  putClaudeOnPath(env, "c:\\tools\\claude.exe", "win32");
  assert.equal(env.Path, "c:\\tools;C:\\Users\\me\\AppData\\Local\\Claude\\claude-code\\2.1.310\\aaaa1111bbbb;C:\\Windows\\System32", "the directory moves to the front, never twice");
  const posix: Record<string, string | undefined> = { PATH: "/a:/usr/bin" };
  putClaudeOnPath(posix, "/usr/bin/claude", "linux");
  putClaudeOnPath(posix, undefined, "linux");
  assert.equal(posix.PATH, "/usr/bin:/a");
  const none: Record<string, string | undefined> = {};
  dropStaleClaudePath(none, { platform: "linux", cacheRoots: ["/x"] });
  assert.deepEqual(none, {}, "no PATH stays no PATH");
});

test("install replaces a loaded agent and bootstraps; uninstall boots out and removes", (t) => {
  const dir = tmp(t);
  const p = { home: dir, plist: path.join(dir, "LaunchAgents", `${LABEL}.plist`), log: path.join(dir, "logs", "host.log") };
  const calls: string[][] = [];
  let loaded = true;
  const run = (cmd: string, args: string[]): { status: number; out: string } => {
    calls.push([cmd, ...args]);
    if (args[0] === "print") return loaded ? { status: 0, out: "state = running\n\tpid = 42\n" } : { status: 113, out: "not found" };
    if (args[0] === "bootout") loaded = false;
    if (args[0] === "bootstrap") loaded = true;
    return { status: 0, out: "" };
  };
  const spec = { ...specFor({ script: "/x/packages/remote/src/main.ts", claudePath: undefined, node: "/n/node", home: dir }), log: p.log };
  fs.mkdirSync(path.dirname(p.plist), { recursive: true });
  fs.writeFileSync(p.plist, plist(spec));
  install(spec, run, p);
  assert.deepEqual(calls.map((c) => c[1]), ["print", "bootout", "bootstrap"]);
  assert.equal(calls[2]![3], p.plist);
  assert.equal(fs.readFileSync(p.plist, "utf8"), plist(spec));
  assert.ok(fs.existsSync(path.dirname(p.log)));
  calls.length = 0;
  uninstall(run, p);
  assert.deepEqual(calls.map((c) => c[1]), ["print", "bootout"]);
  assert.equal(fs.existsSync(p.plist), false);
});

test("host uninstall preserves its definition on launchctl lookup or bootout failures", t => {
  const dir = tmp(t);
  const p = { home: dir, plist: path.join(dir, "host.plist"), log: path.join(dir, "host.log") };
  for (const failure of ["print", "bootout"]) {
    fs.writeFileSync(p.plist, "owned definition");
    const result = uninstall((_cmd, args) => ({ status: args[0] === failure ? 1 : 0, out: "permission denied" }), p);
    assert.equal(result.state, failure === "print" ? "lookup-failed" : "stop-failed");
    assert.equal(fs.readFileSync(p.plist, "utf8"), "owned definition");
  }
  const result = uninstall(() => ({ status: 113, out: "" }), p);
  assert.equal(result.state, "removed");
  assert.equal(fs.existsSync(p.plist), false);
});

test("install retries a bootstrap launchd refuses while the old agent is still going away", (t) => {
  const dir = tmp(t);
  const p = { home: dir, plist: path.join(dir, "LaunchAgents", `${LABEL}.plist`), log: path.join(dir, "logs", "host.log") };
  let refusals = 2;
  const calls: string[] = [];
  const run = (cmd: string, args: string[]): { status: number; out: string } => {
    calls.push(args[0] ?? cmd);
    if (args[0] === "print") return { status: 113, out: "not found" };
    if (args[0] === "bootstrap" && refusals-- > 0) return { status: 5, out: "Bootstrap failed: 5: Input/output error" };
    return { status: 0, out: "" };
  };
  const spec = { ...specFor({ script: "/x/packages/remote/src/main.ts", claudePath: undefined, node: "/n/node", home: dir }), log: p.log };
  install(spec, run, p);
  assert.deepEqual(calls, ["print", "bootstrap", "0.5", "bootstrap", "0.5", "bootstrap"]);
});

test("launchctl print: state, pid and last exit are read from the first matching lines", () => {
  const out = "gui/501/x = {\n\tactive count = 1\n\tstate = running\n\n\tpid = 15580\n\tlast exit code = 75: EX_TEMPFAIL\n\tendpoints = {\n\t\tstate = active\n";
  assert.deepEqual(parseLaunchctlPrint(out), { state: "running", pid: 15580, lastExit: "75: EX_TEMPFAIL" });
  assert.deepEqual(parseLaunchctlPrint(""), { state: null, pid: null, lastExit: null });
});

// ---- the Claude Code login the host needs (issue #71) ---------------------------------------------

test("the install warning names the binary to run, and a machine with a login says nothing", () => {
  const warning = cliLoginWarning({ ok: false, where: "no Claude Code login" }, "/Applications/Claude/claude.app/Contents/MacOS/claude");
  assert.ok(warning);
  assert.match(warning, /\/login/);
  assert.match(warning, /\/Applications\/Claude\/claude/);
  assert.equal(warning.includes("\n"), false, "one line");
  assert.equal(cliLoginWarning({ ok: true, where: "the macOS keychain" }, "/x/claude"), null);
});

// ---- power ---------------------------------------------------------------------------------------

function fakeSpawner() {
  const spawned: { cmd: string; args: string[]; killed: boolean; exit: () => void }[] = [];
  const spawner = (cmd: string, args: string[]): Held => {
    const exits: (() => void)[] = [];
    const rec = { cmd, args, killed: false, exit: () => { for (const fn of exits) fn(); } };
    spawned.push(rec);
    return { kill: () => { rec.killed = true; rec.exit(); }, onExit: (fn) => { exits.push(fn); } };
  };
  return { spawned, spawner };
}

test("caffeinate is held once while any turn runs and released when none does", () => {
  const { spawned, spawner } = fakeSpawner();
  // caffeinate is the Mac's: named so the test also runs on the Linux CI runner.
  const power = new PowerHold({ platform: "darwin", spawner, pid: 4242 });
  power.update(false);
  assert.equal(spawned.length, 0);
  power.update(true);
  power.update(true);
  assert.equal(spawned.length, 1, "one assertion for any number of busy updates");
  assert.deepEqual([spawned[0]!.cmd, ...spawned[0]!.args], ["/usr/bin/caffeinate", "-i", "-w", "4242"]);
  assert.equal(power.holding, true);
  power.update(false);
  assert.equal(spawned[0]!.killed, true);
  assert.equal(power.holding, false);
  power.update(true);
  assert.equal(spawned.length, 2);
  power.release();
  assert.equal(spawned[1]!.killed, true);
});

test("a caffeinate killed by someone else is taken again while a turn still runs, not in a tight loop", async () => {
  const { spawned, spawner } = fakeSpawner();
  const power = new PowerHold({ platform: "darwin", spawner, retryMs: 20 });
  power.update(true);
  spawned[0]!.exit();
  assert.equal(power.holding, false);
  assert.equal(spawned.length, 1, "not at once");
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(spawned.length, 2);
  assert.equal(power.holding, true);
  power.release();
  spawned[1]!.exit();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(spawned.length, 2, "released: nothing taken again");
});

// ---- push ----------------------------------------------------------------------------------------

const summary: SessionSummary = { id: "s1", title: "고쳐 줘 로그인 버그", cwd: "/Users/me/app", model: "m", effort: null, state: "running", pending: 1, createdAt: 0, updatedAt: 0, lastSeq: 1, epoch: "e" };
const sub = (n: number): PushSubscriptionJSON => ({ endpoint: `https://push.example/${n}`, keys: { p256dh: "BPk", auth: "au" } });
const perm: EventBody = { kind: "permission", id: "p1", tool: "Bash", title: "", summary: "rm -rf build", input: "rm -rf build", canAlways: false };

test("the three moments push only the session title plus fixed state words; other events make none", () => {
  const secret = "rm -rf build";
  const p = pushFor(perm, summary, "ko")!;
  assert.equal(p.title, "고쳐 줘 로그인 버그");
  assert.equal(p.body, "승인을 기다립니다");
  assert.equal(p.session, "s1");
  assert.ok(!JSON.stringify(p).includes(secret));
  assert.equal(pushFor({ kind: "result", ok: true, ms: 1, turns: 1 }, summary, "ko")!.body, "작업을 마쳤습니다");
  const failed = pushFor({ kind: "result", ok: false, error: "API Error: 529", ms: 1, turns: 0 }, summary, "ko")!;
  assert.equal(failed.title, "고쳐 줘 로그인 버그");
  assert.equal(failed.body, "작업이 실패했습니다");
  assert.ok(!JSON.stringify(failed).includes("API Error: 529"));
  assert.equal(pushFor({ kind: "result", ok: true, ms: 1, turns: 1 }, summary, "en")!.body, "Work finished");
  assert.equal(pushFor(perm, summary, "en")!.body, "Waiting for approval");
  for (const e of [{ kind: "state", state: "idle" }, { kind: "notice", code: "interrupted" }, { kind: "delta", msg: "m", text: "x" }] as EventBody[]) assert.equal(pushFor(e, summary, "ko"), null);
});

function notifier(t: { after(fn: () => void): void }, send: Sender, seen = new Map<string, number>(), now = () => 1_000_000) {
  const dir = tmp(t);
  const logs: string[] = [];
  const n = new Notifier({ dir, send, seenRecently: (session) => now() - (seen.get(session) ?? 0) < 180_000, summary: (id) => (id === "s1" ? summary : undefined), log: (l) => logs.push(l) });
  return { n, dir, logs, seen };
}

test("pushes go to every device only when nobody saw that session in the last 180 s", async (t) => {
  const sent: { endpoint: string; payload: { title: string; body: string; session: string }; urgency: string }[] = [];
  const { n, seen } = notifier(t, async (s, payload, o) => { sent.push({ endpoint: s.endpoint, payload: JSON.parse(payload), urgency: o.urgency }); });
  n.subscribe("phone-a", sub(1), "ko");
  n.subscribe("phone-b", sub(2), "en");
  seen.set("s1", 1_000_000 - 179_000);
  await n.onEvent("s1", perm);
  assert.equal(sent.length, 0, "a phone saw this session 179 s ago: no push");
  seen.set("s1", 1_000_000 - 181_000);
  await n.onEvent("s1", perm);
  assert.deepEqual(sent.map((s) => s.endpoint).sort(), ["https://push.example/1", "https://push.example/2"]);
  assert.ok(sent.every((s) => s.urgency === "high" && s.payload.session === "s1"));
  assert.equal(sent.find((s) => s.endpoint.endsWith("/2"))!.payload.body, "Waiting for approval");
  sent.length = 0;
  // Another session the phone never saw still pushes: suppression is per session.
  seen.set("other", 1_000_000);
  await n.onEvent("s1", { kind: "state", state: "idle" });
  await n.onEvent("nope", perm);
  assert.equal(sent.length, 0);
});

test("a web push says what the turn did, as the native push does, and falls back to the fixed words", async (t) => {
  const sent: { title: string; body: string }[] = [];
  const dir = tmp(t);
  const send: Sender = async (_s, payload) => { sent.push(JSON.parse(payload)); };
  let calls = 0;
  const n = new Notifier({ dir, send, seenRecently: () => false, summary: (id) => (id === "s1" ? summary : undefined),
    context: () => { calls++; return { title: summary.title, cwd: summary.cwd, text: "**로그인 버그**를 고쳤습니다" }; } });
  n.subscribe("a", sub(1), "ko");
  n.subscribe("b", sub(2), "ko");
  await n.onEvent("s1", { kind: "result", ok: true, ms: 1, turns: 1 });
  assert.deepEqual(sent.map((p) => p.body), ["로그인 버그를 고쳤습니다", "로그인 버그를 고쳤습니다"]);
  assert.equal(sent[0]!.title, "고쳐 줘 로그인 버그");
  assert.equal(calls, 1, "the context is read once per event, not per device");
  sent.length = 0;
  const broken = new Notifier({ dir: tmp(t), send, seenRecently: () => false, summary: () => summary, context: () => { throw new Error("unreadable"); } });
  broken.subscribe("a", sub(1), "ko");
  await broken.onEvent("s1", { kind: "result", ok: true, ms: 1, turns: 1 });
  assert.equal(sent[0]!.body, "작업을 마쳤습니다");
});

test("a subscription the push service calls gone (404/410) is removed; other failures keep it", async (t) => {
  const status = new Map<string, number>([["https://push.example/1", 410], ["https://push.example/2", 500], ["https://push.example/3", 404]]);
  const { n, dir, logs } = notifier(t, async (s) => { const code = status.get(s.endpoint); if (code) throw Object.assign(new Error(`HTTP ${code}`), { statusCode: code }); });
  n.subscribe("a", sub(1), "ko");
  n.subscribe("b", sub(2), "ko");
  n.subscribe("c", sub(3), "ko");
  await n.onEvent("s1", { kind: "result", ok: true, ms: 1, turns: 1 });
  assert.deepEqual(n.devices(), ["b"]);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, "push.json"), "utf8"))), ["b"], "persisted");
  assert.equal(logs.filter((l) => l.includes("removed")).length, 2);
  // One device, one subscription: subscribing again replaces it.
  n.subscribe("b", sub(4), "ko");
  assert.deepEqual(n.devices(), ["b"]);
  assert.throws(() => n.subscribe("d", { endpoint: "http://plain.example", keys: { p256dh: "x", auth: "y" } }, "ko"), /invalid/);
});

test("VAPID keys are made once, kept 0600, and survive a reload", (t) => {
  const dir = tmp(t);
  const a = loadVapid(dir, "mailto:x@example.invalid");
  const b = loadVapid(dir, "https://relay.example");
  assert.equal(a.publicKey, b.publicKey);
  assert.equal(b.subject, "https://relay.example");
  if (posixModes) assert.equal(fs.statSync(path.join(dir, "vapid.json")).mode & 0o777, 0o600);
  assert.equal(Buffer.from(a.publicKey, "base64url").length, 65, "an uncompressed P-256 point");
});
