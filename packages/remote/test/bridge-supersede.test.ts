import test from "node:test";
import assert from "node:assert/strict";
import { approval, bridgeFixture, bridgeId, environmentSession, tick } from "./bridge-fixture.ts";

// The message reaches an app session the person opened through the ripple mod (the CLI drops a host post to its
// bridge, #177), and a session Ripple created itself in a Remote Control environment over the bridge.
for (const via of ["mod", "bridge"] as const) test(`a new phone message denies waiting Mac approvals like host sessions do (${via})`, async t => {
  const f = bridgeFixture(t);
  f.sessions.log(bridgeId);
  if (via === "bridge") environmentSession(f);
  else f.sessions.modInbox.listen(bridgeId, f.now());
  await tick(); await tick();
  f.emit(approval("req-1"));
  await tick(); await tick();
  const permId = f.permissions.pending(bridgeId)[0]?.id;
  assert.ok(permId);
  assert.equal(f.sessions.summaryOf(bridgeId)?.attention?.reason, "permission");

  await f.sessions.send(bridgeId, "phone-1", "second thought");
  await tick(); await tick();

  // The Remote Control side got the deny it accepts; the local record resolved denied.
  const deny = f.posts.find(p => JSON.stringify(p).includes('"request_id":"req-1"'));
  assert.ok(deny, "expected a control_response for req-1");
  assert.match(JSON.stringify(deny), /"behavior":"deny"/);
  assert.equal(f.permissions.get(permId)?.state, "deny");
  assert.equal(f.permissions.pending(bridgeId).length, 0);
  assert.equal(f.sessions.summaryOf(bridgeId)?.attention?.reason ?? null, null);
  if (via === "bridge") assert.ok(f.posts.some(p => JSON.stringify(p).includes("second thought")), "the user event itself went out over the bridge");
  else {
    assert.ok(!f.posts.some(p => JSON.stringify(p).includes("second thought")), "nothing but the deny was posted");
    assert.ok(f.sessions.modInbox.pending(bridgeId).some(offer => offer.itemId === "phone-1"), "the message waits for the mod to run it");
  }

  // And a lagging replay does not bring the superseded card back.
  f.history.push({ source: "worker", payload: approval("req-1") });
  await f.sessions.syncBridge(bridgeId);
  assert.equal(f.permissions.pending(bridgeId).length, 0);
});
