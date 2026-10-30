import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { EventLog } from "../src/eventlog.ts";
import { attachmentContent, messageContent, sessionFiles, sessionFileTool } from "../src/images.ts";
import { transcriptEvents } from "../src/desktop.ts";
import { summarize } from "../src/sessions.ts";
import { ATTACHMENT_CAP, ATTACHMENT_COUNT, SESSION_FILE_NAME, SESSION_FILE_TOTAL } from "../src/protocol.ts";
import { reduce, timelineItems } from "../web/timeline.ts";
import { fileSymlinks, needsPosixModes } from "../../../test/capabilities.ts";

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const data = png.toString("base64");
const image = { type: "image", source: { type: "base64", media_type: "image/png", data } };
function directory(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ripple-files-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync(dir);
}
function fixture(t: TestContext) {
  const cwd = directory(t), dir = directory(t);
  const log = EventLog.open({ dir });
  t.after(() => log.close());
  const sink = (value: string) => log.image(value);
  return { cwd, dir, log, sink };
}

test("desktop image-only user, assistant and tool results become blob-backed image parts", t => {
  const { cwd, log, sink } = fixture(t);
  for (const type of ["user", "assistant"]) {
    const result = transcriptEvents(JSON.stringify({ type, uuid: type, message: { content: [image] } }), cwd, () => "", sink);
    assert.equal(result.bodies.length, 1);
    const event = log.append(result.bodies[0]!);
    assert.ok(event.kind === "user" || event.kind === "assistant");
    assert.equal(event.text, "");
    assert.equal(event.images?.[0]?.mediaType, "image/png");
    assert.equal(log.blob(event.images![0]!.blob!), data);
    assert.equal(timelineItems(reduce([event])).length, 1);
  }
  const result = transcriptEvents(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "read", content: [image] }] } }), cwd, () => "", sink);
  assert.equal(result.bodies[0]?.kind, "tool_result");
  assert.equal(log.blob(result.bodies[0]!.images![0]!.blob!), data);
  assert.deepEqual(messageContent([null, { type: "image", source: { type: "url", url: "https://invalid" } }]).images, [{ type: "image", mediaType: "image/png" }]);
});

test("session files reject outside roots, traversal, broad roots, directories and symlinks", t => {
  const { cwd, sink } = fixture(t), outside = directory(t);
  fs.writeFileSync(path.join(cwd, "safe.png"), png);
  fs.writeFileSync(path.join(outside, "outside.png"), png);
  fs.mkdirSync(path.join(cwd, "folder"));
  const list = [path.join(outside, "outside.png"), "../outside.png", "folder/../safe.png", "folder", "missing.png", 7];
  const files = sessionFiles(list, { cwd }, sink);
  assert.deepEqual(files.map(file => file.status), ["blocked", "blocked", "blocked", "blocked", "missing", "blocked"]);
  assert.ok(files.every(file => !file.blob));
  for (const root of [os.tmpdir(), fs.realpathSync(os.tmpdir()), os.homedir(), path.parse(cwd).root]) {
    assert.equal(sessionFiles([path.join(cwd, "safe.png")], { cwd: root }, sink)[0]?.status, "blocked");
  }
  if (!fileSymlinks) return;
  fs.symlinkSync(path.join(cwd, "safe.png"), path.join(cwd, "link.png"));
  fs.symlinkSync(outside, path.join(cwd, "linked"));
  assert.deepEqual(sessionFiles(["link.png", "linked/outside.png"], { cwd }, sink).map(file => file.status), ["blocked", "blocked"]);
});

