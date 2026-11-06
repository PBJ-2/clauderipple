// The Claude app closes a Code-tab turn with mcp__ccd_turn__wrap_up: a recap, one question, and
// whether the session is blocked until a person answers. These tests read that mark from a
// synthetic transcript, the way the host does (a tail window, never the whole file).
import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Sessions } from "../src/sessions.ts";
import { PermissionQueue } from "../src/permissions.ts";
import { BridgeClient } from "../src/bridge-client.ts";
import type { DesktopProcess } from "../src/desktop.ts";
import { WATCH_IDLE_MS } from "../src/protocol.ts";
import type { AlertBody } from "../src/protocol.ts";
import { firstSentence, wrapUpFields, WRAP_LIMITS } from "../src/wrap-up.ts";
import { pushFor } from "../src/push.ts";
import { expoBody } from "../src/expo-push.ts";
import { pushContent } from "../src/push-content.ts";
import { bridgeFixture, bridgeId, line as bridgeLine } from "./bridge-fixture.ts";

const id = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const line = (value: unknown): string => JSON.stringify(value) + "\n";
const spoken = (uuid: string, content = "Do the thing") => ({ type: "user", uuid, cwd: "/synthetic/project", timestamp: "2026-10-12T01:00:00Z", message: { content } });
const answer = { type: "assistant", uuid: "a1", message: { id: "m1", model: "test-model", stop_reason: "end_turn", content: [{ type: "text", text: "Answer" }] } };
/** The Code tab's closing tool call, as the model writes it into the transcript. */
const wrapUp = (input: Record<string, unknown>, toolId = "toolu-wrap") => ({
  type: "assistant", uuid: `a-${toolId}`,
  message: { id: `m-${toolId}`, model: "test-model", stop_reason: "tool_use", content: [{ type: "tool_use", id: toolId, name: "mcp__ccd_turn__wrap_up", input }] },
});
const done = { type: "result", subtype: "success", is_error: false };

const idleBridge = (): BridgeClient => new BridgeClient({
  auth: () => ({ accessToken: "test", organizationUuid: "org", expiresAt: Date.now() + 60_000 }),
  fetch: async (url, options) => {
    if (String(url).includes("sort_order=")) return Response.json({ data: [] });
    if (!String(url).includes("/events/stream")) return Response.json({ worker_status: "idle" });
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      options?.signal?.addEventListener("abort", () => { try { controller.close(); } catch { /* already closed */ } }, { once: true });
    } }));
  },
});

