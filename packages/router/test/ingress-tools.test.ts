import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ToolTranslation, ToolTranslationError, type ToolDiagnostic, type ToolIdentity } from "../src/ingress/tools.ts";
import { responsesToAnthropic, chatToAnthropic, ResponsesEventMapper, type Json } from "../src/ingress/translate.ts";
import { OpenAiIngress } from "../src/ingress/server.ts";
import { Logger } from "../src/log.ts";
import { RequestLog } from "../src/requestlog.ts";
import { ClaudeCodeAuthStore, ClaudeCodeCredentialStore } from "../src/providers/anthropic.ts";
import { ClaudeAccountAuthPool } from "../src/providers/anthropic-account-pool.ts";
import type { Config } from "../src/config.ts";
import { resolveCompatibleCaps, sanitizeForCompatible } from "../src/compat.ts";

const format = { type: "grammar", syntax: "lark", definition: 'start: "print(" /[^)]+/ ")"' };
const tools = [
  { type: "function", name: "read", parameters: { type: "object", properties: { path: { type: "string" } } } },
  { type: "custom", name: "exec", description: "Execute code", format },
  { type: "namespace", name: "files.api", tools: [
    { type: "function", name: "read", parameters: { type: "object" } },
    { type: "custom", name: "exec", format },
  ] },
  { type: "function", name: "custom_exec", parameters: { type: "object" } },
  { type: "function", name: "files_api__read", parameters: { type: "object" } },
  { type: "custom", name: "x".repeat(100), format },
  { type: "function", name: "a.b", parameters: { type: "object" } },
  { type: "function", name: "a_b", parameters: { type: "object" } },
];
const identities: ToolIdentity[] = [
  { kind: "function", name: "read" }, { kind: "custom", name: "exec" },
  { kind: "function", name: "read", namespace: "files.api" },
  { kind: "custom", name: "exec", namespace: "files.api" },
  { kind: "function", name: "custom_exec" }, { kind: "function", name: "files_api__read" },
  { kind: "custom", name: "x".repeat(100) },
  { kind: "function", name: "a.b" }, { kind: "function", name: "a_b" },
];
const customInput = 'print("한글\\path")\n<invoke>literal only</invoke>';

for (const oauth of [false, true]) {
  test(`tool identities are legal, deterministic and reversible (${oauth ? "OAuth" : "API key"})`, () => {
    const table = new ToolTranslation({ tools }, oauth);
    const names = table.tools.map((tool) => tool.name);
    assert.equal(new Set(names).size, identities.length);
    assert.deepEqual(names, new ToolTranslation({ tools }, oauth).tools.map((tool) => tool.name));
    for (const [index, identity] of identities.entries()) {
      assert.match(names[index]!, /^[a-zA-Z0-9_-]{1,64}$/);
      assert.equal(table.toWire(identity), names[index]);
      assert.deepEqual(table.fromWire(names[index]!), identity);
      if (oauth) assert.ok(names[index]!.startsWith("custom_"));
    }
    assert.notEqual(table.toWire(identities[1]!), table.toWire(identities[4]!));
    assert.deepEqual(table.tools[1]!.input_schema, { type: "object", properties: { input: { type: "string" } }, required: ["input"], additionalProperties: false });
    assert.equal(table.tools[1]!.description, `Execute code\n\nOriginal input format: ${JSON.stringify(format)}`);
    assert.equal(table.tools.filter((tool) => tool.cache_control).length, 1);
  });

  test(`tool choices resolve custom, namespace and allowed subsets (${oauth ? "OAuth" : "API key"})`, () => {
    for (const identity of identities) {
      const choice = { type: identity.kind, name: identity.name, ...(identity.namespace ? { namespace: identity.namespace } : {}) };
      const table = new ToolTranslation({ tools, tool_choice: choice }, oauth);
      assert.deepEqual(table.choice, { type: "tool", name: table.toWire(identity) });
    }
    const allowed = new ToolTranslation({ tools, tool_choice: { type: "allowed_tools", mode: "required", tools: [
      { type: "namespace", name: "files.api" }, { type: "custom", name: "exec" },
    ] } }, oauth);
    assert.deepEqual(allowed.choice, { type: "any" });
    assert.deepEqual(allowed.tools.map((tool) => allowed.fromWire(tool.name)), [identities[1], identities[2], identities[3]]);
    const nested = new ToolTranslation({ tools: [{ type: "function", function: { name: "read" } }], tool_choice: { type: "function", function: { name: "read" } } }, oauth);
    assert.deepEqual(nested.choice, { type: "tool", name: nested.tools[0]!.name });
  });
}

