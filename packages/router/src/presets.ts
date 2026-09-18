// Curated providers with a documented native Anthropic Messages endpoint.
// Keep this catalog conservative: providers with only an OpenAI-compatible API belong
// behind a translation adapter, not in this host-rewrite-only catalog.

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
  fallbackModels: { id: string; name: string }[];
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
  // One subscription, three endpoints, split by which wire each model speaks: `/responses` for
  // Muse Spark, Grok and GPT; `/chat/completions` for GLM, Kimi, DeepSeek and LongCat;
  // `/messages` (Anthropic) for MiniMax and Qwen. A provider carries one url and one wire, so the
  // other two are separate providers — this preset is the Responses one, which is where Muse Spark
  // lives.
  //
  // `x-opencode-session` is not optional at all: the vendor answers 400 `MissingSessionID` without
  // it — "cannot be routed efficiently" — so it gates the request rather than just the cache.
  {
    id: "opencode-go",
    kind: "openai-compatible",
    name: "OpenCode Go (Responses)",
    vendorUrl: "https://opencode.ai/go",
    anthropicBaseUrl: "https://opencode.ai/zen/go/v1",
    authHeader: "authorization-bearer",
    wire: "responses",
    sessionHeader: "x-opencode-session",
    // `/models` lists every model on the plan, including the ones the other two endpoints serve.
    // The fallback list is therefore the Responses ones by name: a model from another group is
    // offered by discovery but will not answer here.
    modelsUrl: "https://opencode.ai/zen/go/v1/models",
    modelsAuthHeader: "authorization-bearer",
    fallbackModels: [
      { id: "muse-spark-1.3-contributor", name: "Muse Spark 1.3 (Contributor)" },
      { id: "muse-spark-1.2-contributor", name: "Muse Spark 1.2 (Contributor)" },
      { id: "grok-4.6", name: "Grok 4.6" },
      { id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
    ],
    // Measured 2026-09-18 against the live endpoint, one effort at a time: none, minimal, low,
    // medium, high and xhigh are accepted; **max and ultra are refused** with invalid_request_error.
    // The ladder therefore tops out at xhigh, which is unusual enough that reading it off the model
    // card would have got it wrong twice — the first list here had max in it and no xhigh.
    effortLevels: ["none", "minimal", "low", "medium", "high", "xhigh"],
    thinking: "none",
    verified: true,
    notes: "Contributor tier: Meta states these interactions are used to improve its products, which is why they are ~90% cheaper, and OpenCode refuses the model until the workspace opts in (403 DataPolicyError, with the link). Measured: answers, effort ladder tops out at xhigh, prompt cache reached 96% on a repeated turn. Muse Spark is limited to some regions.",
    docsUrl: "https://opencode.ai/docs/go/",
  },
  // The same subscription and the same key, on the endpoint the rest of the OpenAI-wire models use.
  {
    id: "opencode-go-chat",
    kind: "openai-compatible",
    name: "OpenCode Go (Chat)",
    vendorUrl: "https://opencode.ai/go",
    anthropicBaseUrl: "https://opencode.ai/zen/go/v1",
    authHeader: "authorization-bearer",
    wire: "chat",
    sessionHeader: "x-opencode-session",
    modelsUrl: "https://opencode.ai/zen/go/v1/models",
    modelsAuthHeader: "authorization-bearer",
    fallbackModels: [
      { id: "glm-5.3", name: "GLM-5.3" },
      { id: "glm-5.3-flash", name: "GLM-5.3 Flash" },
      { id: "kimi-k3", name: "Kimi K3" },
      { id: "kimi-k2.7-code", name: "Kimi K2.7 Code" },
      { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" },
      { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
      { id: "longcat-2.0", name: "LongCat 2.0" },
      { id: "mimo-v2.5-pro", name: "MiMo V2.5 Pro" },
    ],
    // No per-model effort contract is published for this endpoint; strip it rather than guess.
    effortLevels: [],
    thinking: "none",
    verified: false,
    notes: "Same subscription and key as the Responses entry; a different endpoint, so a separate provider. Not measured from here.",
    docsUrl: "https://opencode.ai/docs/go/",
  },
  // And the third endpoint, which speaks Anthropic Messages, so it needs no translation at all.
  {
    id: "opencode-go-anthropic",
    kind: "anthropic-compatible",
    name: "OpenCode Go (Anthropic)",
    vendorUrl: "https://opencode.ai/go",
    // Deliberately one segment shorter than the two OpenAI entries. The kinds mean different things
    // by "base": an openai-compatible provider has the endpoint name appended (`/responses`), so its
    // base carries the `/v1`; an anthropic-compatible one has the caller's whole `/v1/messages`
    // appended, so a base ending in `/v1` asks for `/v1/v1/messages` — which this vendor answers
    // with its website, as a 404 page of HTML.
    anthropicBaseUrl: "https://opencode.ai/zen/go",
    // Each endpoint follows the auth convention of the API it imitates: this one answers Anthropic
    // Messages, so it wants Anthropic's header, while the two OpenAI-wire endpoints on the same key
    // want a bearer. Measured 2026-09-18 with a deliberately wrong key: the header it does not
    // recognise answers "Missing API key", the one it does answers "Invalid API key".
    authHeader: "x-api-key",
    // The same cache key the other two send. Left off here once already: the support was wired on
    // both paths and the value was simply never put in this entry, which costs nothing visible and
    // several times the tokens.
    sessionHeader: "x-opencode-session",
    modelsUrl: "https://opencode.ai/zen/go/v1/models",
    modelsAuthHeader: "authorization-bearer",
    fallbackModels: [
      { id: "minimax-m3", name: "MiniMax M3" },
      { id: "qwen3.8-max", name: "Qwen3.8 Max" },
      { id: "qwen3.8-flash", name: "Qwen3.8 Flash" },
      { id: "union-alpha", name: "Union Alpha (free)" },
    ],
    effortLevels: [],
    thinking: "none",
    verified: false,
    notes: "Same subscription and key as the other two entries. Anthropic-wire models, so nothing is translated. Not measured from here.",
    docsUrl: "https://opencode.ai/docs/go/",
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
