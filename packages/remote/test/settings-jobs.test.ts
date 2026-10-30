import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { SettingsJobs, type SettingsJob } from "../src/settings-jobs.ts";
import { DesktopSettings } from "../src/desktop-settings.ts";
import { Sessions } from "../src/sessions.ts";
import { PermissionQueue } from "../src/permissions.ts";
import { BridgeClient } from "../src/bridge-client.ts";
import type { DesktopProcess } from "../src/desktop.ts";
import type { SessionEvent } from "../src/protocol.ts";

const job = (jobId: string, appSessionId = "local_target"): SettingsJob => ({ jobId, appSessionId, cliSessionId: "cli-1", model: "provider:model@high", createdAt: 1 });

test("settings jobs replace only unclaimed work, serialize writers, and retain the latest outcome", t => {
  const jobs = new SettingsJobs(); t.after(() => jobs.close());
  jobs.request(job("one")); jobs.request(job("two"));
  assert.deepEqual(jobs.pending("local_helper").map(j => j.jobId), ["two"]);
  assert.deepEqual(jobs.pending("local_target"), []);
  assert.equal(jobs.claim("one", "local_helper"), false);
  assert.equal(jobs.claim("two", "local_target"), false);
  assert.equal(jobs.result("two", "applied"), false);
  assert.equal(jobs.claim("two", "local_helper"), true);
  assert.equal(jobs.claim("two", "local_helper2"), false);
  jobs.request(job("three")); jobs.request(job("four"));
  assert.deepEqual(jobs.pending("local_helper"), []);
  assert.equal(jobs.claim("four", "local_helper"), false);
  assert.equal(jobs.result("two", "failed", "error"), true);
  assert.deepEqual(jobs.status("local_target"), { jobId: "four", outcome: "pending" });
  assert.equal(jobs.claim("four", "local_helper"), true);
  assert.equal(jobs.result("four", "applied"), true);
  assert.equal(jobs.result("four", "applied"), false);
  assert.deepEqual(jobs.status("local_target"), { jobId: "four", outcome: "applied" });
  assert.throws(() => jobs.request({ ...job("bad"), model: "bad/model" }));
  assert.throws(() => jobs.request({ jobId: "bad", appSessionId: "local_target", cliSessionId: "cli-1", createdAt: 1 }));
});

test("unclaimed jobs expire as no-helper and a claimed timeout fails without applying", async t => {
  const jobs = new SettingsJobs(20, 40); t.after(() => jobs.close());
  jobs.request(job("claimed")); assert.equal(jobs.claim("claimed", "local_helper"), true);
  jobs.request(job("waiting", "local_other"));
  await delay(70);
  assert.deepEqual(jobs.status("local_target"), { jobId: "claimed", outcome: "failed", detail: "helper result timed out" });
  assert.deepEqual(jobs.status("local_other"), { jobId: "waiting", outcome: "no-helper" });
  assert.equal(jobs.result("claimed", "applied"), false);
  assert.deepEqual(jobs.pending("local_helper"), []);
});

test("desktop session records map current CLI ids, refresh, and refuse ambiguous or damaged records", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ripple-app-settings-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "claude-code-sessions", "account", "org"); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "local_target.json");
  fs.writeFileSync(file, JSON.stringify({ sessionId: "local_target", cliSessionId: "cli-1", model: "opus", effort: "high" }));
  let now = 0; const reader = new DesktopSettings(root, () => now);
  assert.deepEqual(reader.appSettingsFor("cli-1"), { appSessionId: "local_target", model: "opus", effort: "high" });
  assert.equal(reader.appSessionIdFor("missing"), undefined);
  fs.writeFileSync(file, JSON.stringify({ cliSessionId: "cli-2", model: "sonnet" }));
  assert.equal(reader.appSessionIdFor("cli-1"), "local_target");
  now += 3001;
  assert.equal(reader.appSessionIdFor("cli-1"), undefined);
  assert.deepEqual(reader.appSettingsFor("cli-2"), { appSessionId: "local_target", model: "sonnet", effort: undefined });
  fs.writeFileSync(path.join(dir, "local_other.json"), JSON.stringify({ cliSessionId: "cli-2" })); now += 3001;
  assert.equal(reader.appSessionIdFor("cli-2"), undefined, "two records naming one CLI id: neither is guessed at");
  fs.unlinkSync(path.join(dir, "local_other.json")); fs.writeFileSync(file, "broken");
  fs.writeFileSync(path.join(dir, "local_fine.json"), JSON.stringify({ cliSessionId: "cli-3" })); now += 3001;
  assert.equal(reader.appSessionIdFor("cli-2"), undefined, "a record mid-write is left out");
  assert.equal(reader.appSessionIdFor("cli-3"), "local_fine", "and does not hide the others");
});