test("hosted tool diagnostics contain metadata only and impossible requirements fail visibly", () => {
  const diagnostics: ToolDiagnostic[] = [];
  const body = { tools: [{ type: "web_search", name: "search", description: "private instructions", arguments: "secret input" }] };
  assert.equal(new ToolTranslation(body, false, (entry) => diagnostics.push(entry)).tools.length, 0);
  assert.deepEqual(diagnostics, [{ type: "web_search", name: "search", reason: "unsupported tool type or missing name" }]);
  assert.throws(() => new ToolTranslation({ ...body, tool_choice: "required" }), ToolTranslationError);
  assert.throws(() => new ToolTranslation({ tools, tool_choice: { type: "custom", name: "missing" } }), ToolTranslationError);
  assert.throws(() => new ToolTranslation({ tools, tool_choice: { type: "allowed_tools", mode: "required", tools: [{ type: "web_search" }] } }), ToolTranslationError);
  assert.equal(new ToolTranslation({ tool_choice: "auto" }).choice, undefined);
});

for (const mode of ["auto", "none", "required"]) {
  test(`empty allowed_tools omits declarations unless a call is required (${mode})`, () => {
    for (const declared of [[{ type: "web_search" }], tools]) {
      const body = { tools: declared, tool_choice: { type: "allowed_tools", mode, tools: [{ type: "web_search" }] }, input: "Continue" };
      if (mode === "required") {
        assert.throws(() => responsesToAnthropic(body, "claude-sonnet-5"), ToolTranslationError);
        continue;
      }
      const result = responsesToAnthropic(body, "claude-sonnet-5");
      assert.equal(Object.hasOwn(result, "tools"), false);
      assert.equal(Object.hasOwn(result, "tool_choice"), false);
      assert.equal(result.messages[0]!.content[0]!.type, "text");
    }
  });
}

for (const oauth of [false, true]) for (const source of ["excluded", "history-only", "none"]) {
  test(`upstream cannot call ${source} tools while history stays reversible (${oauth ? "OAuth" : "API key"})`, () => {
    const history = { type: "custom_tool_call", call_id: "old", name: "exec", input: customInput };
    const body = {
      tools: source === "history-only" ? [tools[0]] : tools,
      tool_choice: source === "none" ? "none" : { type: "allowed_tools", mode: "required", tools: [{ type: "function", name: "read" }] },
      input: [history, { type: "custom_tool_call_output", call_id: "old", output: "done" }],
    };
    const table = new ToolTranslation(body, oauth);
    const wire = table.toWire(identities[1]!);
    assert.deepEqual(table.fromWire(wire), identities[1]);
    const replay = responsesToAnthropic(body, "claude-sonnet-5", undefined, undefined, table);
    const use = replay.messages[0]!.content[0]!;
    assert.equal(use.type, "tool_use");
    if (use.type === "tool_use") assert.equal(use.name, wire);
    const mapper = new ResponsesEventMapper("claude-sonnet-5", table);
    assert.throws(() => mapper.feed({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "new", name: wire } }), /unknown tool/);
    assert.deepEqual(mapper.output, [], "no executable output item is emitted");
    if (source !== "none") {
      const allowed = new ResponsesEventMapper("claude-sonnet-5", table);
      allowed.feed({ type: "content_block_start", index: 0, content_block: { type: "tool_use", name: table.toWire(identities[0]!) } });
      assert.equal(allowed.output[0]!.type, "function_call");
    }
  });
}

