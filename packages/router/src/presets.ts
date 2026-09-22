// Curated providers with a documented native Anthropic Messages endpoint.
// Keep this catalog conservative: providers with only an OpenAI-compatible API belong
// behind a translation adapter, not in this host-rewrite-only catalog.

/**
 * One model the preset suggests. Shaped to fit `ProviderModel` so a model can carry the wire it
 * speaks, its own endpoint and its auth convention when those differ from the preset's own — one
 * subscription that answers several protocols on one key stays one preset instead of three.
 * `name` stays required: every entry here is user-facing and none is offered without one.
 */
export type PresetModel = {
  id: string;
  name: string;
  wire?: "chat" | "responses" | "anthropic";
  url?: string;
  authHeader?: "x-api-key" | "authorization-bearer";
  /** An empty array disables the provider fallback for this model, exactly as on a provider. */
  effortLevels?: string[];
};

export type ProviderPreset = {
  id: string;
  /** Native Anthropic endpoint or OpenAI-compatible endpoint. */
  kind: "anthropic-compatible" | "openai-compatible";
  name: string;
  vendorUrl: string;
  anthropicBaseUrl: string;
  authHeader: "x-api-key" | "authorization-bearer";
  modelsUrl?: string;
  modelsAuthHeader?: "x-api-key" | "authorization-bearer";
  /** Default OpenAI-compatible wire for this preset; omitted means Chat Completions. */
  wire?: "chat" | "responses";
  /**
   * A header this vendor recognises a conversation by. Set only where the vendor asks for one —
   * some of them key their prompt cache on it and charge full price without it.
   */
  sessionHeader?: string;
  fallbackModels: PresetModel[];
  /** Empty means output_config.effort is stripped for this provider. */
  effortLevels: string[];
  /** Whether adaptive CLI thinking can safely become Anthropic enabled thinking. */
  thinking: "enabled" | "none";
  /**
   * Whether the vendor runs Anthropic server tools (`web_search`) itself. Only ever set from a
   * measured reply, never from a docs page: DeepSeek's docs do not mention it and it works.
   */
  serverTools?: boolean;
  verified: boolean;
  notes?: string;
  docsUrl: string;
};