test("only host metadata can authorize an additional folder or an exact scratchpad", t => {
  const { cwd, sink } = fixture(t), additional = directory(t), scratchpad = directory(t);
  const a = path.join(additional, "추가.txt"), s = path.join(scratchpad, "결과.txt");
  fs.writeFileSync(a, "추가 작업 폴더"); fs.writeFileSync(s, "확인된 세션 scratchpad");
  assert.deepEqual(sessionFiles([a, s], { cwd }, sink).map(file => file.status), ["blocked", "blocked"]);
  assert.deepEqual(sessionFiles([a, s], { cwd, additionalDirectories: [additional], scratchpad }, sink).map(file => file.status), ["ready", "ready"]);
  const forged = sessionFileTool("SendUserFile", { files: [s], cwd: scratchpad, additionalDirectories: [scratchpad], scratchpad_dir: scratchpad }, { cwd }, sink);
  assert.equal(forged.files?.[0]?.status, "blocked");
  assert.ok(typeof forged.input === "string" && !forged.input.includes(scratchpad));
});

test("image references use the same session boundary, never all of .claude or a temp cache", t => {
  const { cwd, log, sink } = fixture(t), outside = directory(t);
  fs.writeFileSync(path.join(cwd, "안녕.png"), png);
  fs.writeFileSync(path.join(outside, "outside.png"), png);
  const converted = messageContent(`Before [Image: source: ${cwd}/안녕.png] after [Image: source: ${outside}/outside.png]`, sink, { cwd });
  assert.equal(converted.text, "Before  after ");
  assert.deepEqual(converted.files.map(file => file.status), ["ready", "blocked"]);
  assert.equal(converted.files[0]?.name, "안녕.png");
  assert.equal(log.blob(converted.images[0]!.blob!), data);
  assert.equal(converted.images.length, 1);
  assert.equal(messageContent(`[Image: source: ${cwd}/안녕.png]`, sink).files[0]?.status, "blocked");
});

test("a pasted image and a scratchpad file in the session's own Claude temp folder reach the phone", t => {
  const { cwd, sink } = fixture(t);
  const root = process.platform === "win32" ? path.join(os.tmpdir(), "claude")
    : path.join(fs.existsSync("/private/tmp") ? "/private/tmp" : "/tmp", `claude-${process.getuid!()}`);
  if (!fs.existsSync(root)) { fs.mkdirSync(root, { mode: 0o700 }); t.after(() => fs.rmSync(root, { recursive: true, force: true })); }
  const id = "0f0e0d0c-1111-4222-8333-944455556666", other = "0f0e0d0c-1111-4222-8333-999999999999";
  const slug = path.join(root, cwd.replace(/[^A-Za-z0-9]/g, "-"));
  t.after(() => fs.rmSync(slug, { recursive: true, force: true }));
  for (const [session, folder] of [[id, "images"], [id, "scratchpad"], [other, "images"]] as const) {
    fs.mkdirSync(path.join(slug, session, folder), { recursive: true });
    fs.writeFileSync(path.join(slug, session, folder, "1.png"), png);
  }
  const pasted = messageContent(`[Image: source: ${path.join(slug, id, "images", "1.png")}]`, sink, { cwd, sessionId: id });
  assert.equal(pasted.files[0]?.status, "ready");
  assert.equal(pasted.images.length, 1);
  assert.equal(sessionFiles([path.join(slug, id, "scratchpad", "1.png")], { cwd, sessionId: id }, sink)[0]?.status, "ready");
  // Another session's folder, and any folder without the host's session id, stay closed.
  assert.equal(sessionFiles([path.join(slug, other, "images", "1.png")], { cwd, sessionId: id }, sink)[0]?.status, "blocked");
  assert.equal(sessionFiles([path.join(slug, id, "images", "1.png")], { cwd }, sink)[0]?.status, "blocked");
  assert.equal(sessionFiles([path.join(slug, id, "images", "1.png")], { cwd, sessionId: "../x" }, sink)[0]?.status, "blocked");
});