test("namespace descriptions prefix every flattened child deterministically", () => {
  const body = { tools: [{ type: "namespace", name: "files.api", description: "Operate only on project files.", tools: [
    { type: "function", name: "read", description: "Read a file." },
    { type: "custom", name: "exec", description: "Execute code.", format },
  ] }] };
  for (const oauth of [false, true]) {
    const table = new ToolTranslation(body, oauth);
    assert.deepEqual(table.tools.map((tool) => tool.description), [
      "Namespace: files.api\nOperate only on project files.\n\nRead a file.",
      `Namespace: files.api\nOperate only on project files.\n\nExecute code.\n\nOriginal input format: ${JSON.stringify(format)}`,
    ]);
    assert.deepEqual(table.tools, new ToolTranslation(body, oauth).tools);
  }
});

const smallPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=";

for (const kind of ["function", "custom"]) {
  const outputType = kind === "custom" ? "custom_tool_call_output" : "function_call_output";
  const resultContent = (output: unknown, nativeImages = true) => {
    const result = responsesToAnthropic({ input: [{ type: outputType, call_id: "inspect_1", output }] }, "claude-sonnet-5", undefined, undefined, undefined, nativeImages);
    const block = result.messages[0]!.content[0]!;
    if (block.type !== "tool_result") throw new Error("expected tool result");
    return block.content;
  };

  test(`${kind} text-only output arrays match f969644 bytes`, () => {
    const output = [
      { type: "input_text", text: "첫 줄\r\n둘째 줄" },
      { type: "output_text", text: "" },
      { type: "text", text: "  그대로  " },
      { type: "refusal", refusal: "거절" },
    ];
    const baseline = "첫 줄\r\n둘째 줄\n\n  그대로  \n거절";
    for (const native of [false, true]) {
      const actual = resultContent(output, native);
      assert.equal(actual, baseline);
      assert.deepEqual(Buffer.from(actual as string), Buffer.from(baseline));
    }
  });

  test(`${kind} empty text output stays an empty string`, () => {
    for (const output of ["", [], [{ type: "input_text", text: "" }], [{ type: "refusal", refusal: "" }]]) {
      for (const native of [false, true]) assert.equal(resultContent(output, native), "");
    }
  });

  test(`${kind} compatible output omits images`, () => {
    assert.deepEqual(resultContent([{ type: "input_image", image_url: `data:image/png;base64,${smallPng}` }], false), [
      { type: "text", text: "[image omitted: this model does not take images]" },
    ]);
  });

  test(`${kind} invalid base64 omits only the invalid image`, () => {
    for (const data of ["", "!!!!", "YQ", "YQ=", "YQ===", "Y Q==", "YR==", "AA=A"]) {
      assert.deepEqual(resultContent([
        { type: "input_text", text: "" },
        { type: "input_image", image_url: `data:image/png;base64,${data}` },
        { type: "input_image", image_url: `data:image/png;base64,${smallPng}` },
      ]), [
        { type: "text", text: "" },
        { type: "text", text: "[image omitted: unsupported source]" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: smallPng } },
      ]);
    }
  });

  test(`${kind} image size accepts 5 MiB and omits 5 MiB plus one byte`, () => {
    for (const size of [5 * 1024 * 1024, 5 * 1024 * 1024 + 1]) {
      const data = Buffer.alloc(size).toString("base64");
      assert.deepEqual(resultContent([{ type: "input_image", image_url: `data:image/png;base64,${data}` }]), size === 5 * 1024 * 1024
        ? [{ type: "image", source: { type: "base64", media_type: "image/png", data } }]
        : [{ type: "text", text: "[image omitted: unsupported source]" }]);
    }
  });

  test(`${kind} native output preserves a small PNG and marks unsupported content`, () => {
    const body = { tools: [{ type: kind, name: "inspect" }], input: [
      { type: kind === "custom" ? "custom_tool_call" : "function_call", call_id: "inspect_1", name: "inspect", input: "image", arguments: "{}" },
      { type: kind === "custom" ? "custom_tool_call_output" : "function_call_output", call_id: "inspect_1", output: [
        { type: "input_text", text: "Screenshot follows" },
        { type: "input_image", image_url: `data:image/png;base64,${smallPng}` },
        { type: "input_image", image_url: "https://example.com/private.png" },
        { type: "input_image", file_id: "file_123" },
        { type: "input_image", image_url: "data:image/svg+xml;base64,PHN2Zy8+" },
        { type: "input_file", file_id: "file_456" },
      ] },
    ] };
    const result = responsesToAnthropic(body, "claude-sonnet-5", undefined, undefined, undefined, true);
    const block = result.messages[1]!.content[0]!;
    assert.equal(block.type, "tool_result");
    if (block.type !== "tool_result") throw new Error("expected tool result");
    assert.deepEqual(block.content, [
      { type: "text", text: "Screenshot follows" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: smallPng } },
      ...Array.from({ length: 3 }, () => ({ type: "text", text: "[image omitted: unsupported source]" })),
      { type: "text", text: "[content omitted: unsupported type]" },
    ]);
    const before = structuredClone(result);
    for (const cacheControl of [false, true]) {
      const sanitized = sanitizeForCompatible(result, resolveCompatibleCaps(undefined, { cacheControl }));
      const messages = sanitized.json.messages as { content: Json[] }[];
      assert.deepEqual(messages[1]!.content[0]!.content, block.content);
    }
    assert.deepEqual(result, before, "compatibility sanitization never mutates the original images");
  });
}

