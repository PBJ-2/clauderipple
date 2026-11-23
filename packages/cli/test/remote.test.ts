// `remote add|remove` against a fake host: the runner records the ssh argv and runs the script it
// was given in a local POSIX sh with HOME set to a temp "remote home", so the real scripts —
// merge, backup, guard, agent bookkeeping — are what is exercised. No ssh is started.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SshRunner } from "../../router/src/remote-host.ts";

const work = fs.mkdtempSync(path.join(os.tmpdir(), "cr-remote-cli-"));
// Nothing here may reach the real ~/.clauderipple or ~/.claude.
process.env.CLAUDERIPPLE_HOME = path.join(work, "never-used-home");
process.env.CLAUDE_SETTINGS_PATH = path.join(work, "never-used-settings.json");
delete process.env.CLAUDERIPPLE_SSH_OPTIONS;
const { remoteAdd, remoteRemove, configuredHosts, mergeRemoteSettings, updateHosts } = await import("../src/remote.ts");

const CA = "-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----\n";
const noSh = process.platform === "win32" ? "needs a POSIX sh" : false;

function fixture(name: string, agents: Record<string, string>) {
  const root = path.join(work, name);
  const home = path.join(root, "home");
  const agentDir = path.join(root, "agents");
  const remoteHome = path.join(root, "remote");
  for (const d of [home, agentDir, remoteHome]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(home, "ca.pem"), CA);
  fs.writeFileSync(path.join(home, "ca.key"), "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----\n");
  const configFile = path.join(home, "config.json");
  fs.writeFileSync(configFile, JSON.stringify({ listen: { host: "127.0.0.1", port: 8791 }, providers: {} }, null, 2));
  const setAgents = (a: Record<string, string>) => {
    for (const f of fs.readdirSync(agentDir)) fs.rmSync(path.join(agentDir, f));
    for (const [n, body] of Object.entries(a)) fs.writeFileSync(path.join(agentDir, `${n}.md`), body);
    fs.writeFileSync(path.join(home, "generated-agents.json"), JSON.stringify({ agents: Object.keys(a) }));
  };
  setAgents(agents);
  const calls: string[][] = [];
  const run: SshRunner = async (args, opts) => {
    calls.push(args);
    const r = spawnSync("sh", ["-s"], { input: opts?.input ?? "", env: { ...process.env, HOME: remoteHome }, encoding: "utf8" });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const out: string[] = [];
  const opts = { run, home, agentDir, configFile, adminUrl: null, print: (l: string) => out.push(l) };
  const remote = (rel: string) => path.join(remoteHome, rel);
  const read = (rel: string) => fs.readFileSync(remote(rel), "utf8");
  return { opts, calls, out, remote, read, remoteHome, setAgents, configFile };
}

test("remote add: ssh argv, CA, settings merge with a one-time backup, agents, config", { skip: noSh }, async () => {
  const f = fixture("add", { "gpt-x": "---\nname: gpt-x\n---\nbody x\n", "deep-y": "---\nname: deep-y\n---\nbody y\n" });
  fs.mkdirSync(f.remote(".claude/agents"), { recursive: true });
  const original = JSON.stringify({ model: "opus", env: { FOO: "1" }, permissions: { allow: ["Bash"] } }, null, 2);
  fs.writeFileSync(f.remote(".claude/settings.json"), original);
  fs.writeFileSync(f.remote(".claude/agents/deep-y.md"), "hand-written\n"); // same name, not ours

  await remoteAdd("me@box", { ...f.opts, port: 18799 });

  // The host is one argv element, never a shell string; the script travels on stdin.
  for (const args of f.calls) assert.deepEqual(args, ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "me@box", "sh", "-s"]);
  assert.equal(f.calls.length, 2, "one look, one write");

  assert.equal(f.read(".clauderipple-remote/ca.pem"), CA);
  assert.ok(!fs.readdirSync(f.remote(".clauderipple-remote")).some((n) => n.includes("key")), "no key travels");
  const s = JSON.parse(f.read(".claude/settings.json"));
  assert.deepEqual(s.env, { FOO: "1", HTTPS_PROXY: "http://127.0.0.1:18799", NODE_EXTRA_CA_CERTS: `${f.remoteHome}/.clauderipple-remote/ca.pem` });
  assert.equal(s.model, "opus");
  assert.deepEqual(s.permissions, { allow: ["Bash"] });
  assert.equal(f.read(".claude/settings.json.clauderipple-backup"), original);

  assert.equal(f.read(".claude/agents/gpt-x.md"), "---\nname: gpt-x\n---\nbody x\n");
  assert.equal(f.read(".claude/agents/deep-y.md"), "hand-written\n", "someone else's agent is left alone");
  assert.deepEqual(JSON.parse(f.read(".clauderipple-remote/agents.json")), {
    agents: ["gpt-x"], proxyUrl: "http://127.0.0.1:18799", caPath: `${f.remoteHome}/.clauderipple-remote/ca.pem`,
  });
  assert.ok(f.out.some((l) => l.includes("deep-y.md") && l.includes("not ours")));
  assert.deepEqual(configuredHosts(f.configFile), [{ host: "me@box", port: 18799 }]);
  assert.ok(!fs.readdirSync(f.remote(".claude")).some((n) => n.includes("clauderipple-tmp")), "no temp files left");

  // Again, after the remote settings changed by hand: the backup is not replaced.
  const edited = { ...s, theme: "dark" };
  fs.writeFileSync(f.remote(".claude/settings.json"), JSON.stringify(edited));
  await remoteAdd("me@box", { ...f.opts, port: 18799 });
  assert.equal(f.read(".claude/settings.json.clauderipple-backup"), original, "backup made once");
  assert.ok(f.out.some((l) => l.includes("already points at the tunnel")));
  assert.equal(f.read(".claude/settings.json"), JSON.stringify(edited), "nothing to change: not rewritten");
});

