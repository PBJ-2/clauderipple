import { test } from "node:test";
import assert from "node:assert/strict";
import { renderPlist } from "../src/launchd.ts";

const base = { program: "/opt/ClaudeRipple.app/Contents/MacOS/ClaudeRipple", home: "/tmp/home", stdoutLog: "/tmp/home/logs/launchd.log" };

test("the agent starts at login and is kept alive", () => {
  const plist = renderPlist(base);
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
});

test("ProcessType is Interactive, not throttled", () => {
  // Background (and an unset ProcessType) throttle CPU and I/O — launchd.plist(5). Claude Desktop
  // cannot reach anything at all until this proxy listens, so it must not be a throttled job.
  const plist = renderPlist(base);
  assert.match(plist, /<key>ProcessType<\/key><string>Interactive<\/string>/);
  assert.doesNotMatch(plist, /<string>Background<\/string>/);
});

test("program arguments and environment are escaped", () => {
  const plist = renderPlist({ ...base, args: ["/tmp/a&b.ts"], env: { X: "<y>" } });
  assert.match(plist, /<string>\/tmp\/a&amp;b\.ts<\/string>/);
  assert.match(plist, /<key>X<\/key><string>&lt;y&gt;<\/string>/);
  assert.match(plist, /<key>CLAUDERIPPLE_HOME<\/key><string>\/tmp\/home<\/string>/);
});
