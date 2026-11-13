// A model Google adds to Cloud Code Assist is listed and callable without a change to the tables in
// antigravity.ts: the catalogue itself says whether its ids are a tier family and whether only the
// CLI client family is served it. Shapes follow the catalogue measured 2026-11-13 (daily host, one
// Google AI Pro account); `gemini-5-neon`, `gemini-5-solo` and the `gemini-6-*` ids are invented
// stand-ins for models that do not exist yet. No live call: a fake fetch answers for both hosts.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { GoogleAdapter, isGroupQuotaExhausted, LEARNED_MODELS_FILE } from "../src/providers/google/index.ts";
import {
  antigravityUserAgentFor,
  fetchAvailableModels,
  fetchHostCatalogue,
  LearnedCatalogue,
  parseHostCatalogue,
  resolveAntigravityWireModel,
  servedToAntigravityCli,
  staticAntigravityModels,
} from "../src/providers/google/antigravity.ts";
import { antigravityQuotaScope, GoogleUsage } from "../src/providers/google/usage.ts";
import { createTransport } from "../src/providers/google/transport.ts";
import { saveGoogleAccount } from "../src/providers/google/accounts.ts";
import { Logger } from "../src/log.ts";
import type { AnthropicRequest } from "../src/providers/chatgpt/translate.ts";
import type { GeminiRequest } from "../src/providers/google/translate.ts";

const log = new Logger(null, 1e9, 0, false);
const tempHome = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "cr-google-learned-"));
const DAILY = "https://daily-cloudcode-pa.googleapis.com";
const PROD = "https://cloudcode-pa.googleapis.com";
const HOSTS = [DAILY, PROD];

const entry = (name: string, more: Record<string, unknown> = {}): Record<string, unknown> => ({ displayName: name, maxTokens: 1_048_576, supportsThinking: true, ...more });
/**
 * A `fetchAvailableModels` body. As in the measured answers, `models{}` describes more than the
 * agent list names: `unlisted` entries are described and not listed, and `tieredFlash` ids are
 * listed under `tieredModelIds.flash` alone.
 */
const catalogue = (models: Record<string, unknown>, more: { unlisted?: Record<string, unknown>; tieredFlash?: Record<string, unknown> } = {}): Record<string, unknown> => ({
  models: { ...models, ...more.unlisted, ...more.tieredFlash },
  agentModelSorts: [{ displayName: "Recommended", groups: [{ modelIds: Object.keys(models) }] }],
  ...(more.tieredFlash ? { tieredModelIds: { flash: Object.keys(more.tieredFlash) } } : {}),
});
const tiersOf = (base: string, tiers: string[]): Record<string, unknown> => Object.fromEntries(tiers.map((t) => [`${base}-${t}`, entry(`${base} (${t})`)]));

// What the IDE client family is listed: Flash 3.8's tiers and the Claude tier ids.
const ideModels = {
  "gemini-3.8-flash-high": entry("Gemini 3.8 Flash (High)", { thinkingLevel: 3 }),
  "gemini-3.8-flash-low": entry("Gemini 3.8 Flash (Low)", { thinkingLevel: 1 }),
  "claude-opus-5-5-low": entry("Claude Opus 5.5 (Low)", { thinkingLevel: 1, maxTokens: 1_000_000 }),
  "claude-opus-5-5-high": entry("Claude Opus 5.5 (High)", { thinkingLevel: 3, maxTokens: 1_000_000 }),
};
// What the CLI family is listed beside it: Argon, a new four-tier family, a new single id, and a
// model the plan does not include.
const neonTiers = ["high", "xhigh", "medium", "low"].map((t) => `gemini-5-neon-${t}`);
const cliModels = {
  "gemini-4-argon-medium": entry("Gemini 4 Argon (Medium)", { thinkingLevel: 2 }),
  "gemini-4-argon-low": entry("Gemini 4 Argon (Low)", { thinkingLevel: 1 }),
  ...Object.fromEntries(neonTiers.map((id) => [id, entry(`Gemini 5 Neon (${id.endsWith("xhigh") ? "XHigh" : "High"})`, { maxTokens: 2_000_000 })])),
  "gemini-5-solo-high": entry("Gemini 5 Solo (High)"),
  "gemini-4-carbon-disabled": entry("Gemini 4 Carbon", { disabled: true, tagTitle: "Unavailable" }),
  ...ideModels,
};
const ideBody = catalogue(ideModels);
const cliBody = catalogue(cliModels);
const isCliAsk = (init?: RequestInit): boolean => String(new Headers(init?.headers).get("user-agent")).startsWith("antigravity/cli/");

/** Both hosts answer alike unless an override names one host's answer; `null` is a failed ask. */
const fakeCatalogues = (over: { dailyIde?: unknown; dailyCli?: unknown; prodIde?: unknown; prodCli?: unknown } = {}) =>
  (async (url: string, init?: RequestInit) => {
    const cli = isCliAsk(init);
    const key = `${url.startsWith(`${PROD}/`) ? "prod" : "daily"}${cli ? "Cli" : "Ide"}` as keyof typeof over;
    const body = key in over ? over[key] : cli ? cliBody : ideBody;
    return body === null ? new Response("no", { status: 500 }) : Response.json(body);
  }) as unknown as typeof fetch;
/** Every ask on every host answers `body`. */
const allAnswer = (body: unknown) => (async () => Response.json(body)) as unknown as typeof fetch;

/** One provider's read: its own `LearnedCatalogue`, as the adapter keeps one. */
async function read(fetchImpl: typeof fetch, learned = new LearnedCatalogue(undefined, HOSTS)) {
  const merged = await fetchAvailableModels("tok", "proj", { fetchImpl, learned });
  assert.ok(merged, "the catalogue answered");
  return { learned, merged };
}
const spent = (model: string): string => JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "QUOTA_EXHAUSTED", metadata: { model } }] } });

test("a new tier family collapses to one row with the ladder its ids name", () => {
  const parsed = parseHostCatalogue(catalogue(cliModels, {
    unlisted: { "chat-internal": entry("Internal"), ...tiersOf("gemini-9-hidden", ["low", "high"]) },
    tieredFlash: { "gemini-5-tiered-only": entry("Listed under tieredModelIds only") },
  }));
  assert.deepEqual(parsed?.models.find((m) => m.id === "gemini-5-neon"), { id: "gemini-5-neon", name: "Gemini 5 Neon", contextWindow: 2_000_000, effortLevels: ["low", "medium", "high", "xhigh"] });
  assert.deepEqual(parsed?.families, { "gemini-5-neon": ["low", "medium", "high", "xhigh"] });
  const ids = parsed?.models.map((m) => m.id) ?? [];
  assert.equal(ids.filter((id) => id.startsWith("gemini-5-neon")).length, 1, "the four wire ids are one row");
  assert.ok(neonTiers.every((id) => parsed?.wireIds.includes(id)), "and stay known as wire ids for host routing");
  assert.ok(ids.includes("gemini-5-solo-high"), "one suffixed id alone is a whole model name, as gpt-oss-120b-medium is");
  assert.ok(!ids.some((id) => id.startsWith("gemini-4-carbon")), "a model the catalogue marks disabled is not offered");
  assert.ok(ids.includes("claude-opus-5-5-low") && ids.includes("claude-opus-5-5-high") && !ids.includes("claude-opus-5-5"), "Claude tier ids stay separate rows");
  assert.deepEqual(parsed?.models.find((m) => m.id === "gemini-3.8-flash")?.effortLevels, ["low", "medium", "high"], "a table model keeps its written ladder");
  assert.deepEqual(parsed?.models.find((m) => m.id === "gemini-4-argon")?.effortLevels, ["low", "medium", "high"]);
  assert.ok(!ids.includes("chat-internal") && !ids.some((id) => id.startsWith("gemini-9-hidden")), "an id that models{} describes and the agent list does not name is not offered");
  assert.ok(ids.includes("gemini-5-tiered-only"), "an id listed under tieredModelIds.flash alone is");
});