test("chat history and choices use the same OAuth identity as declarations", () => {
  const result = chatToAnthropic({ tools: [{ type: "function", function: { name: "a.b" } }], tool_choice: { type: "function", function: { name: "a.b" } }, messages: [
    { role: "assistant", tool_calls: [{ type: "function", id: "call_1", function: { name: "a.b", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call_1", content: "ok" },
  ] }, "claude-sonnet-5", "identity");
  assert.equal(result.tools![0]!.name, "custom_a_b");
  assert.equal(result.tool_choice!.name, "custom_a_b");
  const history = result.messages[0]!.content[0]!;
  assert.equal(history.type, "tool_use");
  if (history.type === "tool_use") assert.equal(history.name, "custom_a_b");
});

test("history remains reversible after its tool declaration is removed", () => {
  const body = { input: [
    { type: "custom_tool_call", call_id: "old", name: "exec.code", namespace: "old.api", input: customInput },
    { type: "custom_tool_call_output", call_id: "old", output: "done" },
  ] };
  const table = new ToolTranslation(body, true);
  const result = responsesToAnthropic(body, "claude-sonnet-5", "identity", undefined, table);
  assert.equal(result.tools, undefined);
  const block = result.messages[0]!.content[0]!;
  assert.equal(block.type, "tool_use");
  if (block.type !== "tool_use") throw new Error("expected tool history");
  assert.deepEqual(block.input, { input: customInput });
  assert.deepEqual(table.fromWire(block.name), { kind: "custom", name: "exec.code", namespace: "old.api" });
});

test("malformed custom wrappers and unknown upstream names never become executable calls", () => {
  const table = new ToolTranslation({ tools });
  const mapper = new ResponsesEventMapper("claude-sonnet-5", table);
  assert.throws(() => mapper.feed({ type: "content_block_start", index: 0, content_block: { type: "tool_use", name: "unknown" } }), /unknown tool/);
  mapper.feed({ type: "content_block_start", index: 0, content_block: { type: "tool_use", name: table.toWire(identities[1]!) } });
  mapper.feed({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"input":42}' } });
  assert.throws(() => mapper.feed({ type: "content_block_stop", index: 0 }), /string input/);
  assert.throws(() => mapper.finish(), /before its input was complete/);
  const malformed = new ResponsesEventMapper("claude-sonnet-5", table);
  malformed.feed({ type: "content_block_start", index: 0, content_block: { type: "tool_use", name: table.toWire(identities[1]!) } });
  malformed.feed({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "private malformed input" } });
  assert.throws(() => malformed.feed({ type: "content_block_stop", index: 0 }), { message: "Custom tool response contains invalid JSON" });
});

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
}

for (const native of [false, true]) {
  test(`server tool-result images follow provider type (${native ? "native" : "compatible"})`, async (t) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-ingress-images-"));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const seen: Json[] = [];
    const upstream = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        seen.push(JSON.parse(Buffer.concat(chunks).toString()) as Json);
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ content: [{ type: "text", text: "done" }], stop_reason: "end_turn" }));
      });
    });
    const upstreamPort = await listen(upstream);
    t.after(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
    const url = `http://127.0.0.1:${upstreamPort}`;
    const config: Config = {
      listen: { host: "127.0.0.1", port: 0, openaiPort: 0 }, upstream: "api.anthropic.com",
      providers: { target: native ? { type: "anthropic", auth: "api-key", apiKey: "fake-test-key" } : { type: "anthropic-compatible", url, headers: {} } },
      routes: {}, aliases: {}, direct: [{ prefix: "claude-", provider: "target" }], effortClamp: {}, cli: { extraModels: [] },
      health: { maxConsecutiveUpstreamFailures: 20 }, log: { maxBytes: 1e6, keep: 1 },
    };
    const ingress = new OpenAiIngress({ config: () => config, log: new Logger(null, 1e9, 0, false), requests: new RequestLog(path.join(home, "requests.jsonl")), home, nativeUpstream: url });
    const port = await ingress.listen();
    t.after(() => ingress.drain(1));
    for (const kind of ["function", "custom"]) {
      const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-5", tools: [{ type: kind, name: "inspect" }], input: [
          { type: kind === "custom" ? "custom_tool_call" : "function_call", call_id: "inspect_1", name: "inspect", input: "", arguments: "{}" },
          { type: kind === "custom" ? "custom_tool_call_output" : "function_call_output", call_id: "inspect_1", output: [{ type: "input_image", image_url: `data:image/png;base64,${smallPng}` }] },
        ] }),
      });
      assert.equal(response.status, 200);
      await response.text();
      const messages = seen.at(-1)!.messages as { content: Json[] }[];
      assert.deepEqual(messages[1]!.content[0]!.content, native
        ? [{ type: "image", source: { type: "base64", media_type: "image/png", data: smallPng } }]
        : [{ type: "text", text: "[image omitted: this model does not take images]" }]);
    }
    assert.equal(seen.length, 2);
  });
}

