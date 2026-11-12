// The status route's certificate check never runs on the request path (#159).
import test from "node:test";
import assert from "node:assert/strict";
import { PickerTrust } from "../src/picker-trust.ts";

const tick = () => new Promise(resolve => setImmediate(resolve));

test("the first request starts a background check and answers unknown without waiting for it", async () => {
  let release: (value: boolean | null) => void = () => {};
  let started = 0;
  const trust = new PickerTrust({ check: () => { started++; return new Promise(resolve => { release = resolve; }); } });
  assert.equal(trust.get(), null, "unknown, not 'not trusted': no false banner");
  assert.equal(started, 1);
  assert.equal(trust.get(), null);
  assert.equal(started, 1, "one check at a time while it is running");
  release(true);
  await tick();
  assert.equal(trust.get(), true);
});

test("a check that hangs never blocks a request and is not stacked", async () => {
  let started = 0, now = 0;
  const trust = new PickerTrust({ now: () => now, check: () => { started++; return new Promise(() => {}); } });
  for (let i = 0; i < 5; i++) { now += 61_000; assert.equal(trust.get(), null); }
  assert.equal(started, 1, "no second child while the first has not ended");
});

test("a refresh runs in the background once a minute and the last answer is served meanwhile", async () => {
  let now = 1_000_000, started = 0;
  const answers = [true, false];
  const trust = new PickerTrust({ now: () => now, check: async () => answers[started++]! });
  trust.get();
  await tick();
  assert.equal(trust.get(), true);
  now += 59_000;
  assert.equal(trust.get(), true);
  assert.equal(started, 1, "inside the minute nothing runs");
  now += 2_000;
  assert.equal(trust.get(), true, "the stale answer is served while the new check runs");
  assert.equal(started, 2);
  await tick();
  assert.equal(trust.get(), false);
});

test("a check that timed out or threw keeps the last answer", async () => {
  let now = 0, step = 0;
  const errors: unknown[] = [];
  const trust = new PickerTrust({
    now: () => now, onError: error => errors.push(error),
    check: async () => { step++; if (step === 1) return true; if (step === 2) return null; throw new Error("spawn failed"); },
  });
  trust.get(); await tick();
  now += 61_000; trust.get(); await tick();
  assert.equal(trust.get(), true, "a timeout says nothing about the certificate");
  now += 61_000; trust.get(); await tick();
  assert.equal(trust.get(), true);
  assert.equal(errors.length, 1);
});

test("a timeout before any answer leaves the state unknown", async () => {
  const trust = new PickerTrust({ check: async () => null });
  trust.get(); await tick();
  assert.equal(trust.get(), null);
});

test("a check that throws synchronously does not escape the request", async () => {
  const errors: unknown[] = [];
  const trust = new PickerTrust({ check: () => { throw new Error("boom"); }, onError: error => errors.push(error) });
  assert.equal(trust.get(), null);
  await tick();
  assert.equal(errors.length, 1);
});