test("a base id that is itself listed is not a family; minimal and max are tiers; disabled is the flag, not the name", () => {
  const withBase = parseHostCatalogue(catalogue({ "gemini-6-a": entry("A"), "gemini-6-a-low": entry("A low"), "gemini-6-a-high": entry("A high") }));
  assert.deepEqual(withBase?.models.map((m) => m.id), ["gemini-6-a", "gemini-6-a-low", "gemini-6-a-high"]);
  assert.equal(withBase?.families, undefined);

  const minimal = parseHostCatalogue(catalogue({ "gemini-6-b-minimal": entry("B (Minimal)"), "gemini-6-b-high": entry("B (High)") }));
  assert.deepEqual(minimal?.models, [{ id: "gemini-6-b", name: "B", contextWindow: 1_048_576, effortLevels: ["high"] }], "minimal is a wire tier, not a picker effort");
  assert.deepEqual(minimal?.families, { "gemini-6-b": ["minimal", "high"] });

  const max = parseHostCatalogue(catalogue({ "gemini-6-m-low": entry("M (Low)"), "gemini-6-m-max": entry("M (Max)") }));
  assert.deepEqual(max?.models, [{ id: "gemini-6-m", name: "M", contextWindow: 1_048_576, effortLevels: ["low", "max"] }]);

  // The flag decides, whatever the id is called; a disabled tier is no tier of the family.
  const flags = parseHostCatalogue(catalogue({
    "gemini-6-preview": entry("Preview", { disabled: true }),
    "gemini-6-kept-disabled": entry("Named disabled, not flagged", { disabled: false }),
    "gemini-6-d-low": entry("D (Low)"), "gemini-6-d-high": entry("D (High)"), "gemini-6-d-xhigh": entry("D (XHigh)", { disabled: true }),
  }));
  assert.deepEqual(flags?.models.map((m) => m.id), ["gemini-6-kept-disabled", "gemini-6-d"]);
  assert.deepEqual(flags?.families, { "gemini-6-d": ["low", "high"] });
  assert.ok(!flags?.wireIds.includes("gemini-6-d-xhigh") && !flags?.wireIds.includes("gemini-6-preview"));
  // A disabled table model is listed as before: only models outside the tables are filtered.
  const argon = parseHostCatalogue(catalogue({ "gemini-4-argon-low": entry("Gemini 4 Argon (Low)", { disabled: true }) }));
  assert.deepEqual(argon?.models.map((m) => m.id), ["gemini-4-argon"]);
});

test("the host catalogue takes what only the CLI answer lists and says what each client family was listed", async () => {
  const host = await fetchHostCatalogue("tok", "proj", DAILY, fakeCatalogues());
  assert.deepEqual(host?.models.map((m) => m.id), ["gemini-3.8-flash", "claude-opus-5-5-low", "claude-opus-5-5-high", "gemini-4-argon", "gemini-5-neon", "gemini-5-solo-high"]);
  assert.deepEqual(host?.clients, {
    ide: ["claude-opus-5-5-low", "claude-opus-5-5-high"],
    cli: [...neonTiers, "gemini-5-solo-high", "claude-opus-5-5-low", "claude-opus-5-5-high"],
  }, "Argon and Flash are in the tables, so they are not among what is learned; the disabled model is not listed at all");
  assert.deepEqual(host?.families, { "gemini-5-neon": ["low", "medium", "high", "xhigh"] });
  const noCli = await fetchHostCatalogue("tok", "proj", DAILY, fakeCatalogues({ dailyCli: null }));
  assert.deepEqual(noCli?.clients, { ide: ["claude-opus-5-5-low", "claude-opus-5-5-high"] }, "a CLI ask that did not answer says nothing, which is not the same as listing nothing");
});