/** A Mac session the host only reads: a transcript in a synthetic projects dir plus a registry entry. */
function fixture(t: TestContext, opts: { tail?: unknown[]; status?: DesktopProcess["status"] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wrap-up-"));
  const project = path.join(root, "projects", "project");
  fs.mkdirSync(project, { recursive: true });
  const file = path.join(project, `${id}.jsonl`);
  fs.writeFileSync(file, [spoken("u1"), answer, ...(opts.tail ?? [])].map(line).join(""));
  const registry = new Map<string, DesktopProcess>([[id, { sessionId: id, pid: 42, status: opts.status ?? "busy" }]]);
  const alerts: { session: string; body: AlertBody }[] = [];
  let now = Date.now();
  let sent = 0;
  const sessions = new Sessions({
    dir: path.join(root, "host"), now: () => now,
    desktopProjects: path.join(root, "projects"), desktopRegistry: () => registry, desktopProcesses: () => "",
    permissions: PermissionQueue.open(path.join(root, "permissions.json")), bridgeClient: idleBridge(),
    router: { status: async () => ({ ok: true, proxyEnv: {} }), figures: async () => { throw new Error("unused"); } },
    queryFn: () => { throw new Error("no SDK is spawned for a Mac session"); },
    log: () => {}, onEvent: () => {}, onSessions: () => { sent++; },
    onAlert: (session, body) => alerts.push({ session, body }),
    away: async () => true,
  });
  t.after(async () => {
    sessions.shutdown();
    await new Promise(resolve => setImmediate(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const listed = () => sessions.list().find(s => s.id === id)!;
  return {
    sessions, alerts, listed,
    write: (lines: unknown[]) => fs.appendFileSync(file, lines.map(line).join("")),
    setStatus: (status: DesktopProcess["status"]) => { registry.get(id)!.status = status; },
    advance: (ms = 4000) => { now += ms; },
    sent: () => sent,
    poll: async () => { await sessions.pollDesktop(); await new Promise(resolve => setImmediate(resolve)); },
  };
}

test("a Mac turn that closed on a wrap_up question pushes the question, not that it finished", async t => {
  const f = fixture(t, { tail: [wrapUp({ recap: "Found the leak.", ask: "Run the tests now?", blocked: true }), done] });
  await f.poll();
  assert.equal(f.alerts.length, 0, "the host's first sight of a session only seeds it");
  f.advance(); f.setStatus("idle");
  await f.poll();
  assert.deepEqual(f.alerts, [{ session: id, body: { kind: "question", ask: "Run the tests now?", blocked: true } }]);
});

test("a wrap_up without an ask, and a turn without one, keep the finished push", async t => {
  const recapOnly = fixture(t, { tail: [wrapUp({ recap: "All done." }), done] });
  await recapOnly.poll();
  recapOnly.advance(); recapOnly.setStatus("idle");
  await recapOnly.poll();
  assert.deepEqual(recapOnly.alerts.map(a => a.body), [{ kind: "result", ok: true }]);

  const plain = fixture(t, { tail: [done] });
  await plain.poll();
  plain.advance(); plain.setStatus("idle");
  await plain.poll();
  assert.deepEqual(plain.alerts.map(a => a.body), [{ kind: "result", ok: true }]);
});

test("a blocked question raises an attention the phone clears by opening the session", async t => {
  const f = fixture(t, { tail: [wrapUp({ recap: "Fixed it.", ask: "Restart the router?", blocked: true }), done] });
  await f.poll();
  f.advance(); f.setStatus("idle");
  await f.poll();
  assert.equal(f.listed().attention?.reason, "question");
  assert.equal(f.sessions.markSeen(id), true);
  assert.equal(f.listed().attention, null);
  f.advance();
  await f.poll();
  assert.equal(f.listed().attention, null, "a later poll does not raise the same question again");
});

test("opening a blocked question does not disarm the dead-man switch", async t => {
  const f = fixture(t, { tail: [wrapUp({ recap: "Fixed it.", ask: "Restart the router?", blocked: true }), done] });
  await f.poll();
  f.advance(); f.setStatus("idle");
  await f.poll();
  assert.equal(f.listed().attention?.reason, "question");
  // The turn is long over: only the unanswered question can keep the PC watched now.
  f.advance(WATCH_IDLE_MS + 1);
  assert.equal(f.sessions.workActive(), true, "a blocked question is work the person owes");
  // The phone opens the session: the unread flag clears, the question does not.
  f.sessions.markSeen(id);
  assert.equal(f.listed().attention, null);
  assert.equal(f.sessions.workActive(), true, "seeing the question is not answering it");
  // The person answers by typing in the Mac app: the question is gone with the new message.
  f.write([spoken("u2", "Yes, restart it")]);
  // Past the desktop poll's own 3 s refresh window, as the next real poll would be.
  f.advance();
  await f.poll();
  assert.equal(f.sessions.workActive(), true, "the idle tail starts when the question is answered");
  f.advance(WATCH_IDLE_MS + 1);
  assert.equal(f.sessions.workActive(), false, "an answered question lets the idle window end");
});

test("a desktop-only turn clears stale question attention when work restarts and marks its new finish", async t => {
  const f = fixture(t, { tail: [wrapUp({ ask: "Continue?", blocked: true }), done] });
  await f.poll();
  f.advance(); f.setStatus("idle"); await f.poll();
  assert.equal(f.listed().attention?.reason, "question");
  f.write([spoken("next", "Continue")]);
  f.advance(); f.setStatus("busy"); await f.poll();
  assert.equal(f.listed().attention, null, "a question from a previous turn is not still pending");
  f.write([answer, done]);
  f.advance(); f.setStatus("idle"); await f.poll();
  assert.equal(f.listed().attention?.reason, "finished", "unopened desktop sessions use the same transition contract");
});

test("an ask that is not blocked pushes the question but only marks finished output", async t => {
  const f = fixture(t, { tail: [wrapUp({ recap: "Two options.", ask: "Which one first?" }), done] });
  await f.poll();
  f.advance(); f.setStatus("idle");
  await f.poll();
  assert.deepEqual(f.alerts.map(a => a.body), [{ kind: "question", ask: "Which one first?", blocked: false }]);
  assert.equal(f.listed().attention?.reason, "finished");
});

test("the status line is the recap's first sentence, and the list is sent only when it changes", async t => {
  const f = fixture(t, { tail: [wrapUp({ recap: "Found the leak. Fixed two files." }), done], status: "idle" });
  await f.poll();
  assert.equal(f.listed().status, "Found the leak.");
  const sent = f.sent();
  f.advance();
  await f.poll();
  f.advance();
  await f.poll();
  assert.equal(f.sent(), sent, "an unchanged status sends no list");
  f.write([spoken("u2"), wrapUp({ recap: "Tests pass. Merged." }, "toolu-wrap-2"), done]);
  f.advance();
  await f.poll();
  assert.equal(f.listed().status, "Tests pass.");
});

test("a bridged session's status and question attention are cleared by the person's next message", async t => {
  const f = bridgeFixture(t);
  f.registry.get(bridgeId)!.status = "busy";
  fs.appendFileSync(f.file, [
    bridgeLine(spoken("p1", "fix the leak")),
    bridgeLine(wrapUp({ recap: "Fixed it, tests pass. Pushed the branch.", ask: "Open the pull request?", blocked: true })),
    bridgeLine(done),
  ].join(""));
  f.sessions.log(bridgeId); // the phone opened it: the host now tails it as a bridged record
  await f.sessions.pollDesktop();
  f.registry.get(bridgeId)!.status = "idle"; f.status("idle");
  f.advance();
  await f.sessions.pollDesktop();
  const s = f.sessions.summaryOf(bridgeId)!;
  assert.equal(s.status, "Fixed it, tests pass.");
  assert.equal(s.attention?.reason, "question");
  await f.sessions.send(bridgeId, "m2", "Yes, open it.");
  const after = f.sessions.summaryOf(bridgeId)!;
  assert.equal(after.status, undefined, "a new turn is under way; its recap is not written yet");
  assert.equal(after.attention, null);
});

test("a bridged turn's result event is pushed as its question", async t => {
  const f = bridgeFixture(t);
  fs.appendFileSync(f.file, [
    bridgeLine(spoken("p1", "fix the leak")),
    bridgeLine(wrapUp({ recap: "Found it.", ask: "Fix it now?", blocked: true })),
    bridgeLine(done),
  ].join(""));
  f.sessions.log(bridgeId);
  await f.sessions.pollDesktop();
  assert.deepEqual(f.sessions.pushEvent(bridgeId, { kind: "result", ok: true }), { kind: "question", ask: "Fix it now?", blocked: true });
  const plain = { kind: "result" as const, ok: true };
  assert.deepEqual(f.sessions.pushEvent("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", plain), plain, "a session the app does not own is untouched");
});

test("the question push says what it is and carries the ask in the person's words", () => {
  const event = { kind: "question", ask: "Run the tests now?", blocked: true } as const;
  const s = { id, title: "Leak hunt", cwd: "/synthetic/project" };
  assert.deepEqual(pushFor(event, s, "ko"), { title: "Leak hunt", body: "답변이 필요합니다 · Run the tests now?", session: id, tag: `ask-${id}` });
  assert.equal(pushFor(event, s, "en")!.body, "Answer needed · Run the tests now?");
  // The Expo body travels in the clear beside the encrypted content: fixed words, never the question.
  assert.equal(expoBody(event, "ko"), "답변이 필요합니다");
  assert.equal(pushContent(event, "ko", { title: "Leak hunt" }, "x").body, "답변이 필요합니다 · Run the tests now?");
  assert.equal(expoBody({ kind: "result", ok: true }, "en"), "Work finished", "the old moments read as before");
});

test("the shared wrap_up rules cap at the app's own lengths and keep only reply buttons", () => {
  const fields = wrapUpFields({
    recap: "  Found   the leak.\nFixed two files.  ",
    ask: "x".repeat(150),
    blocked: "true",
    actions: [{ action: "commit" }, { label: "Run tests", message: "Run the tests." }, { label: "L".repeat(40) }, { label: "Third" }],
  });
  assert.equal(fields.recap, "Found the leak. Fixed two files.");
  assert.equal(fields.ask.length, WRAP_LIMITS.ask);
  assert.equal(fields.blocked, true);
  // A button without a message sends its label; an app-side button (commit) is not a reply.
  assert.deepEqual(fields.replies, [{ label: "Run tests", message: "Run the tests." }, { label: "L".repeat(WRAP_LIMITS.label), message: "L".repeat(WRAP_LIMITS.label) }]);
  assert.equal(wrapUpFields({}).blocked, false);
  assert.equal(firstSentence("Found the leak. Fixed two files.", 200), "Found the leak.");
  assert.equal(firstSentence("버그를 찾았습니다. 두 파일을 고쳤습니다.", 200), "버그를 찾았습니다.");
  assert.equal(firstSentence("no terminator here", 200), "no terminator here");
  assert.equal(firstSentence("y".repeat(400), 200).length, 200);
});