for (const oauth of [false, true]) for (const stream of [false, true]) for (const upstreamSse of [false, true]) {
  test(`tool definition → response → history round trip (${oauth ? "OAuth" : "API key"}, client ${stream ? "SSE" : "JSON"}, upstream ${upstreamSse ? "SSE" : "JSON"})`, async (t) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-ingress-tools-"));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const seen: Json[] = [];
    const upstream = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString()) as Json;
        seen.push(body);
        const definitions = body.tools as { name: string }[];
        const blocks = definitions.map((tool, index) => ({ type: "tool_use", id: `call_${index}`, name: tool.name, input: identities[index]!.kind === "custom" ? { input: customInput } : { path: "a.ts" } }));
        if (!upstreamSse) {
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ content: blocks, stop_reason: "tool_use" }));
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        const events: Json[] = [{ type: "message_start", message: {} }];
        for (const [index, block] of blocks.entries()) {
          const encoded = JSON.stringify(block.input);
          events.push({ type: "content_block_start", index, content_block: { ...block, input: {} } });
          // Split inside escaped Unicode/string content, not just on JSON boundaries.
          for (let at = 0; at < encoded.length; at += 3) events.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: encoded.slice(at, at + 3) } });
          events.push({ type: "content_block_stop", index });
        }
        events.push({ type: "message_delta", delta: { stop_reason: "tool_use" } }, { type: "message_stop" });
        res.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
      });
    });
    const upstreamPort = await listen(upstream);
    t.after(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
    const config: Config = {
      listen: { host: "127.0.0.1", port: 0, openaiPort: 0 }, upstream: "api.anthropic.com",
      providers: { claude: oauth ? { type: "anthropic", auth: "claude-code" } : { type: "anthropic", auth: "api-key", apiKey: "fake-test-key" } },
      routes: {}, aliases: {}, direct: [], effortClamp: {}, cli: { extraModels: [] },
      health: { maxConsecutiveUpstreamFailures: 20 }, log: { maxBytes: 1e6, keep: 1 },
    };
    const warnings: string[] = [];
    const log = new Logger(null, 1e9, 0, false);
    log.warn = (message) => { warnings.push(message); };
    const current = new ClaudeCodeAuthStore(new ClaudeCodeCredentialStore(() => null), { home, env: { CLAUDE_CODE_OAUTH_TOKEN: "fake-test-token" } });
    const ingress = new OpenAiIngress({ config: () => config, log, requests: new RequestLog(path.join(home, "requests.jsonl")), home,
      claudeAccounts: new ClaudeAccountAuthPool({ home, current, log }), nativeUpstream: `http://127.0.0.1:${upstreamPort}` });
    const port = await ingress.listen();
    t.after(() => ingress.drain(1));
    const call = async (body: Json) => {
      const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: "POST", body: JSON.stringify({ model: "claude-sonnet-5", ...body }), headers: { "content-type": "application/json" } });
      return { status: response.status, text: await response.text() };
    };
    const first = await call({ tools, tool_choice: "required", input: "run tools", stream });
    assert.equal(first.status, 200);
    let output: Json[];
    if (stream) {
      const events = first.text.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)) as Json);
      assert.deepEqual(events.map((event) => event.sequence_number), events.map((_, index) => index));
      const addedCustom = events.filter((event) => event.type === "response.output_item.added" && (event.item as Json).type === "custom_tool_call");
      assert.ok(addedCustom.every((event) => (event.item as Json).input === "" && (event.item as Json).status === "in_progress"));
      assert.deepEqual((events[0]!.response as Json).output, [], "created event is an immutable snapshot");
      assert.equal(events.filter((event) => event.type === "response.custom_tool_call_input.done").length, 3);
      const deltas = events.filter((event) => event.type === "response.custom_tool_call_input.delta");
      assert.deepEqual(deltas.map((event) => event.delta), [customInput, customInput, customInput]);
      assert.equal(events.filter((event) => event.type === "response.function_call_arguments.done").length, 6);
      output = (events.at(-1)!.response as { output: Json[] }).output;
      assert.deepEqual(events.filter((event) => event.type === "response.output_item.done").map((event) => event.item), output);
    } else output = (JSON.parse(first.text) as { output: Json[] }).output;
    assert.equal(output.length, identities.length);
    for (const [index, identity] of identities.entries()) {
      const item = output[index]!;
      assert.equal(item.type, identity.kind === "custom" ? "custom_tool_call" : "function_call");
      assert.equal(item.name, identity.name);
      assert.equal(item.namespace, identity.namespace);
      assert.equal(item.call_id, `call_${index}`);
      if (identity.kind === "custom") { assert.equal(item.input, customInput); assert.equal(item.arguments, undefined); }
      else assert.deepEqual(JSON.parse(item.arguments as string), { path: "a.ts" });
    }
    const nextInput = output.flatMap((item) => [item, { type: item.type === "custom_tool_call" ? "custom_tool_call_output" : "function_call_output", call_id: item.call_id, output: "done" }]);
    const next = await call({ tools, input: nextInput, stream, tool_choice: { type: "custom", name: "exec", namespace: "files.api" } });
    assert.equal(next.status, 200);
    assert.deepEqual(seen[1]!.tool_choice, { type: "tool", name: (seen[1]!.tools as { name: string }[])[3]!.name });
    const replay = seen[1]!.messages as { content: Json[] }[];
    const uses = replay.flatMap((message) => message.content).filter((block) => block.type === "tool_use");
    const results = replay.flatMap((message) => message.content).filter((block) => block.type === "tool_result");
    assert.equal(uses.length, identities.length);
    assert.equal(results.length, identities.length);
    assert.deepEqual(uses.map((use) => use.name), (seen[0]!.tools as { name: string }[]).map((tool) => tool.name));
    for (const [index, use] of uses.entries()) {
      assert.deepEqual(use.input, identities[index]!.kind === "custom" ? { input: customInput } : { path: "a.ts" });
      assert.equal(results[index]!.tool_use_id, use.id);
      assert.equal(results[index]!.content, "done");
    }
    const rejected = await call({ tools: [{ type: "web_search", name: "search", description: "private-content" }], tool_choice: "required", input: "private-input" });
    assert.equal(rejected.status, 400);
    assert.match(rejected.text, /no supported tools remain/);
    assert.equal(seen.length, 2, "invalid requirements never reach upstream");
    assert.ok(warnings.some((line) => line.includes('"type":"web_search"')));
    assert.ok(warnings.every((line) => !line.includes("private-content") && !line.includes("private-input")));
  });
}
