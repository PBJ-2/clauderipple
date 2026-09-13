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
  fallbackModels: { id: string; name: string }[];
  /** Empty means output_config.effort is stripped for this provider. */
  effortLevels: string[];
  /** Whether adaptive CLI thinking can safely become Anthropic enabled thinking. */
  thinking: "enabled" | "none";
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
    verified: true,
    notes: "Anthropic thinking is accepted; budget_tokens is ignored.",
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