// 2026-10-27: on a Mac main.ts passes `desktopSidebar: {}` (no root: the app's default folder), and
// a null reader there switched model/effort sync off in production while every test passed a root.
test("Sessions reads the app's records from its default folder when the sidebar names no root", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ripple-settings-home-"));
  // os.homedir() reads USERPROFILE on Windows, HOME elsewhere.
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  Object.assign(process.env, { HOME: home, USERPROFILE: home });
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
  });
  const scope = path.join(home, "Library", "Application Support", "Claude", "claude-code-sessions", "account", "org"); fs.mkdirSync(scope, { recursive: true });
  fs.writeFileSync(path.join(scope, "local_target.json"), JSON.stringify({ cliSessionId: "cli-1", model: "old" }));
  const dir = path.join(home, "host"); fs.mkdirSync(dir);
  const sessions = new Sessions({ dir, desktopSidebar: {}, permissions: PermissionQueue.open(path.join(dir, "permissions.json")),
    router: { status: async () => ({ ok: true, proxyEnv: {} }), figures: async () => ({ effort: null, cachePct: null, contextPct: null, fiveHourPct: null, fiveHourResetAt: null, workers: [], at: 0 }) },
    queryFn: () => { throw new Error("must not launch"); }, onEvent() {}, onSessions() {} });
  t.after(() => sessions.shutdown());
  assert.equal(sessions.requestAppSettings("cli-1", { model: "new" }), true);
});

test("Sessions only queues explicitly requested fields for a mapped app record", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ripple-settings-session-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const scope = path.join(dir, "app", "claude-code-sessions", "account", "org"); fs.mkdirSync(scope, { recursive: true });
  fs.writeFileSync(path.join(scope, "local_target.json"), JSON.stringify({ cliSessionId: "cli-1", model: "old", effort: "low" }));
  const sessions = new Sessions({ dir, desktopSidebar: { root: path.join(dir, "app") }, permissions: PermissionQueue.open(path.join(dir, "permissions.json")),
    router: { status: async () => ({ ok: true, proxyEnv: {} }), figures: async () => ({ effort: null, cachePct: null, contextPct: null, fiveHourPct: null, fiveHourResetAt: null, workers: [], at: 0 }) },
    queryFn: () => { throw new Error("must not launch"); }, onEvent() {}, onSessions() {} });
  t.after(() => sessions.shutdown());
  assert.equal(sessions.requestAppSettings("missing", { model: "new" }), false);
  assert.deepEqual(sessions.settingsJobs.pending("local_helper"), []);
  const requested = { effort: "high" as const, appSessionId: "local_other", cliSessionId: "other" };
  assert.equal(sessions.requestAppSettings("cli-1", requested), true);
  const [queued] = sessions.settingsJobs.pending("local_helper");
  assert.equal(queued?.appSessionId, "local_target"); assert.equal(queued?.effort, "high"); assert.equal(queued?.model, undefined);
});

const cli = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const line = (value: unknown) => JSON.stringify(value) + "\n";