test("remote add: a different HTTPS_PROXY is refused without --force and nothing is written", { skip: noSh }, async () => {
  const f = fixture("foreign", { "gpt-x": "x\n" });
  fs.mkdirSync(f.remote(".claude"), { recursive: true });
  fs.writeFileSync(f.remote(".claude/settings.json"), JSON.stringify({ env: { HTTPS_PROXY: "http://corp:3128" } }));
  await assert.rejects(remoteAdd("box", f.opts), /box: settings\.json env\.HTTPS_PROXY is already "http:\/\/corp:3128".*--force/);
  assert.equal(fs.existsSync(f.remote(".clauderipple-remote")), false);
  assert.deepEqual(configuredHosts(f.configFile), []);

  await remoteAdd("box", { ...f.opts, force: true });
  assert.equal(JSON.parse(f.read(".claude/settings.json")).env.HTTPS_PROXY, "http://127.0.0.1:18791");
  assert.ok(f.out.some((l) => l.includes("replaced HTTPS_PROXY http://corp:3128")));
});

test("remote add: settings.json changed between the look and the write → refused, nothing half done", { skip: noSh }, async () => {
  const f = fixture("race", { "gpt-x": "x\n" });
  fs.mkdirSync(f.remote(".claude"), { recursive: true });
  fs.writeFileSync(f.remote(".claude/settings.json"), "{}");
  // The first call is the look; the change lands before the second (the write).
  let calls = 0;
  const run: SshRunner = async (args, o) => {
    if (++calls === 2) fs.writeFileSync(f.remote(".claude/settings.json"), JSON.stringify({ model: "sonnet" }));
    return f.opts.run(args, o);
  };
  await assert.rejects(remoteAdd("box", { ...f.opts, run }), /changed while it was being edited/);
  assert.deepEqual(JSON.parse(f.read(".claude/settings.json")), { model: "sonnet" });
  assert.equal(fs.existsSync(f.remote(".clauderipple-remote")), false);
});

test("remote add: invalid remote JSON is not overwritten", { skip: noSh }, async () => {
  const f = fixture("badjson", {});
  fs.mkdirSync(f.remote(".claude"), { recursive: true });
  fs.writeFileSync(f.remote(".claude/settings.json"), "{ nope");
  await assert.rejects(remoteAdd("box", f.opts), /not valid JSON/);
  assert.equal(f.read(".claude/settings.json"), "{ nope");
});

test("remote add: no settings.json yet — created, no backup", { skip: noSh }, async () => {
  const f = fixture("fresh", {});
  await remoteAdd("box", f.opts);
  assert.equal(JSON.parse(f.read(".claude/settings.json")).env.HTTPS_PROXY, "http://127.0.0.1:18791");
  assert.equal(fs.existsSync(f.remote(".claude/settings.json.clauderipple-backup")), false);
});

test("re-sync after the agent list changed: dropped workers removed, new ones written", { skip: noSh }, async () => {
  const f = fixture("resync", { a: "a\n", b: "b\n" });
  await remoteAdd("box", f.opts);
  f.setAgents({ b: "b2\n", c: "c\n" });
  await remoteAdd("box", f.opts);
  assert.equal(fs.existsSync(f.remote(".claude/agents/a.md")), false);
  assert.equal(f.read(".claude/agents/b.md"), "b2\n");
  assert.equal(f.read(".claude/agents/c.md"), "c\n");
  assert.deepEqual(JSON.parse(f.read(".clauderipple-remote/agents.json")).agents, ["b", "c"]);
});