test("Windows session temp rejects writable ACLs and junctions without opening other temp folders", { skip: process.platform !== "win32" }, t => {
  const { cwd, sink } = fixture(t), outside = directory(t);
  const id = "0f0e0d0c-1111-4222-8333-944455556666";
  const project = path.join(os.tmpdir(), "claude", cwd.replace(/[^A-Za-z0-9]/g, "-"));
  const session = path.join(project, id), file = path.join(session, "safe.png");
  fs.mkdirSync(session, { recursive: true }); fs.writeFileSync(file, png);
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  assert.equal(sessionFiles([file], { cwd, sessionId: id }, sink)[0]?.status, "ready");
  const icacls = path.join(process.env.SystemRoot!, "System32", "icacls.exe");
  execFileSync(icacls, [session, "/grant", "*S-1-1-0:(OI)(CI)M"], { stdio: "ignore" });
  try { assert.equal(sessionFiles([file], { cwd, sessionId: id }, sink)[0]?.status, "blocked"); }
  finally { execFileSync(icacls, [session, "/remove:g", "*S-1-1-0"], { stdio: "ignore" }); }
  fs.renameSync(session, session + "-saved");
  fs.writeFileSync(path.join(outside, "safe.png"), png);
  fs.symlinkSync(outside, session, "junction");
  assert.equal(sessionFiles([file], { cwd, sessionId: id }, sink)[0]?.status, "blocked");
  fs.unlinkSync(session);
  fs.renameSync(session + "-saved", session);
});

test("a project folder whose own name looks secret still sends its ordinary files", t => {
  const parent = directory(t), cwd = path.join(parent, "auth-service");
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd, "README.md"), "# Hello");
  assert.equal(sessionFiles(["README.md"], { cwd }, () => "blob")[0]?.status, "ready");
});

test("secret names, credentials content and hard links are refused even when explicitly sent", t => {
  const { cwd, sink } = fixture(t);
  const names = [".env", ".env.production", "AuthKey.p8", "cert.pem", "release.jks", "key.key", "keys.p12", "token.json", "service-account.json", "google-services.json", "credentials", ".npmrc", "id_ed25519"];
  for (const name of names) fs.writeFileSync(path.join(cwd, name), "secret");
  for (const name of names) assert.equal(sessionFiles([name], { cwd }, sink)[0]?.status, "blocked", name);
  fs.writeFileSync(path.join(cwd, "innocent.txt"), '-----BEGIN PRIVATE KEY-----\nsecret');
  fs.writeFileSync(path.join(cwd, "config.json"), '{"access_token":"not-for-the-phone"}');
  assert.deepEqual(sessionFiles(["innocent.txt", "config.json"], { cwd }, sink).map(file => file.status), ["blocked", "blocked"]);
  fs.linkSync(path.join(cwd, ".env"), path.join(cwd, "copy.txt"));
  assert.equal(sessionFiles(["copy.txt"], { cwd }, sink)[0]?.status, "blocked");
});

const credentialFields = ["password", "passwd", "secret", "client_secret", "clientSecret", "api_key", "apiKey", "access_token", "accessToken", "refresh_token", "refreshToken", "private_key", "privateKey", "auth_token", "authToken", "bearer", "authorization", "token", "secretKey", "DB_PASSWORD", "databasePassword", "ACCESS_TOKEN", "bearerToken", "api-key", "auth token", "access token"];

for (const format of ["json", "single-quoted", "yaml", "env", "quoted-env", "spaces"] as const) test(`SendUserFile blocks credential values before publishing any blob (${format})`, t => {
  const cwd = directory(t);
  let writes = 0;
  for (const field of credentialFields) {
    const key = format === "spaces" ? field.replace(/_/g, " ") : field;
    const value = "fixture-value-not-for-phone";
    const content = format === "json" ? JSON.stringify({ nested: [{ [key]: value }] })
      : format === "single-quoted" ? `{'${key}': '${value}'}`
      : format === "yaml" || format === "spaces" ? `${key}: ${value}\n`
      : format === "quoted-env" ? `export ${key}="${value}"\n` : `${key}=${value}\n`;
    fs.writeFileSync(path.join(cwd, "config.json"), content);
    const result = sessionFileTool("SendUserFile", { files: ["config.json"] }, { cwd }, () => { writes++; return "leaked-blob"; });
    assert.equal(result.files?.[0]?.status, "blocked", `${format}: ${key}`);
    assert.equal(result.files?.[0]?.blob, undefined);
  }
  assert.equal(writes, 0, "refused bytes must never enter the blob store");
});

