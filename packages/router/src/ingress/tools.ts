// Request-local tool identities shared by declarations, history, choices and responses.
import crypto from "node:crypto";
import type { AnthropicIngressRequest, AnthropicTool, Json } from "./translate.ts";

export type ToolIdentity = { name: string; namespace?: string; kind: "function" | "custom" };
export type ToolDiagnostic = { type: string; name: string | null; reason: string };
export class ToolTranslationError extends Error {}

function object(value: unknown): Json | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : null;
}
function key(identity: ToolIdentity): string {
  return JSON.stringify([identity.namespace ?? null, identity.name, identity.kind]);
}
function identityOf(value: Json): ToolIdentity | null {
  const fields = object(value.function) ?? object(value.custom) ?? value;
  if ((value.type !== "function" && value.type !== "custom") || typeof fields.name !== "string") return null;
  return { name: fields.name, kind: value.type, ...(typeof value.namespace === "string" ? { namespace: value.namespace } : {}) };
}

export class ToolTranslation {
  private readonly byWire = new Map<string, ToolIdentity>();
  private readonly byOriginal = new Map<string, string>();
  private readonly definitions: AnthropicTool[] = [];
  readonly tools: AnthropicTool[];
  readonly choice: AnthropicIngressRequest["tool_choice"];

  private readonly oauth: boolean;

  constructor(body: Json, oauth = false, diagnose: (diagnostic: ToolDiagnostic) => void = () => {}) {
    this.oauth = oauth;
    const visit = (raw: unknown, namespace?: string): void => {
      const tool = object(raw);
      if (!tool) return;
      if (tool.type === "namespace" && typeof tool.name === "string" && Array.isArray(tool.tools)) {
        for (const child of tool.tools) visit(child, tool.name);
        return;
      }
      const identity = identityOf({ ...tool, ...(namespace !== undefined ? { namespace } : {}) });
      if (!identity) {
        diagnose({ type: typeof tool.type === "string" ? tool.type : "unknown", name: typeof tool.name === "string" ? tool.name : null, reason: "unsupported tool type or missing name" });
        return;
      }
      const fields = object(tool.function) ?? object(tool.custom) ?? tool;
      const name = this.register(identity);
      const description = typeof fields.description === "string" ? fields.description : "";
      const schema = object(fields.parameters) ? structuredClone(object(fields.parameters)!) : {};
      schema.type = "object";
      if (!object(schema.properties)) schema.properties = {};
      this.definitions.push(identity.kind === "custom"
        ? { name, description: [description, fields.format === undefined ? "" : `Original input format: ${JSON.stringify(fields.format)}`].filter(Boolean).join("\n\n"), input_schema: { type: "object", properties: { input: { type: "string" } }, required: ["input"], additionalProperties: false } }
        : { name, ...(description ? { description } : {}), input_schema: schema });
    };
    if (Array.isArray(body.tools)) for (const tool of body.tools) visit(tool);
    // Historical calls can outlive their declaration. Still give them a legal, reversible name.
    if (Array.isArray(body.input)) for (const raw of body.input) {
      const item = object(raw);
      if (item?.type !== "function_call" && item?.type !== "custom_tool_call") continue;
      if (typeof item.name === "string") this.register({ name: item.name, kind: item.type === "custom_tool_call" ? "custom" : "function", ...(typeof item.namespace === "string" ? { namespace: item.namespace } : {}) });
    }
    if (Array.isArray(body.messages)) for (const raw of body.messages) {
      const message = object(raw);
      if (!Array.isArray(message?.tool_calls)) continue;
      for (const call of message.tool_calls) {
        const item = object(call);
        if (item) { const identity = identityOf(item); if (identity) this.register(identity); }
      }
    }
    const selected = this.select(body.tool_choice);
    this.tools = selected.tools.map((tool) => ({ ...tool }));
    if (this.tools.length) this.tools[this.tools.length - 1]!.cache_control = { type: "ephemeral" };
    this.choice = selected.choice;
  }

  private register(identity: ToolIdentity): string {
    const original = key(identity);
    const known = this.byOriginal.get(original);
    if (known) return known;
    const prefix = this.oauth ? "custom_" : "";
    const base = prefix + [identity.namespace, identity.name].filter((part) => part !== undefined).join("__").replace(/[^a-zA-Z0-9_-]/g, "_");
    let name = base || "tool";
    if (name.length > 64 || this.byWire.has(name)) {
      const digest = crypto.createHash("sha256").update(original).digest("hex").slice(0, 16);
      name = `${base.slice(0, 47)}_${digest}`;
      let suffix = 0;
      while (this.byWire.has(name)) name = `${base.slice(0, 40)}_${digest}_${++suffix}`;
    }
    this.byOriginal.set(original, name);
    this.byWire.set(name, identity);
    return name;
  }

  toWire(identity: ToolIdentity): string {
    const name = this.byOriginal.get(key(identity));
    if (!name) throw new ToolTranslationError("Tool call has no translated identity");
    return name;
  }
  fromWire(name: string): ToolIdentity | undefined { return this.byWire.get(name); }

  private select(value: unknown): { tools: AnthropicTool[]; choice: AnthropicIngressRequest["tool_choice"] } {
    const choice = object(value);
    let tools = this.definitions;
    if (choice?.type === "allowed_tools") {
      const allowed = Array.isArray(choice.tools) ? choice.tools.map(object).filter((entry): entry is Json => entry !== null) : [];
      tools = tools.filter((tool) => {
        const identity = this.byWire.get(tool.name)!;
        return allowed.some((entry) => entry.type === "namespace" ? entry.name === identity.namespace : (() => {
          const wanted = identityOf(entry);
          return wanted !== null && key(wanted) === key(identity);
        })());
      });
      if (!tools.length) throw new ToolTranslationError("No supported tools remain in allowed_tools");
    }
    const mode = choice?.type === "allowed_tools" ? choice.mode : value;
    if (mode === "required") {
      if (!tools.length) throw new ToolTranslationError("tool_choice required but no supported tools remain");
      return { tools, choice: { type: "any" } };
    }
    const identity = choice && identityOf(choice);
    if (identity) {
      const name = this.byOriginal.get(key(identity));
      if (!name || !tools.some((tool) => tool.name === name)) throw new ToolTranslationError("tool_choice selects an unsupported or undeclared tool");
      return { tools, choice: { type: "tool", name } };
    }
    return { tools, choice: tools.length && (mode === "auto" || mode === "none") ? { type: mode } : undefined };
  }
}