test("remote remove: our env keys, our agent files and our directory go; everything else stays", { skip: noSh }, async () => {
  const f = fixture("remove", { "gpt-x": "x\n" });
  fs.mkdirSync(f.remote(".claude/agents"), { recursive: true });
  fs.writeFileSync(f.remote(".claude/settings.json"), JSON.stringify({ model: "opus", env: { FOO: "1" } }));
  fs.writeFileSync(f.remote(".claude/agents/mine.md"), "hand\n");
  await remoteAdd("me@box", { ...f.opts, port: 18800 });
  // Remove reads what to undo from the host's record, even with the port gone from the config.
  await remoteRemove("me@box", f.opts);
  assert.deepEqual(JSON.parse(f.read(".claude/settings.json")), { model: "opus", env: { FOO: "1" } });
  assert.equal(fs.existsSync(f.remote(".claude/agents/gpt-x.md")), false);
  assert.equal(f.read(".claude/agents/mine.md"), "hand\n");
  assert.equal(fs.existsSync(f.remote(".clauderipple-remote")), false);
  assert.ok(fs.existsSync(f.remote(".claude/settings.json.clauderipple-backup")), "the user's original stays");
  assert.deepEqual(configuredHosts(f.configFile), []);

  // An env changed by hand since: only values that are still ours are removed.
  await remoteAdd("me@box", { ...f.opts, port: 18800 });
  const s = JSON.parse(f.read(".claude/settings.json"));
  s.env.HTTPS_PROXY = "http://elsewhere:1";
  fs.writeFileSync(f.remote(".claude/settings.json"), JSON.stringify(s));
  await remoteRemove("me@box", f.opts);
  assert.deepEqual(JSON.parse(f.read(".claude/settings.json")).env, { FOO: "1", HTTPS_PROXY: "http://elsewhere:1" });
  assert.ok(f.out.some((l) => l.includes("left HTTPS_PROXY=http://elsewhere:1 (not ours)")));
});

test("unreachable host: the error says to set up key-based ssh; nothing saved", async () => {
  const f = fixture("unreachable", {});
  const run: SshRunner = async () => ({ code: 255, stdout: "", stderr: "me@box: Permission denied (publickey,password).\n" });
  await assert.rejects(remoteAdd("me@box", { ...f.opts, run }), (e: Error) => /Permission denied/.test(e.message) && /key-based/.test(e.message) && /ssh-copy-id me@box/.test(e.message));
  assert.deepEqual(configuredHosts(f.configFile), []);
});

test("bad hosts never reach ssh", async () => {
  const f = fixture("badhost", {});
  let ran = 0;
  const run: SshRunner = async () => { ran++; return { code: 0, stdout: "", stderr: "" }; };
  for (const host of ["-oProxyCommand=touch /tmp/pwned", "a b", "a;b", "$(id)"]) {
    await assert.rejects(remoteAdd(host, { ...f.opts, run }));
    await assert.rejects(remoteRemove(host, { ...f.opts, run }));
  }
  assert.equal(ran, 0);
  await assert.rejects(remoteAdd("box", { ...f.opts, run, port: 0 }), /--port/);
});

test("updateHosts takes the config lock before changing the file", () => {
  const root = path.join(work, "host-lock");
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, "config.json");
  fs.writeFileSync(file, JSON.stringify({ providers: {}, remote: { hosts: [] } }, null, 2));
  const before = fs.readFileSync(file);
  fs.mkdirSync(`${file}.lock`);
  try {
    assert.throws(() => updateHosts(file, (hosts) => [...hosts, { host: "box", port: 18791 }]), (error: NodeJS.ErrnoException) => error.code === "ELOCKED");
    assert.deepEqual(fs.readFileSync(file), before);
  } finally {
    fs.rmSync(`${file}.lock`, { recursive: true, force: true });
  }
});

test("mergeRemoteSettings is idempotent and keeps unrelated keys", () => {
  const want = { proxyUrl: "http://127.0.0.1:1", caPath: "/h/.clauderipple-remote/ca.pem" };
  const first = mergeRemoteSettings(JSON.stringify({ a: 1, env: { B: "2" } }), "box", want, false);
  assert.deepEqual(JSON.parse(first.content!), { a: 1, env: { B: "2", HTTPS_PROXY: want.proxyUrl, NODE_EXTRA_CA_CERTS: want.caPath } });
  assert.equal(mergeRemoteSettings(first.content, "box", want, false).content, null);
});