test("empty credentials, explicit references and masked values do not block ordinary configuration", t => {
  const { cwd, log, sink } = fixture(t);
  const samples = [
    '{"password":"", "apiKey":"  ", "client_secret":null}',
    "password:\nlabel: ordinary\napi_key= # not configured\n",
    'password=""\napi_key=\'\'\nsecret: null\nprivate_key: ~\n',
    '{"password":"${DB_PASSWORD}", "apiKey":"{{ API_KEY }}", "secret":"[REDACTED]"}',
    "password: <redacted>\napi_key: ***\n",
    "password=${DB_PASSWORD}\napiKey: {{ API_KEY }}\n",
    '{"nested":{"password":"", "label":"kept"}, "entries":[{"apiKey":""}]}',
    '{"passwordHint":"a hint", "secretCount":3, "tokenLimit":1000, "publicKey":"public", "monkey":"banana"}',
    '{"description":"password", "fields":["password", "apiKey"]}',
    'password: # empty\napi_key: ""\nlabel: "kept"',
  ];
  for (const content of samples) {
    fs.writeFileSync(path.join(cwd, "config.json"), content);
    const result = sessionFileTool("SendUserFile", { files: ["config.json"] }, { cwd }, sink);
    const file = result.files?.[0];
    assert.equal(file?.status, "ready", content);
    assert.equal(Buffer.from(log.blob(file!.blob!)!, "base64").toString(), content);
  }
});

test("short or example-looking credential values are still secrets; empty fields cannot hide later values", t => {
  const cwd = directory(t);
  for (const content of ['{"password":"example"}', '{"passwd":"x"}', 'secret: password', 'password: ""\napi_key: actual-value', 'password: |\n  actual-value', 'authToken: >\n  actual-value', '{"password":["actual-value"]}', '{"secret":{"value":"actual-value"}}', 'password: "${DB_PASSWORD}-literal-suffix"', 'apiKey=${API_KEY}-literal-suffix']) {
    fs.writeFileSync(path.join(cwd, "config.json"), content);
    assert.equal(sessionFileTool("SendUserFile", { files: ["config.json"] }, { cwd }, () => "blob").files?.[0]?.status, "blocked", content);
  }
});

test("per-file 8 MiB, per-call eight files and total 32 MiB bounds are inclusive", t => {
  const { cwd, log, sink } = fixture(t);
  fs.writeFileSync(path.join(cwd, "full.bin"), Buffer.alloc(ATTACHMENT_CAP));
  fs.writeFileSync(path.join(cwd, "large.bin"), Buffer.alloc(ATTACHMENT_CAP + 1));
  const files = sessionFiles(Array.from({ length: ATTACHMENT_COUNT + 1 }, () => "full.bin"), { cwd }, sink);
  assert.equal(files.length, ATTACHMENT_COUNT);
  assert.equal(files.filter(file => file.status === "ready").reduce((sum, file) => sum + file.bytes, 0), SESSION_FILE_TOTAL);
  assert.deepEqual(files.map(file => file.status), ["ready", "ready", "ready", "ready", "too_large", "too_large", "too_large", "too_large"]);
  assert.equal(Buffer.from(log.blob(files[0]!.blob!)!, "base64").length, ATTACHMENT_CAP);
  assert.equal(sessionFiles(["large.bin"], { cwd }, sink)[0]?.status, "too_large");
});