test("without a catalogue an unknown id passes through under the IDE User-Agent, and one provider's learning is not another's", async () => {
  for (const learned of [undefined, new LearnedCatalogue()]) {
    assert.deepEqual(resolveAntigravityWireModel("gemini-5-neon", "high", learned), { wire: "gemini-5-neon", known: false });
    assert.match(antigravityUserAgentFor("gemini-5-neon-high", learned), /^antigravity\/ide\//);
    assert.equal(antigravityQuotaScope("gemini-5-neon-high", learned), "gemini");
  }
  // What one provider read is its own: nothing is kept at module level.
  const { learned } = await read(fakeCatalogues());
  assert.equal(resolveAntigravityWireModel("gemini-5-neon", "high", learned).wire, "gemini-5-neon-high");
  assert.deepEqual(resolveAntigravityWireModel("gemini-5-neon", "high"), { wire: "gemini-5-neon", known: false });
  assert.deepEqual(resolveAntigravityWireModel("gemini-5-neon", "high", new LearnedCatalogue()), { wire: "gemini-5-neon", known: false });
  assert.equal(servedToAntigravityCli("gemini-5-neon-high"), false);
  assert.equal(antigravityQuotaScope("gemini-5-neon"), "gemini");
});

test("a learned CLI-only family resolves by tier, carries the CLI User-Agent and has a quota scope of its own", async () => {
  const { learned, merged } = await read(fakeCatalogues());
  assert.equal(merged.learnedChanged, true);
  assert.equal((await read(fakeCatalogues(), learned)).merged.learnedChanged, false, "the same read changes nothing");
  assert.deepEqual(learned.family("gemini-5-neon"), ["low", "medium", "high", "xhigh"]);
  assert.equal(learned.family("gemini-5-solo"), undefined, "one tier id is a whole model name");
  const kept = Object.values(learned.snapshot()).flatMap((lists) => [...(lists.ide ?? []), ...(lists.cli ?? [])]);
  assert.equal(kept.some((id) => id.startsWith("gemini-4-argon") || id.startsWith("gemini-3.8-flash") || id.startsWith("gemini-4-carbon")), false, "nothing is kept about a table model or a disabled one");

  for (const tier of ["low", "medium", "high", "xhigh"]) assert.deepEqual(resolveAntigravityWireModel("gemini-5-neon", tier, learned), { wire: `gemini-5-neon-${tier}`, known: true }, tier);
  assert.equal(resolveAntigravityWireModel("gemini-5-neon", "max", learned).wire, "gemini-5-neon-xhigh", "an effort above the top tier takes the top tier");
  assert.equal(resolveAntigravityWireModel("gemini-5-neon", "ultra", learned).wire, "gemini-5-neon-xhigh");
  assert.equal(resolveAntigravityWireModel("gemini-5-neon", "minimal", learned).wire, "gemini-5-neon-low", "an effort below the lowest tier takes the lowest");
  assert.equal(resolveAntigravityWireModel("gemini-5-neon", "none", learned).wire, "gemini-5-neon-low");
  assert.equal(resolveAntigravityWireModel("gemini-5-neon", undefined, learned).wire, "gemini-5-neon-medium");
  assert.equal(resolveAntigravityWireModel("gemini-5-neon", "constructor", learned).wire, "gemini-5-neon-medium", "an effort is never read off a prototype");
  assert.deepEqual(resolveAntigravityWireModel("gemini-5-neon-high", "low", learned), { wire: "gemini-5-neon-high", known: false }, "a wire id named outright goes as it is");

  const transport = createTransport("antigravity", { learned });
  const req: GeminiRequest = { contents: [{ role: "user", parts: [{ text: "hi" }] }], generationConfig: { thinkingConfig: { thinkingLevel: "high" } } };
  const auth = { accessToken: "T", projectId: "p", conversationKey: "c" };
  const built = transport.build(req, { model: "gemini-5-neon", stream: true, effort: "xhigh", antigravity: auth });
  const body = JSON.parse(built.body) as { model: string; request: { generationConfig?: { thinkingConfig?: unknown } } };
  assert.equal(body.model, "gemini-5-neon-xhigh");
  assert.equal(body.request.generationConfig?.thinkingConfig, undefined, "the suffix names the tier, so no level is sent beside it");
  assert.match(built.headers["user-agent"] ?? "", /^antigravity\/cli\//);
  for (const id of ["gemini-5-neon", "gemini-5-neon-low", "gemini-5-solo-high"]) assert.equal(servedToAntigravityCli(id, learned), true, id);
  for (const id of ["gemini-5-neonate", "gemini-5-neon-ultra", "gemini-5-solo", "gemini-3.8-flash-low", "claude-opus-5-5-high"]) assert.equal(servedToAntigravityCli(id, learned), false, id);

  // A base id and every wire id it resolves to share one scope, so a turn's scope does not depend
  // on which of them names the model.
  for (const id of ["gemini-5-neon", "gemini-5-neon@high", ...neonTiers]) assert.equal(antigravityQuotaScope(id, learned), "gemini-5-neon", id);
  assert.equal(antigravityQuotaScope("gemini-5-solo-high", learned), "gemini-5-solo-high");
  assert.equal(antigravityQuotaScope("gemini-3.8-flash", learned), "gemini");
  assert.equal(antigravityQuotaScope("gemini-4-argon-high", learned), "argon");
  assert.equal(antigravityQuotaScope("claude-opus-5-5-high", learned), "3p");
  assert.equal(isGroupQuotaExhausted(429, spent("gemini-5-neon-high"), "gemini-5-neon", learned), true, "proof that it is spent rests only it");
  assert.equal(isGroupQuotaExhausted(429, spent("gemini-5-neon-high"), "gemini", learned), false);
  assert.equal(isGroupQuotaExhausted(429, spent("gemini-3.8-flash-high"), "gemini-5-neon", learned), false, "and a spent Gemini group does not rest it");
});

test("only Gemini ids are learned as CLI-only: a Claude or GPT-OSS id is listed and sent as it always was", async () => {
  // Daily's CLI answer alone lists a new Claude and a new GPT-OSS id; prod's IDE answer omits the
  // Claude 5.5 ids its CLI answer lists.
  const prodIde = catalogue({ "gemini-3.8-flash-high": ideModels["gemini-3.8-flash-high"], "gemini-3.8-flash-low": ideModels["gemini-3.8-flash-low"] });
  const { learned, merged } = await read(fakeCatalogues({ dailyCli: catalogue({ ...cliModels, "claude-opus-9-low": entry("Claude Opus 9 (Low)"), "gpt-oss-200b": entry("GPT-OSS 200B") }), prodIde }));
  for (const id of ["claude-opus-9-low", "gpt-oss-200b"]) {
    assert.equal(merged.models.some((m) => m.id === id), false, `${id} is not offered: no IDE answer lists it, as before`);
    assert.equal(merged.hosts.has(id), false);
    assert.equal(servedToAntigravityCli(id, learned), false, id);
    assert.equal(learned.hostOf(id), undefined);
    assert.equal(antigravityQuotaScope(id, learned), "3p");
    assert.equal(learned.rows().some((row) => row.id === id), false, "nor is it a fallback row");
  }
  // The Claude 5.5 ids go where an IDE answer lists them, under the IDE User-Agent, although prod's CLI answer lists them too.
  assert.deepEqual(merged.hosts.get("claude-opus-5-5-high"), [DAILY]);
  assert.match(antigravityUserAgentFor("claude-opus-5-5-high", learned), /^antigravity\/ide\//);
  assert.equal(learned.hostOf("claude-opus-5-5-high"), DAILY);
});

test("an id is asked of the lists as Google wrote it, and what the lists do not keep is not offered", async () => {
  // An uppercase letter: the scope must still be the family's own, for the base id and every tier.
  const upper = await read(fakeCatalogues({ dailyCli: catalogue({ ...ideModels, ...tiersOf("gemini-5-Neon", ["low", "high"]) }) }));
  assert.deepEqual(upper.learned.family("gemini-5-Neon"), ["low", "high"]);
  for (const id of ["gemini-5-Neon", "gemini-5-Neon@high", "gemini-5-Neon-low", "gemini-5-Neon-high"]) assert.equal(antigravityQuotaScope(id, upper.learned), "gemini-5-Neon", id);
  assert.equal(isGroupQuotaExhausted(429, spent("gemini-5-Neon-high"), "gemini", upper.learned), false, "its refusal is not proof that the shared Gemini group is spent");
  assert.equal(isGroupQuotaExhausted(429, spent("gemini-5-Neon-high"), "gemini-5-Neon", upper.learned), true);

  // An id the lists refuse (a character outside the kept set, or too long) and the ids past the
  // bound are not offered from the CLI answer either: they would go out under the wrong User-Agent.
  const long = `gemini-8-${"x".repeat(125)}`;
  const many = Object.fromEntries(Array.from({ length: 520 }, (_, i) => [`gemini-9-m${String(i).padStart(3, "0")}`, entry(`M${i}`)]));
  const odd = await read(fakeCatalogues({ dailyCli: catalogue({ ...ideModels, "gemini-8-x:preview": entry("Preview"), [long]: entry("Long"), ...many }), prodCli: ideBody }));
  assert.equal(long.length, 134);
  for (const id of ["gemini-8-x:preview", long]) {
    assert.equal(odd.merged.models.some((m) => m.id === id), false, id);
    assert.equal(servedToAntigravityCli(id, odd.learned), false);
  }
  const kept = odd.learned.snapshot()[DAILY]!.cli!;
  assert.equal(kept.length, 500, "the lists are bounded");
  const offered = odd.merged.models.filter((m) => m.id.startsWith("gemini-9-m"));
  assert.ok(offered.length > 0 && offered.every((m) => kept.includes(m.id) && servedToAntigravityCli(m.id, odd.learned)), "what is offered is exactly what is kept, so it carries the CLI User-Agent");
  assert.equal(odd.merged.models.some((m) => m.id === "gemini-9-m519"), false, "an id past the bound is left out");
});

test("a hostile catalogue answer is read without throwing, and never reaches Object.prototype", async () => {
  const names = ["constructor", "hasOwnProperty", "__proto__", "toString", "isPrototypeOf", "__defineGetter__"];
  const hostile = JSON.parse(JSON.stringify(catalogue({ ...ideModels, "gemini-5-ok-low": entry("ok"), "gemini-5-ok-high": entry("ok") }))) as { models: Record<string, unknown>; agentModelSorts: { groups: { modelIds: string[] }[] }[] };
  for (const name of names) {
    Object.defineProperty(hostile.models, name, { value: entry(name), enumerable: true, configurable: true, writable: true });
    hostile.agentModelSorts[0]!.groups[0]!.modelIds.push(name);
  }
  const { learned, merged } = await read(allAnswer(hostile));
  assert.deepEqual(merged.models.find((m) => m.id === "gemini-5-ok")?.effortLevels, ["low", "high"], "the rest of the answer is still read");
  for (const name of names) {
    assert.deepEqual(resolveAntigravityWireModel(name, "high", learned), { wire: name, known: false }, name);
    assert.deepEqual(merged.models.find((m) => m.id === name)?.effortLevels, undefined, `${name} gets no ladder from a prototype`);
    assert.equal(antigravityQuotaScope(name, learned), undefined);
  }
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  // The same lists as a stored snapshot, and as a provider name, host and id.
  const stored = JSON.parse(`{"__proto__":{"ide":["gemini-7-x-low","gemini-7-x-high"]},"${DAILY}":{"ide":["__proto__","constructor","gemini-7-y-low","gemini-7-y-high"],"__proto__":{"cli":["x"]}}}`) as unknown;
  const restored = new LearnedCatalogue(stored, HOSTS);
  assert.deepEqual(restored.snapshot(), { [DAILY]: { ide: ["constructor", "gemini-7-y-high", "gemini-7-y-low"] } });
  assert.equal(restored.family("gemini-7-x"), undefined);
});

test("a learned family the IDE answer lists keeps the IDE User-Agent and the Gemini scope", async () => {
  const { learned, merged } = await read(allAnswer(catalogue({ ...ideModels, ...tiersOf("gemini-5-open", ["low", "high"]) })));
  assert.deepEqual(merged.models.find((m) => m.id === "gemini-5-open")?.effortLevels, ["low", "high"]);
  assert.equal(resolveAntigravityWireModel("gemini-5-open", "medium", learned).wire, "gemini-5-open-low", "a missing tier takes the nearest one below");
  assert.equal(resolveAntigravityWireModel("gemini-5-open", "xhigh", learned).wire, "gemini-5-open-high");
  assert.match(antigravityUserAgentFor("gemini-5-open-high", learned), /^antigravity\/ide\//);
  assert.equal(antigravityQuotaScope("gemini-5-open-high", learned), "gemini");
  assert.equal(antigravityQuotaScope("gemini-5-open", learned), "gemini");
});

test("a family with a max tier and one with a minimal tier resolve onto the tiers they have", async () => {
  const { learned } = await read(allAnswer(catalogue({ ...ideModels, ...tiersOf("gemini-6-m", ["low", "max"]), ...tiersOf("gemini-6-b", ["minimal", "high"]) })));
  assert.deepEqual(learned.family("gemini-6-m"), ["low", "max"]);
  assert.equal(resolveAntigravityWireModel("gemini-6-m", "max", learned).wire, "gemini-6-m-max");
  assert.equal(resolveAntigravityWireModel("gemini-6-m", "ultra", learned).wire, "gemini-6-m-max");
  assert.equal(resolveAntigravityWireModel("gemini-6-m", "xhigh", learned).wire, "gemini-6-m-low", "the nearest tier below, never a deeper one than asked");
  assert.equal(resolveAntigravityWireModel("gemini-6-b", "none", learned).wire, "gemini-6-b-minimal");
  assert.equal(resolveAntigravityWireModel("gemini-6-b", undefined, learned).wire, "gemini-6-b-minimal", "the default, medium, falls to the tier below it");
  assert.equal(resolveAntigravityWireModel("gemini-6-b", "max", learned).wire, "gemini-6-b-high");
});

test("what is learned never overrides the tables, and a stored snapshot is checked on the way in", () => {
  const learned = new LearnedCatalogue({
    [DAILY]: {
      ide: ["gemini-3.8-flash", "gemini-3.8-flash-low", "gemini-pro-agent", "../../etc", "", 5, null, "claude-sonnet-9-low", "claude-sonnet-9-high", "gemini-7-x-low", "gemini-7-x-high", "gemini-7-x-low", "gemini-7-y-high"],
      cli: "nope",
    },
    "https://evil.example": { cli: ["gemini-7-z-low", "gemini-7-z-high"] },
    [PROD]: null,
  }, HOSTS);
  assert.deepEqual(learned.snapshot(), { [DAILY]: { ide: ["claude-sonnet-9-high", "claude-sonnet-9-low", "gemini-7-x-high", "gemini-7-x-low", "gemini-7-y-high"] } },
    "table ids, malformed ids and a host this provider does not ask are dropped");
  assert.match(antigravityUserAgentFor("gemini-3.8-flash-low", learned), /^antigravity\/ide\//);
  assert.match(antigravityUserAgentFor("gemini-pro-agent", learned), /^antigravity\/ide\//);
  assert.deepEqual(resolveAntigravityWireModel("gemini-3.8-flash", "high", learned), { wire: "gemini-3.8-flash-medium", known: true });
  assert.deepEqual(resolveAntigravityWireModel("gemini-7-y", "high", learned), { wire: "gemini-7-y", known: false }, "one tier is not a family");
  assert.equal(learned.family("claude-sonnet-9"), undefined, "only Gemini ids collapse");
  assert.deepEqual(learned.rows(), [{ id: "claude-sonnet-9-high" }, { id: "claude-sonnet-9-low" }, { id: "gemini-7-x", effortLevels: ["low", "high"] }, { id: "gemini-7-y-high" }]);
  // Without a list of hosts asked, any host's lists are kept, and still no token is ever sent to one
  // of them: a learned host is one of Google's two or nothing.
  const anyHost = new LearnedCatalogue({ "https://evil.example": { cli: ["gemini-7-z-low", "gemini-7-z-high"] } });
  assert.deepEqual(anyHost.family("gemini-7-z"), ["low", "high"]);
  assert.equal(anyHost.hostOf("gemini-7-z-low"), undefined);
  for (const bad of [null, undefined, "x", 7, [], [{ ide: ["gemini-7-x-low"] }]]) assert.deepEqual(new LearnedCatalogue(bad, HOSTS).snapshot(), {});
});

test("a family ends when its bare id is listed, shrinks with its tiers, and a CLI-only mark lapses", async () => {
  // A family, then the same base listed as a model of its own: the base goes out as it is.
  const open = { ...ideModels, ...tiersOf("gemini-5-open", ["low", "high"]) };
  const { learned } = await read(allAnswer(catalogue(open)));
  assert.equal(resolveAntigravityWireModel("gemini-5-open", "high", learned).wire, "gemini-5-open-high");
  const second = await read(allAnswer(catalogue({ ...open, "gemini-5-open": entry("Gemini 5 Open") })), learned);
  assert.equal(second.merged.learnedChanged, true);
  assert.deepEqual(second.merged.models.map((m) => m.id).filter((id) => id.startsWith("gemini-5-open")), ["gemini-5-open-low", "gemini-5-open-high", "gemini-5-open"]);
  assert.deepEqual(resolveAntigravityWireModel("gemini-5-open", "high", learned), { wire: "gemini-5-open", known: false }, "the listed model is called by its own id");
  assert.equal(learned.family("gemini-5-open"), undefined);
  // The bare id on one host alone ends the family on both: one id has one meaning per provider.
  const split = await read(fakeCatalogues({ dailyIde: catalogue(open), dailyCli: catalogue(open), prodIde: catalogue({ ...ideModels, "gemini-5-open": entry("Gemini 5 Open") }), prodCli: catalogue({ ...ideModels, "gemini-5-open": entry("Gemini 5 Open") }) }));
  assert.equal(split.learned.family("gemini-5-open"), undefined);
  assert.ok(!split.merged.models.some((m) => m.id === "gemini-5-open" && m.effortLevels), "and the list offers no ladder for it");

  // A tier Google withdraws leaves the ladder and the fallback rows; one tier left is no family.
  const g = await read(allAnswer(catalogue({ ...ideModels, ...tiersOf("gemini-5-g", ["low", "medium", "high"]) })));
  await read(allAnswer(catalogue({ ...ideModels, ...tiersOf("gemini-5-g", ["low", "high"]) })), g.learned);
  assert.deepEqual(g.learned.family("gemini-5-g"), ["low", "high"]);
  assert.equal(resolveAntigravityWireModel("gemini-5-g", "medium", g.learned).wire, "gemini-5-g-low");
  assert.deepEqual(g.learned.rows().filter((row) => row.id.startsWith("gemini-5-g")), [{ id: "gemini-5-g", effortLevels: ["low", "high"] }], "the withdrawn tier is not a row of its own");
  await read(allAnswer(catalogue({ ...ideModels, ...tiersOf("gemini-5-g", ["high"]) })), g.learned);
  assert.deepEqual(resolveAntigravityWireModel("gemini-5-g", "high", g.learned), { wire: "gemini-5-g", known: false });
  assert.deepEqual(g.learned.rows().filter((row) => row.id.startsWith("gemini-5-g")), [{ id: "gemini-5-g-high" }]);

  // CLI-only until an IDE answer lists it.
  const neon = await read(fakeCatalogues());
  assert.equal(servedToAntigravityCli("gemini-5-neon-high", neon.learned), true);
  assert.equal(servedToAntigravityCli("gemini-5-solo-high", neon.learned), true);
  // A read whose CLI ask failed says nothing about what the CLI family is listed, so nothing is taken back.
  const failed: string[] = [];
  const third = await fetchAvailableModels("tok", "proj", { fetchImpl: fakeCatalogues({ dailyCli: null, prodCli: null }), learned: neon.learned, cliFailed: (host) => failed.push(host) });
  assert.deepEqual(failed.sort(), [PROD, DAILY].sort());
  assert.equal(third?.learnedChanged, false);
  assert.equal(servedToAntigravityCli("gemini-5-neon-high", neon.learned), true);
  assert.equal(resolveAntigravityWireModel("gemini-5-neon", "xhigh", neon.learned).wire, "gemini-5-neon-xhigh");
  // Google now lists both for the IDE family too.
  assert.equal((await read(allAnswer(cliBody), neon.learned)).merged.learnedChanged, true);
  assert.equal(servedToAntigravityCli("gemini-5-neon-high", neon.learned), false);
  assert.equal(servedToAntigravityCli("gemini-5-solo-high", neon.learned), false);
  assert.equal(resolveAntigravityWireModel("gemini-5-neon", "high", neon.learned).wire, "gemini-5-neon-high", "the family is still a family");
  assert.equal(antigravityQuotaScope("gemini-5-neon-high", neon.learned), "gemini");
});

test("a family the IDE lists in part: each tier takes its own User-Agent, the family one scope, and Gemini's windows are no evidence for it", async () => {
  // The IDE answer lists low and high; the CLI answer lists those and an xhigh tier of its own.
  const ide = catalogue({ ...ideModels, ...tiersOf("gemini-5-neon", ["low", "high"]) });
  const cli = catalogue({ ...ideModels, ...tiersOf("gemini-5-neon", ["low", "high", "xhigh"]) });
  const { learned, merged } = await read(fakeCatalogues({ dailyIde: ide, dailyCli: cli, prodIde: ide, prodCli: cli }));
  assert.deepEqual(merged.models.filter((m) => m.id.startsWith("gemini-5-neon")).map((m) => [m.id, m.effortLevels]), [["gemini-5-neon", ["low", "high", "xhigh"]]], "one row, no second row for a tier");
  assert.match(antigravityUserAgentFor("gemini-5-neon-low", learned), /^antigravity\/ide\//);
  assert.match(antigravityUserAgentFor("gemini-5-neon-xhigh", learned), /^antigravity\/cli\//);
  assert.equal(servedToAntigravityCli("gemini-5-neon", learned), false, "the base id is CLI-only only when every tier is");
  // The turn is asked by the base id and answered about by the wire id: both must name one scope.
  const scope = antigravityQuotaScope("gemini-5-neon", learned);
  assert.equal(scope, "gemini-5-neon");
  for (const effort of ["low", "medium", "high", "xhigh", "max", undefined]) {
    const wire = resolveAntigravityWireModel("gemini-5-neon", effort, learned).wire;
    assert.equal(antigravityQuotaScope(wire, learned), scope, `${effort} → ${wire}`);
    assert.equal(isGroupQuotaExhausted(429, spent(wire), scope!, learned), true, `a spent ${wire} rests only the family`);
  }
  assert.equal(isGroupQuotaExhausted(429, spent("gemini-3.8-flash-low"), scope!, learned), false);

  const now = Date.parse("2026-10-15T00:00:00Z");
  const bucket = (id: string, window: string) => ({ bucketId: id, displayName: window, window, resetTime: "2026-10-15T03:00:00Z", remainingFraction: 0.9 });
  const summary = { groups: [
    { displayName: "Gemini Models", buckets: [bucket("gemini-weekly", "weekly"), bucket("gemini-5h", "5h")] },
    { displayName: "Claude and GPT models", buckets: [bucket("3p-weekly", "weekly"), bucket("3p-5h", "5h")] },
  ] };
  const account = { ownerId: "acct-1", accessToken: "tok", projectId: "proj" };
  const usage = new GoogleUsage({ credentials: async () => [account] } as never, { baseUrl: "https://daily.test", fetch: allAnswer(summary), now: () => now, warn: () => {}, learned });
  await usage.snapshot();
  assert.equal(usage.hasRemainingQuota(account, "gemini-3.8-flash", "https://daily.test"), true);
  for (const id of ["gemini-5-neon", "gemini-5-neon@xhigh", "gemini-5-neon-low", "gemini-5-neon-xhigh"]) {
    assert.equal(usage.hasRemainingQuota(account, id, "https://daily.test"), false, `${id}: room in the Gemini windows says nothing about a bucket that was never measured`);
  }
});

test("a model an IDE answer lists goes to such a host under the IDE User-Agent, and a tier goes to a host that lists it", async () => {
  // Prod lists the Neon family in its IDE answer; daily lists it for the CLI family alone.
  const prodIde = catalogue({ ...ideModels, ...Object.fromEntries(neonTiers.map((id) => [id, entry("Gemini 5 Neon (High)")])) });
  const { learned, merged } = await read(fakeCatalogues({ prodIde, prodCli: prodIde }));
  assert.deepEqual(merged.hosts.get("gemini-5-neon"), [PROD], "offered where the IDE family is served it; daily's CLI-only listing adds nothing");
  assert.deepEqual(merged.hosts.get("gemini-5-neon-high"), [PROD]);
  assert.equal(merged.models.filter((m) => m.id.startsWith("gemini-5-neon")).length, 1);
  assert.match(antigravityUserAgentFor("gemini-5-neon-high", learned), /^antigravity\/ide\//);
  assert.equal(learned.hostOf("gemini-5-neon-high"), PROD, "and the stored lists send it to the same host when there is no host map");
  assert.equal(antigravityQuotaScope("gemini-5-neon", learned), "gemini");
  const transport = createTransport("antigravity", { learned });
  const built = transport.build({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }, { model: "gemini-5-neon", stream: true, effort: "high", antigravity: { accessToken: "T", projectId: "p", conversationKey: "c" }, antigravityBaseUrl: PROD });
  assert.match(built.headers["user-agent"] ?? "", /^antigravity\/ide\//);
  assert.deepEqual(merged.hosts.get("gemini-5-solo-high"), [DAILY], "an id only daily's CLI answer lists is offered there alone");
  assert.match(antigravityUserAgentFor("gemini-5-solo-high", learned), /^antigravity\/cli\//);

  // One view of the lists does not move when a later read is taken in.
  const view = learned.view();
  await read(allAnswer(ideBody), learned);
  assert.equal(learned.family("gemini-5-neon"), undefined);
  assert.deepEqual(view.family("gemini-5-neon"), ["low", "medium", "high", "xhigh"]);
  assert.equal(view.hostOf("gemini-5-neon-high"), PROD);

  // An IDE family whose tiers the hosts share out: the stored lists still say where each tier lives.
  const shared = await read(fakeCatalogues({
    dailyIde: catalogue({ ...ideModels, ...tiersOf("gemini-6-d", ["low", "high"]) }), dailyCli: catalogue({ ...ideModels, ...tiersOf("gemini-6-d", ["low", "high"]) }),
    prodIde: catalogue({ ...ideModels, ...tiersOf("gemini-6-d", ["medium", "xhigh"]) }), prodCli: catalogue({ ...ideModels, ...tiersOf("gemini-6-d", ["medium", "xhigh"]) }),
  }));
  assert.deepEqual(shared.learned.family("gemini-6-d"), ["low", "medium", "high", "xhigh"]);
  assert.deepEqual(shared.merged.hosts.get("gemini-6-d-medium"), [PROD]);
  const restarted = new LearnedCatalogue(JSON.parse(JSON.stringify(shared.learned.snapshot())), HOSTS);
  assert.equal(restarted.hostOf("gemini-6-d-medium"), PROD);
  assert.equal(restarted.hostOf("gemini-6-d-low"), DAILY);
  assert.equal(restarted.hostOf("gemini-6-d-max"), undefined);

  // A provider that pins one host keeps that host's lists only: a tier the other host lists is not its tier.
  const pinned = new LearnedCatalogue(JSON.parse(JSON.stringify(shared.learned.snapshot())), [DAILY]);
  assert.deepEqual(pinned.family("gemini-6-d"), ["low", "high"]);
  assert.equal(resolveAntigravityWireModel("gemini-6-d", "xhigh", pinned).wire, "gemini-6-d-high");
});

// ── Through the adapter ─────────────────────────────────────────────────────────────────────────

type Call = { url: string; model: unknown; ua: string };
/** Global fetch for one test: `catalogues` answers `:fetchAvailableModels`, every turn answers "Hi". */
function upstream(t: TestContext, catalogues: (url: string, init?: RequestInit) => Promise<Response>, generate?: (model: string) => Response | undefined) {
  const calls: Call[] = [];
  const asks: string[] = [];
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes(":fetchAvailableModels")) {
      asks.push(url);
      return catalogues(url, init);
    }
    if (url.includes(":streamGenerateContent") || url.includes(":generateContent")) {
      const model = (JSON.parse(String(init?.body ?? "{}")) as { model?: unknown }).model;
      calls.push({ url, model, ua: String(new Headers(init?.headers).get("user-agent")) });
      const other = generate?.(String(model));
      if (other) return other;
      const frame = { response: { candidates: [{ content: { parts: [{ text: "Hi" }] } }, { finishReason: "STOP" }] } };
      return new Response(`data: ${JSON.stringify(frame)}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  return { calls, asks };
}

/** One streamed turn through the adapter, as a client sees it. */
async function turn(adapter: GoogleAdapter, model: string, effort: string): Promise<{ status: number; body: string }> {
  const front = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => void adapter.handle(req, res, "/v1/messages", JSON.parse(Buffer.concat(chunks).toString("utf8")) as AnthropicRequest, model, effort));
  });
  await new Promise<void>((r) => front.listen(0, "127.0.0.1", r));
  try {
    return await new Promise((resolve, reject) => {
      const raw = JSON.stringify({ model, stream: true, max_tokens: 16, messages: [{ role: "user", content: "hi" }] });
      const req = http.request({ host: "127.0.0.1", port: (front.address() as { port: number }).port, method: "POST", path: "/v1/messages", headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(raw)) } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("error", reject);
      req.end(raw);
    });
  } finally {
    front.close();
  }
}
const answered = (result: { status: number; body: string }): void => {
  assert.equal(result.status, 200);
  assert.match(result.body, /"text":"Hi"/, "the model's answer reaches the client");
  assert.match(result.body, /event: message_stop/);
  assert.doesNotMatch(result.body, /event: error/);
};
function homeWithAccount(t: TestContext): string {
  const home = tempHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  saveGoogleAccount(home, { accessToken: "tok", refreshToken: "rt", projectId: "proj", email: "a@example.test", expiresAt: Date.now() + 24 * 3_600_000 });
  return home;
}
type Stored = { version: number; providers: Record<string, Record<string, { ide?: string[]; cli?: string[] }>> };
const storedIn = (home: string): Stored => JSON.parse(fs.readFileSync(path.join(home, LEARNED_MODELS_FILE), "utf8")) as Stored;
// Only prod's CLI answer lists the new models; daily's is the IDE list plus Argon.
const dailyCliWithoutNew = catalogue(Object.fromEntries(Object.entries(cliModels).filter(([id]) => !id.startsWith("gemini-5-"))));
const cfg = { type: "google" as const, auth: "antigravity" as const, models: [{ id: "gemini-3.8-flash" }, { id: "gemini-5-neon" }] };

test("through the adapter: a learned model is called on its wire id, host and User-Agent, and survives a start with no catalogue", async (t) => {
  const home = homeWithAccount(t);
  let catalogueDown = false;
  const healthy = fakeCatalogues({ dailyCli: dailyCliWithoutNew }) as unknown as (url: string, init?: RequestInit) => Promise<Response>;
  const { calls } = upstream(t, async (url, init) => catalogueDown ? new Response("boom", { status: 500 }) : healthy(url, init));

  const first = new GoogleAdapter("ag", cfg, home, log);
  assert.ok((await first.fetchModels())?.some((m) => m.id === "gemini-5-neon"), "the new model is in the list the provider offers");
  answered(await turn(first, "gemini-5-neon", "xhigh"));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.model, "gemini-5-neon-xhigh");
  assert.match(calls[0]!.url, /^https:\/\/cloudcode-pa\.googleapis\.com\//, "the only host that lists it");
  assert.match(calls[0]!.ua, /^antigravity\/cli\//);
  assert.equal(first.quotaScopeOf("gemini-5-neon@high"), "gemini-5-neon@cloudcode-pa.googleapis.com");
  answered(await turn(first, "gemini-3.8-flash", "low"));
  assert.equal(calls[1]!.model, "gemini-3.8-flash-low");
  assert.match(calls[1]!.url, /^https:\/\/daily-cloudcode-pa\.googleapis\.com\//);
  assert.match(calls[1]!.ua, /^antigravity\/ide\//, "a table model is untouched");

  const stored = storedIn(home);
  assert.equal(stored.version, 2);
  assert.deepEqual(Object.keys(stored.providers), ["ag"]);
  assert.ok(neonTiers.every((id) => stored.providers.ag![PROD]!.cli!.includes(id)), "what prod's CLI answer listed");
  assert.ok(!JSON.stringify(stored.providers.ag![DAILY]).includes("gemini-5-neon"), "and daily's did not");
  assert.ok(!JSON.stringify(stored).includes("gemini-3.8-flash") && !JSON.stringify(stored).includes("tok"), "no table model and no credential is written");

  // A new process whose catalogue cannot be read: the file is all it knows.
  catalogueDown = true;
  calls.length = 0;
  const second = new GoogleAdapter("ag", cfg, home, log);
  answered(await turn(second, "gemini-5-neon", "low"));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.model, "gemini-5-neon-low");
  assert.match(calls[0]!.url, /^https:\/\/cloudcode-pa\.googleapis\.com\//, "the host that listed it last time, not the default");
  assert.match(calls[0]!.ua, /^antigravity\/cli\//);
  const fallback = await second.fetchModels();
  assert.deepEqual(fallback?.find((m) => m.id === "gemini-5-neon"), { id: "gemini-5-neon", effortLevels: ["low", "medium", "high", "xhigh"] }, "and it stays in the fallback list");
  assert.deepEqual(fallback?.slice(0, staticAntigravityModels().length), staticAntigravityModels(), "after the tables' own models");

  // Another provider of the same home knows nothing of it, and a damaged file teaches nothing and breaks nothing.
  const other = new GoogleAdapter("other", cfg, home, log);
  assert.equal((await other.fetchModels())?.some((m) => m.id.startsWith("gemini-5-")), false);
  fs.writeFileSync(path.join(home, LEARNED_MODELS_FILE), "{ not json");
  assert.deepEqual(await new GoogleAdapter("ag", cfg, home, log).fetchModels(), staticAntigravityModels());
  fs.writeFileSync(path.join(home, LEARNED_MODELS_FILE), JSON.stringify({ version: 1, models: [{ id: "gemini-5-neon", tiers: ["low", "high"], cli: true }] }));
  assert.deepEqual(await new GoogleAdapter("ag", cfg, home, log).fetchModels(), staticAntigravityModels(), "a file of another version is not read as this one");
});

test("through the adapter: a read that missed prod's CLI answer still sends a learned prod-only model to prod", async (t) => {
  const home = homeWithAccount(t);
  let prodCliDown = false;
  const { calls } = upstream(t, async (url, init) => {
    if (prodCliDown && url.startsWith(`${PROD}/`) && isCliAsk(init)) return new Response("boom", { status: 500 });
    return (fakeCatalogues({ dailyCli: dailyCliWithoutNew }) as unknown as (url: string, init?: RequestInit) => Promise<Response>)(url, init);
  });
  await new GoogleAdapter("ag", cfg, home, log).fetchModels();
  // A new process; this time prod's CLI ask fails, so the host map it builds has no Neon at all.
  prodCliDown = true;
  const second = new GoogleAdapter("ag", cfg, home, log);
  assert.equal((await second.fetchModels())?.some((m) => m.id === "gemini-5-neon"), false, "the list of this read leaves it out, as it does Argon when the CLI ask fails");
  answered(await turn(second, "gemini-5-neon", "high"));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.model, "gemini-5-neon-high");
  assert.match(calls[0]!.url, /^https:\/\/cloudcode-pa\.googleapis\.com\//, "not the default host, which never listed it");
  assert.match(calls[0]!.ua, /^antigravity\/cli\//);
  assert.equal(second.quotaScopeOf("gemini-5-neon", "high"), "gemini-5-neon@cloudcode-pa.googleapis.com");
  assert.ok(neonTiers.every((id) => storedIn(home).providers.ag![PROD]!.cli!.includes(id)), "a failed ask takes nothing back from the file");
});

test("through the adapter: a provider that pins a host learns from that host alone when its list is read, and keeps its own lists", async (t) => {
  const home = homeWithAccount(t);
  // Prod lists an xhigh tier that daily does not.
  const dailyCli = catalogue({ ...ideModels, ...tiersOf("gemini-5-neon", ["low", "high"]) });
  const { calls, asks } = upstream(t, fakeCatalogues({ dailyCli }) as unknown as (url: string, init?: RequestInit) => Promise<Response>);
  const pinned = new GoogleAdapter("pinned", { ...cfg, url: DAILY }, home, log);
  // A pinned provider's turns ask the catalogue nothing, as before; an unknown id goes out as it is.
  answered(await turn(pinned, "gemini-3.8-flash", "low"));
  answered(await turn(pinned, "gemini-5-neon", "high"));
  assert.equal(asks.length, 0);
  assert.equal(calls.at(-1)!.model, "gemini-5-neon");
  // Its model list is read (the provider form, the picker): the pinned host's two answers, no other host's.
  assert.deepEqual((await pinned.fetchModels())?.find((m) => m.id === "gemini-5-neon")?.effortLevels, ["low", "high"]);
  assert.equal(asks.length, 2, "the IDE and the CLI ask");
  assert.ok(asks.every((url) => url.startsWith(`${DAILY}/`)), "of the pinned host only");
  answered(await turn(pinned, "gemini-5-neon", "xhigh"));
  assert.deepEqual(calls.at(-1), { url: `${DAILY}/v1internal:streamGenerateContent?alt=sse`, model: "gemini-5-neon-high", ua: calls.at(-1)!.ua }, "the top tier the pinned host lists, not one another host does");
  assert.match(calls.at(-1)!.ua, /^antigravity\/cli\//);
  assert.equal(asks.length, 2, "and the turn asked nothing more");

  // A second provider of the same home asks both hosts; each keeps its own lists in the one file.
  await new GoogleAdapter("both", cfg, home, log).fetchModels();
  const stored = storedIn(home);
  assert.deepEqual(Object.keys(stored.providers).sort(), ["both", "pinned"]);
  assert.deepEqual(Object.keys(stored.providers.pinned!), [DAILY]);
  assert.deepEqual(Object.keys(stored.providers.both!).sort(), HOSTS.slice().sort());
});

test("through the adapter: learned lists that could not be saved are saved at the next read", async (t) => {
  const home = homeWithAccount(t);
  upstream(t, fakeCatalogues() as unknown as (url: string, init?: RequestInit) => Promise<Response>);
  const file = path.join(home, LEARNED_MODELS_FILE);
  // Something is in the way of the file, so the first save fails.
  fs.mkdirSync(file);
  const adapter = new GoogleAdapter("ag", cfg, home, log);
  assert.ok((await adapter.fetchModels())?.some((m) => m.id === "gemini-5-neon"), "a failed save costs nothing in this process");
  assert.ok(fs.statSync(file).isDirectory());
  fs.rmdirSync(file);
  // The same catalogue an hour later: nothing new was learned, and the lists are written all the same.
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  t.mock.timers.tick(2 * 3_600_000);
  await adapter.fetchModels();
  assert.ok(neonTiers.every((id) => storedIn(home).providers.ag![DAILY]!.cli!.includes(id)));
});

test("through the adapter: the stored file is read for the hosts a provider asks, and for its own version", async (t) => {
  const home = homeWithAccount(t);
  const { calls } = upstream(t, async () => new Response("down", { status: 500 }));
  const lists = {
    [DAILY]: { cli: ["gemini-6-x-high", "gemini-6-x-low"] },
    [PROD]: { cli: ["gemini-6-x-high", "gemini-6-x-low", "gemini-6-x-xhigh"] },
    "https://evil.example": { cli: ["gemini-7-z-high", "gemini-7-z-low"] },
  };
  const file = path.join(home, LEARNED_MODELS_FILE);
  fs.writeFileSync(file, JSON.stringify({ version: 2, providers: { pinned: lists, both: lists } }));
  const models = [{ id: "gemini-6-x" }, { id: "gemini-7-z" }];
  // Pinned to daily: prod's xhigh tier is not its tier.
  answered(await turn(new GoogleAdapter("pinned", { ...cfg, models, url: DAILY }, home, log), "gemini-6-x", "xhigh"));
  assert.deepEqual([calls.at(-1)!.model, new URL(calls.at(-1)!.url).origin], ["gemini-6-x-high", DAILY]);
  // Asking both hosts: the tier goes to the host that listed it, and a host that is not Google's teaches nothing.
  const both = new GoogleAdapter("both", { ...cfg, models }, home, log);
  answered(await turn(both, "gemini-6-x", "xhigh"));
  assert.deepEqual([calls.at(-1)!.model, new URL(calls.at(-1)!.url).origin], ["gemini-6-x-xhigh", PROD]);
  assert.match(calls.at(-1)!.ua, /^antigravity\/cli\//);
  answered(await turn(both, "gemini-7-z", "high"));
  assert.deepEqual([calls.at(-1)!.model, new URL(calls.at(-1)!.url).origin], ["gemini-7-z", DAILY], "not a family: it goes out as asked, to the default host");
  assert.ok(calls.every((call) => HOSTS.includes(new URL(call.url).origin)), "no request leaves Google's two hosts");
  // A file of an older version is not read as this one, even where it has the same shape.
  fs.writeFileSync(file, JSON.stringify({ version: 1, providers: { both: lists } }));
  answered(await turn(new GoogleAdapter("both", { ...cfg, models }, home, log), "gemini-6-x", "xhigh"));
  assert.equal(calls.at(-1)!.model, "gemini-6-x");
});

test("through the adapter: a file a later build wrote is left as it is, and a file that lost this provider's lists gets them back", async (t) => {
  const home = homeWithAccount(t);
  upstream(t, fakeCatalogues() as unknown as (url: string, init?: RequestInit) => Promise<Response>);
  const file = path.join(home, LEARNED_MODELS_FILE);
  const later = JSON.stringify({ version: 3, shape: "unknown to this build" });
  fs.writeFileSync(file, later);
  const adapter = new GoogleAdapter("ag", cfg, home, log);
  assert.ok((await adapter.fetchModels())?.some((m) => m.id === "gemini-5-neon"), "the catalogue still teaches this process");
  assert.equal(fs.readFileSync(file, "utf8"), later);
  // The file as this build writes it, then overwritten with older lists by something else.
  fs.rmSync(file);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  t.mock.timers.tick(2 * 3_600_000);
  await adapter.fetchModels();
  const written = storedIn(home);
  assert.ok(neonTiers.every((id) => written.providers.ag![DAILY]!.cli!.includes(id)), "nothing new was learned, and the missing file is written all the same");
  fs.writeFileSync(file, JSON.stringify({ version: 2, providers: { other: { [DAILY]: { ide: ["gemini-1-kept"] } }, ag: { [DAILY]: { ide: ["gemini-0-stale"] } } } }));
  t.mock.timers.tick(2 * 3_600_000);
  await adapter.fetchModels();
  assert.deepEqual(storedIn(home).providers.ag, written.providers.ag);
  assert.deepEqual(storedIn(home).providers.other, { [DAILY]: { ide: ["gemini-1-kept"] } }, "another provider's lists are written back as they were");
});

test("through the adapter: proof that a learned model is spent rests only it, and the account keeps answering other models", async (t) => {
  const home = homeWithAccount(t);
  const refusal = (model: string): Response => {
    const body = JSON.parse(spent(model)) as { error: { details: unknown[] } };
    body.error.details.unshift({ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "17000s" });
    return new Response(JSON.stringify(body), { status: 429, headers: { "content-type": "application/json" } });
  };
  const { calls } = upstream(t, fakeCatalogues({ dailyCli: dailyCliWithoutNew }) as unknown as (url: string, init?: RequestInit) => Promise<Response>,
    (model) => model.startsWith("gemini-5-neon-") ? refusal(model) : undefined);
  const adapter = new GoogleAdapter("ag", cfg, home, log);
  const refused = await turn(adapter, "gemini-5-neon", "high");
  assert.equal(refused.status, 429);
  assert.equal(calls.at(-1)!.model, "gemini-5-neon-high");
  const [account] = adapter.accountStatus();
  assert.deepEqual(Object.keys(account!.quotaCooldowns ?? {}), ["gemini-5-neon@cloudcode-pa.googleapis.com"], "the family's own scope on the host it went to");
  assert.notEqual(account!.state, "cooling", "the account itself is not rested");
  assert.equal(adapter.hasUsable("gemini-5-neon", "low"), false, "every tier of the family rests with it");
  assert.equal(adapter.hasUsable("gemini-3.8-flash"), true);
  assert.equal(adapter.hasUsable("claude-opus-5-5-high"), true);
  answered(await turn(adapter, "gemini-3.8-flash", "low"));
});

test("through the adapter: a re-read that misses an ask keeps what was cached, is asked again sooner, and never holds a turn", async (t) => {
  const home = homeWithAccount(t);
  let dailyIdeDown = false;
  let gate: Promise<void> | null = null;
  const healthy = fakeCatalogues() as unknown as (url: string, init?: RequestInit) => Promise<Response>;
  const { calls, asks } = upstream(t, async (url, init) => {
    if (gate) await gate;
    if (dailyIdeDown && url.startsWith(`${DAILY}/`) && !isCliAsk(init)) return new Response("boom", { status: 500 });
    return healthy(url, init);
  });
  const adapter = new GoogleAdapter("ag", cfg, home, log);
  const sentTo = async (model: string): Promise<string> => {
    answered(await turn(adapter, model, "low"));
    return new URL(calls.at(-1)!.url).origin;
  };
  assert.equal(await sentTo("gemini-3.8-flash"), DAILY);
  assert.equal(asks.length, 4, "the first turn reads both hosts under both client families");
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });

  // Within the hour nothing is asked. Past it, the turn goes out on what is cached while the re-read runs.
  t.mock.timers.tick(30 * 60_000);
  assert.equal(await sentTo("gemini-3.8-flash"), DAILY);
  assert.equal(asks.length, 4);
  t.mock.timers.tick(31 * 60_000);
  dailyIdeDown = true;
  let open!: () => void;
  gate = new Promise<void>((resolve) => { open = resolve; });
  assert.equal(await sentTo("gemini-3.8-flash"), DAILY, "answered while the catalogue asks were still held");
  assert.equal(asks.length, 8, "one re-read, begun by that turn");
  gate = null;
  open();
  await adapter.fetchModels();

  // Daily's IDE ask failed once. Its models stay where they were: no conversation is moved to prod and back.
  for (const model of ["gemini-3.8-flash", "claude-opus-5-5-high", "gemini-4-argon", "gemini-5-neon"]) assert.equal(await sentTo(model), DAILY, model);
  assert.ok((await adapter.fetchModels())?.some((m) => m.id === "gemini-5-neon"), "and the list still offers what daily showed last time");
  assert.equal(asks.length, 8);

  // The partial read is asked again after five minutes, not the hour; the same asks failing again, after ten.
  t.mock.timers.tick(4 * 60_000);
  await sentTo("gemini-3.8-flash");
  assert.equal(asks.length, 8);
  t.mock.timers.tick(2 * 60_000);
  await sentTo("gemini-3.8-flash");
  await adapter.fetchModels();
  assert.equal(asks.length, 12);
  t.mock.timers.tick(6 * 60_000);
  await sentTo("gemini-3.8-flash");
  await adapter.fetchModels();
  assert.equal(asks.length, 12, "the second miss of the same ask stands twice as long");
  t.mock.timers.tick(5 * 60_000);
  dailyIdeDown = false;
  assert.equal(await sentTo("gemini-3.8-flash"), DAILY);
  await adapter.fetchModels();
  assert.equal(asks.length, 16);
  // Whole again: it stands for the hour.
  t.mock.timers.tick(30 * 60_000);
  await sentTo("gemini-3.8-flash");
  assert.equal(asks.length, 16);
});
