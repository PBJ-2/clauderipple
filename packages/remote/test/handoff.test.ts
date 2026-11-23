import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { sdkQuery } from "../src/sdk-launcher.ts";
import { desktopHandoff, handoffUnavailableText, resumeCommand } from "../src/handoff.ts";
import { clientEvent } from "../src/client-compat.ts";
import { dictionaries, setLang, t as say } from "../web/i18n.ts";
import type { ClientFeature, SessionEvent } from "../src/protocol.ts";

test("handoff selection leaves unsupported hosts off", () => {
  assert.equal(desktopHandoff("unused", 100, "linux"), undefined);
  assert.equal(typeof desktopHandoff("unused", 100, "darwin"), "function");
  assert.equal(typeof desktopHandoff("unused", 100, "win32"), "function");
});

test("the terminal command quotes the folder for the shell and keeps the session id plain (#181)", () => {
  assert.equal(resumeCommand("/srv/my project", "0b2e7a9c-1111-4222-8333-444455556666", "linux"), "cd '/srv/my project' && claude --resume 0b2e7a9c-1111-4222-8333-444455556666");
  assert.equal(resumeCommand("/srv/it's $HOME;rm", "sdk-1", "linux"), `cd '/srv/it'\\''s $HOME;rm' && claude --resume sdk-1`);
  assert.equal(resumeCommand("C:\\Users\\me\\my project", "sdk-1", "win32"), `cd /d "C:\\Users\\me\\my project" && claude --resume sdk-1`);
});

test("an app without the handoffUnavailableNotice feature reads the notice as a plain text line (#181)", () => {
  const command = "cd '/srv/app' && claude --resume sdk-1";
  const event = { kind: "notice", code: "desktop_handoff_unavailable", text: command, seq: 1, at: 1 } as SessionEvent;
  const old = clientEvent(event, new Set<ClientFeature>(["scopedAlways"]));
  assert.ok(old.kind === "notice");
  assert.equal(old.code, "desktop_settings_failed");
  assert.equal(old.text, handoffUnavailableText(command));
  assert.equal(clientEvent(event, new Set<ClientFeature>(["handoffUnavailableNotice"])), event, "a new app gets the notice as written");
  // The text an old app shows and the words a new app builds from its dictionary are the same sentence.
  setLang("ko");
  assert.equal(say("notice.desktop_handoff_unavailable", { text: command }), old.text);
  assert.equal(say("notice.desktop_settings_failed", { text: old.text! }), old.text);
  assert.ok(dictionaries.en["notice.desktop_handoff_unavailable"]);
});

for (const mode of ["success", "failure", "timeout"] as const) {
  test(`PTY handoff ${mode} uses a fake CLI, never a user's session`, { skip: process.platform !== "darwin" }, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ripple-handoff-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const cli = path.join(dir, "fake-claude");
    fs.writeFileSync(cli, `#!/bin/sh\n${mode === "timeout" ? "exec /bin/sleep 60" : 'printf "%s\\n" "$@"; exit ' + (mode === "failure" ? "7" : "0")}\n`, { mode: 0o700 });
    const run = desktopHandoff(cli, mode === "timeout" ? 100 : 5000);
    assert.ok(run);
    const request = { sessionId: "fake-session", title: "Phone title", cwd: dir };
    if (mode === "success") {
      const output = await run(request);
      assert.match(output, /--desktop --resume fake-session/);
      assert.doesNotMatch(output, /--name/);
    } else await assert.rejects(run(request), mode === "timeout" ? /timed out/ : /exit 7/);
  });
}

for (const mode of ["success", "failure", "silent", "timeout"] as const) {
  test(`Windows headless handoff ${mode} uses an isolated CLI and reaps its process tree`, { skip: process.platform !== "win32", timeout: 15_000 }, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ripple-handoff-space "));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const cli = path.join(dir, "fake-claude.cmd"), data = path.join(dir, "received.json");
    const script = path.join(dir, "fake.cjs");
    fs.writeFileSync(cli, `@"${process.execPath}" "${script}" %*\r\n`);
    fs.writeFileSync(script, `const fs = require('node:fs');
const { spawn } = require('node:child_process');
const child = ${mode === "timeout" ? "spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })" : "null"};
fs.writeFileSync(${JSON.stringify(data)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), nested: process.env.CLAUDECODE ?? null, tty: !!process.stdout.isTTY, pid: process.pid, child: child?.pid }));
${mode === "success" ? "console.log('Opening session fake-session in Claude Desktop');" : mode === "failure" ? "console.error('desktop app unavailable'); process.exitCode = 7;" : mode === "timeout" ? "setInterval(()=>{},1000);" : ""}
`);
    const run = desktopHandoff(cli, mode === "timeout" ? 2000 : 10_000);
    assert.ok(run);
    const request = { sessionId: "fake-session", title: "not-an-argument", cwd: dir };
    if (mode === "success") assert.match(await run(request), /Opening session fake-session in Claude Desktop/);
    else await assert.rejects(run(request), mode === "timeout" ? /timed out/ : mode === "failure" ? /desktop app unavailable/ : /without confirming handoff|conhost/);
    const received = JSON.parse(fs.readFileSync(data, "utf8")) as { args: string[]; cwd: string; nested: string | null; tty: boolean; pid: number; child?: number };
    assert.deepEqual(received.args, ["--desktop", "--resume", "fake-session"]);
    assert.equal(received.cwd, dir);
    assert.equal(received.nested, null);
    assert.equal(received.tty, true);
    if (mode === "timeout") {
      // Both the cmd/CLI writer and its descendant must be gone, not just conhost.
      for (const pid of [received.pid, received.child!]) {
        let alive = true;
        for (let i = 0; i < 50 && alive; i++) {
          try { process.kill(pid, 0); await delay(20); }
          catch (error) { assert.equal((error as NodeJS.ErrnoException).code, "ESRCH"); alive = false; }
        }
        assert.equal(alive, false, `process ${pid} survived timeout`);
      }
    }
  });
}

test("the SDK launcher exposes actual child exit, not just close() completion", { timeout: 10_000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ripple-sdk-exit-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const started = Promise.withResolvers<void>();
  let childExited = false;
  const q = sdkQuery({ prompt: (async function* () { await new Promise<void>(() => {}); yield { type: "user" as const, session_id: "", parent_tool_use_id: null, message: { role: "user" as const, content: "unused" } }; })(), options: {
    env: { ...process.env, CLAUDE_CONFIG_DIR: dir },
    pathToClaudeCodeExecutable: process.execPath,
    spawnClaudeCodeProcess: options => {
      const child = spawn(process.execPath, ["-e", "process.stdin.resume();process.stdin.on('end',()=>setTimeout(()=>process.exit(0),150));"], {
        env: options.env, signal: options.signal, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      });
      child.once("exit", () => { childExited = true; });
      started.resolve();
      return child;
    },
  } });
  t.after(() => q.close());
  await started.promise;
  q.close();
  assert.equal(childExited, false);
  await q.processExited;
  assert.equal(childExited, true);
});