test("file MIME is sniffed, Korean names survive and source changes never change a published snapshot", t => {
  const { cwd, log, sink } = fixture(t);
  const samples = [
    { name: "그림.txt", data: png, mime: "image/png" },
    { name: "가짜.png", data: Buffer.from("텍스트입니다"), mime: "text/plain" },
    { name: "보고서.bin", data: Buffer.from("%PDF-1.7\n"), mime: "application/pdf" },
    { name: "화면.txt", data: Buffer.from("<!doctype html><html><body>안녕</body></html>"), mime: "text/html" },
    { name: "안내.md", data: Buffer.from("# 안내\n\n내용"), mime: "text/markdown" },
  ];
  for (const item of samples) {
    fs.writeFileSync(path.join(cwd, item.name), item.data);
    const [file] = sessionFiles([item.name], { cwd }, sink);
    assert.equal(file?.name, item.name); assert.equal(file?.mediaType, item.mime); assert.equal(file?.status, "ready");
    fs.writeFileSync(path.join(cwd, item.name), "changed");
    assert.deepEqual(Buffer.from(log.blob(file!.blob!)!, "base64"), item.data);
    assert.ok(!JSON.stringify(file).includes(cwd));
  }
  const long = sessionFiles(["가".repeat(1000)], { cwd }, sink)[0]!;
  assert.ok(Array.from(long.name).length <= SESSION_FILE_NAME);
  assert.deepEqual(sessionFiles(null, { cwd }, sink), []);
});

// Windows swaps in a junction, which needs no symlink privilege.
test("replacement between path validation and open is blocked", { skip: !fileSymlinks && process.platform !== "win32" }, t => {
  const { cwd, sink } = fixture(t), outside = directory(t);
  const folder = path.join(cwd, "out"); fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, "file.txt"), "safe");
  fs.writeFileSync(path.join(outside, "file.txt"), "outside");
  // The reader may open the file under another spelling of the same folder (Windows' long form
  // of an 8.3 TEMP), so the swap triggers on either.
  const key = (file: string) => process.platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file);
  const targets = new Set([path.join(folder, "file.txt"), fs.realpathSync.native(path.join(folder, "file.txt"))].map(key));
  const open = fs.openSync;
  const mock = t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
    if (!targets.has(key(String(args[0])))) return open(...args);
    fs.renameSync(folder, folder + "-saved"); fs.symlinkSync(outside, folder, process.platform === "win32" ? "junction" : undefined);
    try { return open(...args); }
    finally { fs.unlinkSync(folder); fs.renameSync(folder + "-saved", folder); }
  });
  assert.equal(sessionFiles(["out/file.txt"], { cwd }, sink)[0]?.status, "blocked");
  mock.mock.restore();
});

test("same-handle writes during snapshot are blocked without losing the next file", t => {
  const { cwd, sink } = fixture(t);
  fs.writeFileSync(path.join(cwd, "race.txt"), "before"); fs.writeFileSync(path.join(cwd, "safe.txt"), "safe");
  const read = fs.readSync;
  let changed = false;
  const mock = t.mock.method(fs, "readSync", (...args: Parameters<typeof fs.readSync>) => {
    const n = read(...args);
    if (!changed) {
      changed = true;
      fs.writeFileSync(path.join(cwd, "race.txt"), "after!");
      // NTFS can coalesce timestamps of same-size writes in one timer tick.
      const later = new Date(Date.now() + 1000); fs.utimesSync(path.join(cwd, "race.txt"), later, later);
    }
    return n;
  });
  assert.deepEqual(sessionFiles(["race.txt", "safe.txt"], { cwd }, sink).map(file => file.status), ["blocked", "ready"]);
  mock.mock.restore();
});

test("desktop SendUserFile cards keep safe files, blocked statuses and the rest of the event", t => {
  const { cwd, log, sink } = fixture(t), outside = directory(t);
  fs.writeFileSync(path.join(cwd, "안내.txt"), "안내"); fs.writeFileSync(path.join(cwd, "shot.png"), png);
  const content = [
    { type: "text", text: "파일을 확인해 주세요." },
    { type: "tool_use", id: "files", name: "SendUserFile", input: { files: ["안내.txt", "shot.png", path.join(outside, "private.txt")], caption: "결과" } },
    { type: "tool_use", id: "other", name: "Read", input: { file_path: "README.md" } },
  ];
  const parsed = transcriptEvents(JSON.stringify({ type: "assistant", uuid: "a1", message: { content } }), cwd, summarize, sink);
  assert.equal(parsed.bodies.length, 1);
  const event = log.append(parsed.bodies[0]!);
  assert.ok(event.kind === "assistant");
  assert.equal(event.text, "파일을 확인해 주세요."); assert.equal(event.tools.length, 2);
  assert.deepEqual(event.tools[0]?.files?.map(file => file.status), ["ready", "ready", "blocked"]);
  assert.equal(event.tools[0]?.summary, "안내.txt, shot.png, private.txt, 결과");
  assert.ok(!event.tools[0]?.input?.toString().includes(outside));
  assert.equal(log.blob(event.images![0]!.blob!), data);
  const failed = transcriptEvents(JSON.stringify({ type: "assistant", message: { content } }), cwd, summarize, () => { throw new Error("disk unavailable"); });
  assert.ok(failed.bodies[0]?.kind === "assistant");
  assert.equal(failed.bodies[0].text, "파일을 확인해 주세요.");
  assert.deepEqual(failed.bodies[0].tools[0]?.files?.map(file => file.status), ["blocked", "blocked", "blocked"]);
});