function syncFixture(t: import("node:test").TestContext, kind: "env" | "handoff" | "app", recordExists = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "settings-sync-"));
  const host = path.join(root, "host"), app = path.join(root, "app"), projects = path.join(root, "projects");
  const scope = path.join(app, "claude-code-sessions", "account", "org");
  fs.mkdirSync(scope, { recursive: true }); fs.mkdirSync(path.join(projects, "project"), { recursive: true }); fs.mkdirSync(host);
  const transcript = path.join(projects, "project", `${cli}.jsonl`);
  fs.writeFileSync(transcript, line({ type: "user", uuid: "old", cwd: root, message: { content: "hello" } }));
  const appFile = path.join(scope, "local_target.json");
  const writeApp = (model = "sonnet", effort = "xhigh") => fs.writeFileSync(appFile, JSON.stringify({ cliSessionId: cli, model, effort }));
  if (recordExists) writeApp();
  const id = kind === "app" ? cli : "phone-session";
  if (kind !== "app") fs.writeFileSync(path.join(host, "sessions.json"), JSON.stringify([{ id, sdkSessionId: kind === "env" && !recordExists ? null : cli,
    cwd: root, model: "gpt-luna", effort: "high", title: "hello", createdAt: 1, updatedAt: 1, state: "idle", createdBy: "phone", contextWindow: null,
    desktopHandoff: kind === "handoff" ? "attempted" : "excluded", ...(kind === "env" ? { desktopBridge: true, environmentBridgeId: "cse_abc" } : {}) }]));
  const registry = new Map<string, DesktopProcess>();
  if (kind === "env" && recordExists) registry.set(cli, { sessionId: cli, pid: 1, status: "idle", bridgeSessionId: "session_abc" });
  const client = new BridgeClient({ auth: () => ({ accessToken: "fake", organizationUuid: "org", expiresAt: Date.now() + 60_000 }), fetch: async (url, options) => {
    if (String(url).includes("/stream")) return new Response(new ReadableStream({ start(controller) { options?.signal?.addEventListener("abort", () => controller.close(), { once: true }); } }));
    return Response.json({ data: [], worker_status: "idle" });
  } });
  client.control = async () => {};
  let now = Date.now(); const events: SessionEvent[] = [];
  const sessions = new Sessions({ dir: host, desktopSidebar: { root: app }, desktopProjects: projects, desktopRegistry: () => registry, desktopProcesses: () => "", bridgeClient: client,
    now: () => now, settingsJobExpiryMs: 40, log() {}, permissions: PermissionQueue.open(path.join(root, "permissions.json")),
    router: { status: async () => ({ ok: true, proxyEnv: {} }), figures: async () => { throw new Error("unused"); } },
    queryFn: () => { throw new Error("must not launch"); }, onEvent: (_id, event) => events.push(event), onSessions() {} });
  t.after(async () => { sessions.shutdown(); await delay(5); fs.rmSync(root, { recursive: true, force: true }); });
  return { sessions, id, registry, appFile, writeApp, events, transcript, host, advance: () => { now += 4000; } };
}

for (const kind of ["env", "handoff", "app"] as const) test(`phone model choice queues app settings for ${kind}`, async t => {
  const f = syncFixture(t, kind);
  await f.sessions.setModel(f.id, "gpt-new", "high");
  const jobs = f.sessions.settingsJobs.pending("local_helper");
  assert.equal(jobs.length, 1);
  assert.deepEqual([jobs[0]!.cliSessionId, jobs[0]!.model, jobs[0]!.effort], [cli, "gpt-new", "high"]);
  await f.sessions.pollDesktop();
  assert.equal(f.sessions.settingsJobs.pending("local_helper").length, 1);
});