export const PRESETS: ProviderPreset[] = [
  // Docs: https://api-docs.deepseek.com/guides/anthropic_api/
  {
    id: "deepseek",
    kind: "anthropic-compatible",
    name: "DeepSeek",
    vendorUrl: "https://www.deepseek.com/",
    anthropicBaseUrl: "https://api.deepseek.com/anthropic",
    authHeader: "x-api-key",
    fallbackModels: [
      { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
      { id: "deepseek-flash", name: "DeepSeek Flash" },
    ],
    // https://api-docs.deepseek.com/guides/anthropic_api/ documents thinking and output_config.effort,
    // but no accepted effort-level set for its Anthropic endpoint; strip effort rather than guess.
    effortLevels: [],
    thinking: "enabled",
    // Measured 2026-09-17, not documented: a `web_search_20250305` tool sent to this endpoint came
    // back with server_tool_use, a web_search_tool_result holding ten hits, and
    // usage.server_tool_use.web_search_requests = 1. DeepSeek runs the search itself.
    serverTools: true,
    verified: true,
    notes: "Anthropic thinking is accepted; budget_tokens is ignored. Runs web_search server-side (measured).",
    docsUrl: "https://api-docs.deepseek.com/guides/anthropic_api/",
  },
  // Docs: https://platform.kimi.ai/docs/api/overview
  {
    id: "kimi",
    kind: "anthropic-compatible",
    name: "Kimi (Moonshot AI)",
    vendorUrl: "https://platform.kimi.ai/",
    anthropicBaseUrl: "https://api.moonshot.ai/anthropic",
    authHeader: "authorization-bearer",
    modelsUrl: "https://api.moonshot.ai/v1/models",
    modelsAuthHeader: "authorization-bearer",
    fallbackModels: [
      { id: "kimi-k3", name: "Kimi K3" },
      { id: "kimi-k2.7-code", name: "Kimi K2.7 Code" },
    ],
    // https://platform.kimi.ai/docs/api/overview documents the endpoint but no Anthropic effort/thinking contract.
    effortLevels: [],
    thinking: "none",
    verified: true,
    notes: "K3 exists and is documented alongside K2.7 Code for Claude Code.",
    docsUrl: "https://platform.kimi.ai/docs/api/overview",
  },
  // Docs: https://docs.z.ai/devpack/tool/others
  {
    id: "zai",
    kind: "anthropic-compatible",
    name: "Z.AI (GLM)",
    vendorUrl: "https://z.ai/",
    anthropicBaseUrl: "https://api.z.ai/api/anthropic",
    authHeader: "authorization-bearer",
    fallbackModels: [{ id: "glm-5.2", name: "GLM-5.2" }],
    // https://docs.z.ai/devpack/tool/others documents the endpoint but not an Anthropic effort/thinking contract.
    effortLevels: [],
    thinking: "none",
    verified: false,
    notes: "The Anthropic endpoint is documented; model discovery and an effort field were not verified in the Anthropic-protocol documentation.",
    docsUrl: "https://docs.z.ai/devpack/tool/others",
  },
  // Docs: https://platform.minimax.io/docs/api-reference/text-anthropic-api
  {
    id: "minimax",
    kind: "anthropic-compatible",
    name: "MiniMax",
    vendorUrl: "https://www.minimax.io/",
    anthropicBaseUrl: "https://api.minimax.io/anthropic",
    authHeader: "x-api-key",
    fallbackModels: [
      { id: "MiniMax-M3", name: "MiniMax M3" },
      { id: "MiniMax-M2.7", name: "MiniMax M2.7" },
    ],
    // https://platform.minimax.io/docs/api-reference/text-anthropic-api documents adaptive thinking,
    // but not output_config.effort.
    effortLevels: [],
    thinking: "enabled",
    verified: true,
    notes: "Uses the thinking parameter; M3 supports adaptive thinking.",
    docsUrl: "https://platform.minimax.io/docs/api-reference/text-anthropic-api",
  },
  // Docs: https://help.aliyun.com/en/model-studio/claude-code
  {
    id: "dashscope-intl",
    kind: "anthropic-compatible",
    name: "Qwen (DashScope International)",
    vendorUrl: "https://www.alibabacloud.com/product/model-studio",
    anthropicBaseUrl: "https://dashscope-intl.aliyuncs.com/apps/anthropic",
    authHeader: "authorization-bearer",
    fallbackModels: [
      { id: "qwen3.8-max", name: "Qwen 3.8 Max" },
      { id: "qwen3.6-flash", name: "Qwen 3.6 Flash" },
    ],
    // https://help.aliyun.com/en/model-studio/anthropic-api-messages documents enabled thinking;
    // it explicitly does not support reasoning_effort on the Anthropic endpoint.
    effortLevels: [],
    thinking: "enabled",
    verified: true,
    notes: "Keys are region-specific. The Anthropic-compatible endpoint has no model-list endpoint.",
    docsUrl: "https://help.aliyun.com/en/model-studio/claude-code",
  },
  // Docs: https://help.aliyun.com/en/model-studio/claude-code
  {
    id: "dashscope-cn",
    kind: "anthropic-compatible",
    name: "Qwen (DashScope China)",
    vendorUrl: "https://bailian.console.aliyun.com/",
    anthropicBaseUrl: "https://dashscope.aliyuncs.com/apps/anthropic",
    authHeader: "authorization-bearer",
    fallbackModels: [
      { id: "qwen3.8-max", name: "Qwen 3.8 Max" },
      { id: "qwen3.6-flash", name: "Qwen 3.6 Flash" },
    ],
    // https://help.aliyun.com/en/model-studio/anthropic-api-messages documents enabled thinking;
    // it explicitly does not support reasoning_effort on the Anthropic endpoint.
    effortLevels: [],
    thinking: "enabled",
    verified: true,
    notes: "Keys are region-specific. The Anthropic-compatible endpoint has no model-list endpoint.",
    docsUrl: "https://help.aliyun.com/en/model-studio/claude-code",
  },
  // Docs: https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration
  {
    id: "openrouter",
    kind: "anthropic-compatible",
    name: "OpenRouter",
    vendorUrl: "https://openrouter.ai/",
    anthropicBaseUrl: "https://openrouter.ai/api",
    authHeader: "authorization-bearer",
    modelsUrl: "https://openrouter.ai/api/v1/models",
    modelsAuthHeader: "authorization-bearer",
    // Ids verified against GET /api/v1/models on 2026-09-13 (the "-latest" aliases do not exist there).
    fallbackModels: [
      { id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5" },
      { id: "anthropic/claude-opus-5", name: "Claude Opus 5" },
    ],
    // https://openrouter.ai/docs/api/api-reference/anthropic-messages/create-a-message supports
    // provider passthrough; per-model capabilities vary, so low/medium/high is the conservative default.
    effortLevels: ["low", "medium", "high"],
    thinking: "enabled",
    verified: true,
    notes: "The Anthropic skin passes through thinking blocks and native tool use.",
    docsUrl: "https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration",
  },
  // Docs: https://docs.x.ai/docs/guides/reasoning
  {
    id: "xai-grok",
    kind: "openai-compatible",
    name: "xAI Grok",
    vendorUrl: "https://x.ai/",
    anthropicBaseUrl: "https://api.x.ai/v1",
    authHeader: "authorization-bearer",
    modelsUrl: "https://api.x.ai/v1/models",
    modelsAuthHeader: "authorization-bearer",
    wire: "responses",
    // https://docs.x.ai/docs/guides/reasoning documents low/medium/high/xhigh but does not publish a stable catalog id here.
    fallbackModels: [],
    effortLevels: ["low", "medium", "high", "xhigh"],
    thinking: "none",
    verified: true,
    notes: "Responses supports reasoning.effort; Chat Completions may vary by model. Model discovery is used instead of a stale fallback id.",
    docsUrl: "https://docs.x.ai/docs/guides/reasoning",
  },
  // Docs: https://opencode.ai/docs/go/
  //
  // One subscription, one key, one `/models` catalog, three endpoints by which wire each model
  // speaks: `/responses` for Muse Spark, Grok and GPT; `/chat/completions` for GLM, Kimi, DeepSeek,
  // LongCat and MiMo; `/messages` (Anthropic) for MiniMax and Qwen. This used to be three presets
  // because a provider carried one url and one wire; now a model carries its own wire, url and auth
  // header (`ProviderModel`), so the account is one preset and `providerFor` folds the override in
  // when the model is known. The provider-level values below are the Responses base — which is where
  // Muse Spark lives, and the wire a model with no override gets.
  //
  // `x-opencode-session` is not optional at all: the vendor answers 400 `MissingSessionID` without
  // it — "cannot be routed efficiently" — so it gates the request rather than just the cache.
  //
  // `/models` lists every model on the plan, the other two endpoints' models among them (measured
  // 2026-09-18). Discovery therefore offers all three groups, and the wire each needs comes from
  // this fallback list, which is the only place that fact is written down.
  {
    id: "opencode-go",
    kind: "openai-compatible",
    name: "OpenCode Go",
    vendorUrl: "https://opencode.ai/go",
    anthropicBaseUrl: "https://opencode.ai/zen/go/v1",
    authHeader: "authorization-bearer",
    wire: "responses",
    sessionHeader: "x-opencode-session",
    modelsUrl: "https://opencode.ai/zen/go/v1/models",
    modelsAuthHeader: "authorization-bearer",
    // Every wire below is from the endpoint table OpenCode publishes per model
    // (https://opencode.ai/docs/ko/go/, read 2026-09-22) — the only place any of it is written
    // down, since `/models` reports ids alone. Reading it off the family name instead is what left
    // mimo-v2.6-pro on Responses, where the vendor answered 503 and the user saw an unexplained 529.
    //
    // No model states an effort ladder. The blanket empty one this list used to carry was an
    // assumption rather than a measurement, and it was wrong: deepseek-v4.1-flash accepts all eight
    // levels including max, and mimo-v2.6-pro accepts none/low/medium/high (measured 2026-09-22).
    // It could not correct itself either — an empty ladder is never measured. Left unstated, each
    // model's ladder is established on the first save.
    fallbackModels: [
      // Responses — the preset's own wire, so these carry no override.
      { id: "muse-spark-1.3-contributor", name: "Muse Spark 1.3 (Contributor)" },
      { id: "muse-spark-1.2-contributor", name: "Muse Spark 1.2 (Contributor)" },
      { id: "grok-4.7", name: "Grok 4.7" },
      { id: "grok-4.6", name: "Grok 4.6" },
      { id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
      // Chat Completions.
      { id: "glm-5.3", name: "GLM-5.3", wire: "chat" },
      { id: "glm-5.3-flash", name: "GLM-5.3 Flash", wire: "chat" },
      { id: "glm-5.2", name: "GLM-5.2", wire: "chat" },
      { id: "glm-5.1", name: "GLM-5.1", wire: "chat" },
      { id: "kimi-k3", name: "Kimi K3", wire: "chat" },
      { id: "kimi-k2.7-code", name: "Kimi K2.7 Code", wire: "chat" },
      { id: "kimi-k2.6", name: "Kimi K2.6", wire: "chat" },
      { id: "longcat-2.0", name: "LongCat 2.0", wire: "chat" },
      { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", wire: "chat" },
      { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", wire: "chat" },
      { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", wire: "chat" },
      { id: "mimo-v2.6-pro", name: "MiMo V2.6 Pro", wire: "chat" },
      { id: "mimo-v2.6-flash", name: "MiMo V2.6 Flash", wire: "chat" },
      { id: "mimo-v2.5-pro", name: "MiMo V2.5 Pro", wire: "chat" },
      { id: "mimo-v2.5", name: "MiMo V2.5", wire: "chat" },
      { id: "hy4-preview", name: "Hy4 Preview", wire: "chat" },
      { id: "hy3", name: "Hy3", wire: "chat" },
      // Anthropic Messages, which needs no translation. The url is deliberately one segment shorter
      // than the provider's: an openai-compatible provider appends the endpoint name (`/responses`),
      // so its base carries the `/v1`, but an anthropic-compatible one appends the caller's whole
      // `/v1/messages` — a base ending in `/v1` would ask for `/v1/v1/messages`, which this vendor
      // answers with its website, as a 404 page of HTML. Each endpoint follows the auth convention of
      // the API it imitates, so these want Anthropic's header where the two OpenAI-wire groups on the
      // same key want a bearer: measured 2026-09-18 with a deliberately wrong key, the header it does
      // not recognise answers "Missing API key" and the one it does answers "Invalid API key".
      { id: "minimax-m3", name: "MiniMax M3", wire: "anthropic", url: "https://opencode.ai/zen/go", authHeader: "x-api-key" },
      { id: "minimax-m2.7", name: "MiniMax M2.7", wire: "anthropic", url: "https://opencode.ai/zen/go", authHeader: "x-api-key" },
      { id: "qwen3.8-max", name: "Qwen3.8 Max", wire: "anthropic", url: "https://opencode.ai/zen/go", authHeader: "x-api-key" },
      { id: "qwen3.8-flash", name: "Qwen3.8 Flash", wire: "anthropic", url: "https://opencode.ai/zen/go", authHeader: "x-api-key" },
      { id: "qwen3.7-max", name: "Qwen3.7 Max", wire: "anthropic", url: "https://opencode.ai/zen/go", authHeader: "x-api-key" },
      { id: "qwen3.7-plus", name: "Qwen3.7 Plus", wire: "anthropic", url: "https://opencode.ai/zen/go", authHeader: "x-api-key" },
      { id: "qwen3.6-plus", name: "Qwen3.6 Plus", wire: "anthropic", url: "https://opencode.ai/zen/go", authHeader: "x-api-key" },
    ],
    // Measured 2026-09-18 against the live endpoint, one effort at a time: none, minimal, low,
    // medium, high and xhigh are accepted; **max and ultra are refused** with invalid_request_error.
    // The ladder therefore tops out at xhigh, which is unusual enough that reading it off the model
    // card would have got it wrong twice — the first list here had max in it and no xhigh. It applies
    // to the Responses models above; the Chat and Anthropic ones carry their own empty ladder.
    effortLevels: ["none", "minimal", "low", "medium", "high", "xhigh"],
    thinking: "none",
    verified: true,
    notes: "One subscription and key, three endpoints by wire. Measured 2026-09-18. Responses: Muse Spark answers, effort ladder tops out at xhigh, prompt cache reached 96% on a repeated turn. Chat: glm-5.3, glm-5.3-flash, kimi-k3, kimi-k2.7-code, deepseek-v4.1-flash, deepseek-v4-pro, longcat-2.0 and mimo-v2.5-pro all answered. Anthropic: minimax-m3, qwen3.8-max and qwen3.8-flash answered with the prompt cache at 99% on a repeated turn, while union-alpha, the free row, answered \"Model is unavailable\". The Muse Spark Contributor tier is ~90% cheaper because Meta states those interactions improve its products, and OpenCode refuses the model until the workspace opts in (403 DataPolicyError); it is also limited to some regions.",
    docsUrl: "https://opencode.ai/docs/go/",
  },
  // Docs: https://opencode.ai/docs/zen/
  //
  // Zen and Go are two products on one account, not two names for one thing. Measured 2026-09-22:
  // `/zen/v1/models` lists 76 models and `/zen/go/v1/models` 40, and neither contains the other —
  // Muse Spark and the MiMo rows are Go's, the Claude and GPT rows are Zen's. The key is shared: a
  // Go key answered 402 on Zen rather than 401, so what separates them is the base URL. Pointing a
  // Zen key at Go's preset is what answers "This Go model requires Global regions", because the
  // model it then asks for is one of Go's.
  //
  // Zen bills from a balance, not from the Go subscription: on an account holding a Go plan and no
  // Zen credit, all three wires answered 402 "Insufficient account funds".
  //
  // It wants no session header. Go refuses a request without `x-opencode-session` (400
  // MissingSessionID); Zen answered the same with it and without it, so none is sent.
  {
    id: "opencode-zen",
    kind: "openai-compatible",
    name: "OpenCode Zen",
    vendorUrl: "https://opencode.ai/zen",
    anthropicBaseUrl: "https://opencode.ai/zen/v1",
    authHeader: "authorization-bearer",
    modelsUrl: "https://opencode.ai/zen/v1/models",
    modelsAuthHeader: "authorization-bearer",
    wire: "chat",
    // Every wire here is from the endpoint table OpenCode publishes per model
    // (https://opencode.ai/docs/ko/zen/, read 2026-09-22), not from guessing by family — guessing
    // put Grok on Chat when it is on Responses, and Gemini on Chat when it is on neither.
    //
    // Two families are left out on purpose. Gemini is served at /zen/v1/models/<id>, Google's own
    // shape, and jev at /systemone; ClaudeRipple speaks Chat Completions, Responses and Anthropic
    // Messages, so there is nothing here that could carry them. They are still in the catalogue, so
    // discovery will offer them; the measurement then finds no wire that answers and writes none.
    //
    // The Chat rows come first because the connection test posts to Chat Completions and takes the
    // preset's first Chat model — deepseek-v4.1-flash, which the table says is served there.
    fallbackModels: [
      { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", wire: "chat" },
      { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", wire: "chat" },
      { id: "minimax-m3", name: "MiniMax M3", wire: "chat" },
      { id: "glm-5.3", name: "GLM 5.3", wire: "chat" },
      { id: "kimi-k3", name: "Kimi K3", wire: "chat" },
      { id: "gpt-6-astra", name: "GPT 6 Astra", wire: "responses" },
      { id: "gpt-5.6-sol", name: "GPT 5.6 Sol", wire: "responses" },
      { id: "gpt-5.6-terra", name: "GPT 5.6 Terra", wire: "responses" },
      { id: "gpt-5.6-luna", name: "GPT 5.6 Luna", wire: "responses" },
      { id: "grok-4.7", name: "Grok 4.7", wire: "responses" },
      { id: "muse-spark-1.3", name: "Muse Spark 1.3", wire: "responses" },
      { id: "claude-opus-5", name: "Claude Opus 5", wire: "anthropic", url: "https://opencode.ai/zen", authHeader: "x-api-key" },
      { id: "claude-sonnet-5", name: "Claude Sonnet 5", wire: "anthropic", url: "https://opencode.ai/zen", authHeader: "x-api-key" },
      { id: "claude-fable-5-1", name: "Claude Fable 5.1", wire: "anthropic", url: "https://opencode.ai/zen", authHeader: "x-api-key" },
      { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", wire: "anthropic", url: "https://opencode.ai/zen", authHeader: "x-api-key" },
      { id: "qwen3.8-flash", name: "Qwen3.8 Flash", wire: "anthropic", url: "https://opencode.ai/zen", authHeader: "x-api-key" },
    ],
    // A starting point for the measurement, not a measurement: an empty ladder would tell the
    // router this provider takes no effort at all, and a model whose ladder is empty is never
    // measured, so the levels Zen does take could never be found.
    effortLevels: ["none", "minimal", "low", "medium", "high", "xhigh"],
    thinking: "none",
    verified: true,
    notes: "Separate from OpenCode Go and separately billed: Zen draws on a credit balance while Go is the subscription, and the two catalogues differ (76 models against 40, neither a subset of the other). Measured 2026-09-22: the key is shared \u2014 a Go key reached Zen's billing rather than being refused \u2014 and no session header is required, unlike Go. Each model's endpoint is published per model and the three wires are split across families: DeepSeek, MiniMax, GLM and Kimi on Chat Completions, the GPT and Grok rows plus Muse Spark on Responses, and the Claude and Qwen rows on Anthropic Messages. Gemini (/zen/v1/models/<id>) and jev (/systemone) are served in shapes ClaudeRipple does not speak and are not offered here. Effort ladders are unverified: the account had no Zen balance, so the per-model measurement settles them on the first save.",
    docsUrl: "https://opencode.ai/docs/zen/",
  },
  // Docs: https://docs.mistral.ai/api/endpoint/chat and https://docs.mistral.ai/api/endpoint/models
  {
    id: "mistral",
    kind: "openai-compatible",
    name: "Mistral AI",
    vendorUrl: "https://mistral.ai/",
    anthropicBaseUrl: "https://api.mistral.ai/v1",
    authHeader: "authorization-bearer",
    modelsUrl: "https://api.mistral.ai/v1/models",
    modelsAuthHeader: "authorization-bearer",
    fallbackModels: [],
    effortLevels: [],
    thinking: "none",
    verified: true,
    notes: "Official Chat Completions and model-list endpoints are documented; no provider-wide reasoning-effort contract is assumed.",
    docsUrl: "https://docs.mistral.ai/api/endpoint/chat",
  },
  // Docs: https://console.groq.com/docs/openai
  {
    id: "groq",
    kind: "openai-compatible",
    name: "Groq",
    vendorUrl: "https://groq.com/",
    anthropicBaseUrl: "https://api.groq.com/openai/v1",
    authHeader: "authorization-bearer",
    modelsUrl: "https://api.groq.com/openai/v1/models",
    modelsAuthHeader: "authorization-bearer",
    fallbackModels: [],
    effortLevels: [],
    thinking: "none",
    verified: true,
    notes: "OpenAI compatibility is documented; prompt-cache and provider-wide reasoning support are not documented here.",
    docsUrl: "https://console.groq.com/docs/openai",
  },
  // Docs: https://docs.together.ai/docs/openai-api-compatibility
  {
    id: "together",
    kind: "openai-compatible",
    name: "Together AI",
    vendorUrl: "https://www.together.ai/",
    anthropicBaseUrl: "https://api.together.xyz/v1",
    authHeader: "authorization-bearer",
    modelsUrl: "https://api.together.xyz/v1/models",
    modelsAuthHeader: "authorization-bearer",
    fallbackModels: [],
    // https://docs.together.ai/docs/openai-api-compatibility documents low/medium/high for GPT-OSS only.
    effortLevels: ["low", "medium", "high"],
    thinking: "none",
    verified: true,
    notes: "reasoning_effort is documented only for GPT-OSS models; select a model that supports it.",
    docsUrl: "https://docs.together.ai/docs/openai-api-compatibility",
  },
  // Docs: https://docs.fireworks.ai/tools-sdks/openai-compatibility
  {
    id: "fireworks",
    kind: "openai-compatible",
    name: "Fireworks AI",
    vendorUrl: "https://fireworks.ai/",
    anthropicBaseUrl: "https://api.fireworks.ai/inference/v1",
    authHeader: "authorization-bearer",
    modelsUrl: "https://api.fireworks.ai/inference/v1/models",
    modelsAuthHeader: "authorization-bearer",
    fallbackModels: [],
    effortLevels: [],
    thinking: "none",
    verified: true,
    notes: "Chat Completions and streaming usage are documented; model discovery avoids stale account/model identifiers.",
    docsUrl: "https://docs.fireworks.ai/tools-sdks/openai-compatibility",
  },
  // Docs: https://docs.ollama.com/api/openai-compatibility
  {
    id: "ollama",
    kind: "openai-compatible",
    name: "Ollama (local)",
    vendorUrl: "https://ollama.com/",
    anthropicBaseUrl: "http://127.0.0.1:11434/v1",
    authHeader: "authorization-bearer",
    modelsUrl: "http://127.0.0.1:11434/v1/models",
    modelsAuthHeader: "authorization-bearer",
    fallbackModels: [],
    effortLevels: [],
    thinking: "none",
    verified: true,
    notes: "No API key is required locally. Both stateless Responses and Chat Completions are documented; cache behavior is not documented.",
    docsUrl: "https://docs.ollama.com/api/openai-compatibility",
  },
  // Docs: https://lmstudio.ai/docs/developer/openai-compat/models
  {
    id: "lmstudio",
    kind: "openai-compatible",
    name: "LM Studio (local)",
    vendorUrl: "https://lmstudio.ai/",
    anthropicBaseUrl: "http://127.0.0.1:1234/v1",
    authHeader: "authorization-bearer",
    modelsUrl: "http://127.0.0.1:1234/v1/models",
    modelsAuthHeader: "authorization-bearer",
    fallbackModels: [],
    effortLevels: [],
    thinking: "none",
    verified: true,
    notes: "The local OpenAI-compatible model list and Chat Completions APIs are documented; cache and Responses support are not assumed.",
    docsUrl: "https://lmstudio.ai/docs/developer/openai-compat/models",
  },
];