test("an attachment-only refused assistant record still reaches the timeline", t => {
  const { cwd, sink } = fixture(t);
  const parsed = transcriptEvents(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "[Image: source: /outside/no.png]" }] } }), cwd, summarize, sink);
  assert.equal(parsed.bodies.length, 1);
  assert.equal(parsed.bodies[0]?.files?.[0]?.status, "blocked");
  assert.equal(parsed.bodies[0]?.kind, "assistant");
});

test("shared timeline preserves files on users, answers and tool results through final snapshots", t => {
  const { cwd, log, sink } = fixture(t);
  fs.writeFileSync(path.join(cwd, "파일.txt"), "파일");
  const files = sessionFiles(["파일.txt"], { cwd }, sink);
  const events = [
    log.append({ kind: "user", text: "", clientMsgId: "user", files }),
    log.append({ kind: "assistant", msg: "answer", model: "test", text: "", files, tools: [{ id: "tool", name: "SendUserFile", summary: "파일.txt", files }] }),
    log.append({ kind: "tool_result", toolUseId: "tool", ok: true, text: "", files }),
    log.append({ kind: "assistant", msg: "answer", model: "test", text: "", files, tools: [{ id: "tool", name: "SendUserFile", summary: "파일.txt", files }] }),
  ];
  const view = reduce(events);
  const user = view.items.find(item => item.type === "user");
  const assistant = view.items.find(item => item.type === "assistant");
  assert.ok(user?.type === "user" && assistant?.type === "assistant");
  assert.deepEqual(user.files, files); assert.deepEqual(assistant.files, files);
  assert.deepEqual(assistant.tools[0]?.files, files); assert.deepEqual(assistant.tools[0]?.result?.files, files);
  assert.ok(timelineItems(view).some(item => item.type === "assistant" && item.files?.length === 1));
  const withWidget = reduce([...events, log.append({ kind: "assistant", msg: "widget", model: "test", text: "", files, tools: [{ id: "w", name: "show_widget", summary: "widget" }] })]);
  const rows = timelineItems(withWidget).filter(item => item.type === "assistant" && item.key.startsWith("awidget"));
  assert.equal(rows.length, 2);
  assert.equal(rows.filter(item => item.type === "assistant" && item.files?.length).length, 1, "widget clones must not duplicate file cards");
});

test("the attachment folder is created 0700, not 0755", { skip: needsPosixModes }, t => {
  const cwd = directory(t);
  attachmentContent(cwd, "see attached", [{ blob: "b1", name: "note.txt", mediaType: "text/plain" }], () => Buffer.from("hello").toString("base64"));
  assert.equal(fs.statSync(path.join(cwd, ".ripple-attachments")).mode & 0o777, 0o700);
});

test("summarize names a SendUserFile's files and caption without a caption, and blank input is empty", t => {
  const cwd = directory(t);
  assert.equal(summarize("SendUserFile", { files: ["a.png", path.join(cwd, "b.jpg")], caption: "before vs after" }, cwd), "a.png, b.jpg, before vs after");
  assert.equal(summarize("SendUserFile", { files: ["only.gif"], status: "proactive" }, cwd), "only.gif");
  assert.equal(summarize("SendUserFile", {}, cwd), "");
});