test("an app-only choice and its failure notice survive transcript growth and host restart", async t => {
  const f = syncFixture(t, "app");
  await f.sessions.setModel(f.id, "gpt-new", "high");
  const job = f.sessions.settingsJobs.pending("local_helper")[0]!;
  assert.equal(f.sessions.settingsJobs.claim(job.jobId, "local_helper"), true);
  assert.equal(f.sessions.settingsJobs.result(job.jobId, "failed"), true);
  fs.appendFileSync(f.transcript, line({ type: "assistant", uuid: "later", message: { model: "sonnet", content: [{ type: "text", text: "answer" }] } }));
  f.advance(); await f.sessions.pollDesktop();
  assert.equal(f.sessions.log(f.id).tail().events.filter(e => e.kind === "notice" && e.code === "desktop_settings_failed").length, 1);
  f.sessions.shutdown();
  const restored = new Sessions({ dir: f.host, environmentRoot: path.dirname(path.dirname(path.dirname(path.dirname(f.appFile)))),
    permissions: PermissionQueue.open(path.join(f.host, "permissions-reopened.json")),
    router: { status: async () => ({ ok: true, proxyEnv: {} }), figures: async () => { throw new Error("unused"); } },
    queryFn: () => { throw new Error("must not launch"); }, onEvent() {}, onSessions() {} });
  t.after(() => restored.shutdown());
  assert.deepEqual([restored.summaryOf(f.id)?.model, restored.summaryOf(f.id)?.effort], ["gpt-new", "high"]);
  assert.equal(restored.log(f.id).tail().events.filter(e => e.kind === "notice" && e.code === "desktop_settings_failed").length, 1);
});

test("a restart during a settings job preserves the choice and reports the unknown outcome once", async t => {
  const f = syncFixture(t, "handoff");
  await f.sessions.setModel(f.id, "gpt-new", "high");
  f.sessions.shutdown();
  const root = path.dirname(path.dirname(path.dirname(path.dirname(f.appFile))));
  const recovered = new Sessions({ dir: f.host, desktopSidebar: { root }, desktopProjects: path.dirname(path.dirname(f.transcript)),
    desktopRegistry: () => f.registry, desktopProcesses: () => "", permissions: PermissionQueue.open(path.join(f.host, "permissions-recovered.json")),
    router: { status: async () => ({ ok: true, proxyEnv: {} }), figures: async () => { throw new Error("unused"); } },
    queryFn: () => { throw new Error("must not launch"); }, log() {}, onEvent() {}, onSessions() {} });
  t.after(() => recovered.shutdown());
  await recovered.pollDesktop(); await recovered.pollDesktop();
  assert.deepEqual([recovered.summaryOf(f.id)?.model, recovered.summaryOf(f.id)?.effort], ["gpt-new", "high"]);
  const notices = recovered.log(f.id).tail().events.filter(e => e.kind === "notice" && e.code === "desktop_settings_failed");
  assert.equal(notices.length, 1);
  assert.ok(notices[0]?.kind === "notice");
  assert.equal(notices[0].text, "Claude 앱에 모델이나 추론 강도 설정이 적용되었는지 확인할 수 없습니다. Claude 앱에서 확인한 뒤 필요하면 직접 변경해 주세요.");
});

test("unsupported app effort is omitted and the phone's choice remains", async t => {
  const f = syncFixture(t, "handoff");
  await f.sessions.setModel(f.id, "gpt-new", "ultra");
  const job = f.sessions.settingsJobs.pending("local_helper")[0]!;
  assert.equal(job.effort, undefined);
  await f.sessions.pollDesktop();
  assert.equal(f.sessions.summaryOf(f.id)?.effort, "ultra");
  assert.equal(f.sessions.settingsJobs.claim(job.jobId, "local_helper"), true);
  f.writeApp("gpt-new", "xhigh"); f.advance();
  assert.equal(f.sessions.settingsJobs.result(job.jobId, "applied"), true);
  await f.sessions.pollDesktop();
  f.writeApp("opus", "xhigh"); f.advance(); await f.sessions.pollDesktop();
  assert.deepEqual([f.sessions.summaryOf(f.id)?.model, f.sessions.summaryOf(f.id)?.effort], ["opus", "ultra"]);
  f.writeApp("opus", "max"); f.advance(); await f.sessions.pollDesktop();
  assert.equal(f.sessions.summaryOf(f.id)?.effort, "max");
});

