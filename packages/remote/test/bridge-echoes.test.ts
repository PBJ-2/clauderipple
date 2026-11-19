import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { bridgeFixture, bridgeId, environmentSession, line, tick } from "./bridge-fixture.ts";

const echoes = (f: ReturnType<typeof bridgeFixture>): Set<string> =>
  (f.sessions as unknown as { bridgeEchoes: Set<string> }).bridgeEchoes;

// The host posts to a bridge only for a session it created itself in a Remote Control environment: a post to
// an app session the person opened is dropped by the CLI (#177), so these tests use the first kind.
test("a matched Remote Control echo is deleted, not kept forever", async t => {
  const f = bridgeFixture(t);
  f.sessions.log(bridgeId);
  environmentSession(f);
  await tick(); await tick();
  // A UUID-shaped phone id is its own echo uuid.
  const clientMsgId = "12345678-1234-4234-8234-1234567890ab";
  await f.sessions.send(bridgeId, clientMsgId, "hello");
  assert.ok(echoes(f).has(clientMsgId));
  const before = echoes(f).size;

  fs.appendFileSync(f.file, line({ type: "user", uuid: clientMsgId, message: { content: "hello" } }));
  await f.sessions.pollDesktop();
  assert.ok(!echoes(f).has(clientMsgId));
  assert.ok(echoes(f).size < before);
  const users = f.sessions.log(bridgeId).tail().events.filter(e => e.kind === "user" && e.clientMsgId === clientMsgId);
  assert.equal(users.length, 1);
});

test("the echo set is bounded", async t => {
  const f = bridgeFixture(t);
  f.sessions.log(bridgeId);
  environmentSession(f);
  await tick(); await tick();
  const set = echoes(f);
  for (let i = 0; i < 500; i++) set.add(`old-${i}`);
  await f.sessions.send(bridgeId, "new-message", "hello");
  assert.ok(set.size <= 500);
  assert.ok(!set.has("old-0"), "oldest echo evicted");
  assert.ok(set.size > 0);
});