for (const kind of ["env", "handoff"] as const) test(`${kind} birth is requested once only after the app record appears`, async t => {
  const f = syncFixture(t, kind, false);
  await f.sessions.pollDesktop();
  assert.equal(f.sessions.settingsJobs.pending("local_helper").length, 0);
  f.writeApp();
  if (kind === "env") f.registry.set(cli, { sessionId: cli, pid: 1, status: "idle", bridgeSessionId: "session_abc" });
  f.advance(); await f.sessions.pollDesktop();
  const first = f.sessions.settingsJobs.pending("local_helper")[0]!;
  assert.deepEqual([first.model, first.effort], ["gpt-luna", "high"]);
  assert.equal(f.sessions.settingsJobs.claim(first.jobId, "local_helper"), true);
  f.writeApp("gpt-luna", "high"); f.advance();
  assert.equal(f.sessions.settingsJobs.result(first.jobId, "applied"), true);
  await f.sessions.pollDesktop(); await f.sessions.pollDesktop();
  assert.equal(f.sessions.settingsJobs.pending("local_helper").length, 0);
  assert.equal(f.sessions.summaryOf(f.id)?.model, "gpt-luna");
});

test("app settings synchronize after an applied job, but not while queued or claimed", async t => {
  const f = syncFixture(t, "handoff");
  await f.sessions.setModel(f.id, "gpt-new", "high");
  const job = f.sessions.settingsJobs.pending("local_helper")[0]!;
  await f.sessions.pollDesktop();
  assert.deepEqual([f.sessions.summaryOf(f.id)?.model, f.sessions.summaryOf(f.id)?.effort], ["gpt-new", "high"]);
  assert.equal(f.sessions.settingsJobs.claim(job.jobId, "local_helper"), true);
  f.advance(); await f.sessions.pollDesktop();
  assert.equal(f.sessions.summaryOf(f.id)?.model, "gpt-new");
  f.writeApp("gpt-new", "high"); f.advance();
  assert.equal(f.sessions.settingsJobs.result(job.jobId, "applied"), true);
  await f.sessions.pollDesktop();
  f.writeApp("opus", "max"); f.advance(); await f.sessions.pollDesktop();
  assert.deepEqual([f.sessions.summaryOf(f.id)?.model, f.sessions.summaryOf(f.id)?.effort], ["opus", "max"]);
  assert.equal(f.sessions.settingsJobs.pending("local_helper").length, 0);
});

for (const outcome of ["failed", "no-helper"] as const) test(`${outcome} produces one visible notice without reverting the phone`, async t => {
  const f = syncFixture(t, "handoff");
  await f.sessions.setModel(f.id, "gpt-new", "high");
  const job = f.sessions.settingsJobs.pending("local_helper")[0]!;
  if (outcome === "failed") { assert.equal(f.sessions.settingsJobs.claim(job.jobId, "local_helper"), true); assert.equal(f.sessions.settingsJobs.result(job.jobId, "failed"), true); }
  else await delay(70);
  f.advance(); await f.sessions.pollDesktop(); await f.sessions.pollDesktop();
  f.writeApp("older-job", "medium"); f.advance(); await f.sessions.pollDesktop();
  assert.deepEqual([f.sessions.summaryOf(f.id)?.model, f.sessions.summaryOf(f.id)?.effort], ["gpt-new", "high"]);
  const notices = f.sessions.log(f.id).tail().events.filter(e => e.kind === "notice" && e.code === "desktop_settings_failed");
  assert.equal(notices.length, 1);
  assert.ok(notices[0]?.kind === "notice");
  assert.equal(notices[0].text, "Claude 앱에 모델이나 추론 강도 설정을 적용하지 못했습니다. Claude 앱에서 직접 변경해 주세요.");
});
