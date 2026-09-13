// Curated providers with a documented native Anthropic Messages endpoint.
// Keep this catalog conservative: providers with only an OpenAI-compatible API belong
// behind a translation adapter, not in this host-rewrite-only catalog.

export type ProviderPreset = {
  id: string;
  name: string;
  vendorUrl: string;
  anthropicBaseUrl: string;
  authHeader: "x-api-key" | "authorization-bearer";
  modelsUrl?: string;
  modelsAuthHeader?: "x-api-key" | "authorization-bearer";
  fallbackModels: { id: string; name: string }[];
  supportsEffort: boolean;
  verified: boolean;
  notes?: string;
  docsUrl: string;
};

export const PRESETS: ProviderPreset[] = [
  // Docs: https://api-docs.deepseek.com/guides/anthropic_api/
  {
    id: "deepseek",
    name: "DeepSeek",
    vendorUrl: "https://www.deepseek.com/",
    anthropicBaseUrl: "https://api.deepseek.com/anthropic",
    authHeader: "x-api-key",
    fallbackModels: [
      { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
      { id: "deepseek-flash", name: "DeepSeek Flash" },
    ],
    supportsEffort: true,
    verified: true,
    notes: "Anthropic thinking is accepted; budget_tokens is ignored.",
    docsUrl: "https://api-docs.deepseek.com/guides/anthropic_api/",
  },
  // Docs: https://platform.kimi.ai/docs/api/overview
  {
    id: "kimi",
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
    supportsEffort: false,
    verified: true,
    notes: "K3 exists and is documented alongside K2.7 Code for Claude Code.",
    docsUrl: "https://platform.kimi.ai/docs/api/overview",
  },
  // Docs: https://docs.z.ai/devpack/tool/others
  {
    id: "zai",
    name: "Z.AI (GLM)",
    vendorUrl: "https://z.ai/",
    anthropicBaseUrl: "https://api.z.ai/api/anthropic",
    authHeader: "authorization-bearer",
    fallbackModels: [{ id: "glm-5.2", name: "GLM-5.2" }],
    supportsEffort: false,
    verified: false,
    notes: "The Anthropic endpoint is documented; model discovery and an effort field were not verified in the Anthropic-protocol documentation.",
    docsUrl: "https://docs.z.ai/devpack/tool/others",
  },
  // Docs: https://platform.minimax.io/docs/api-reference/text-anthropic-api
  {
    id: "minimax",
    name: "MiniMax",
    vendorUrl: "https://www.minimax.io/",
    anthropicBaseUrl: "https://api.minimax.io/anthropic",
    authHeader: "x-api-key",
    fallbackModels: [
      { id: "MiniMax-M3", name: "MiniMax M3" },
      { id: "MiniMax-M2.7", name: "MiniMax M2.7" },
    ],
    supportsEffort: true,
    verified: true,
    notes: "Uses the thinking parameter; M3 supports adaptive thinking.",
    docsUrl: "https://platform.minimax.io/docs/api-reference/text-anthropic-api",
  },
  // Docs: https://help.aliyun.com/en/model-studio/claude-code
  {
    id: "dashscope-intl",
    name: "Qwen (DashScope International)",
    vendorUrl: "https://www.alibabacloud.com/product/model-studio",
    anthropicBaseUrl: "https://dashscope-intl.aliyuncs.com/apps/anthropic",
    authHeader: "authorization-bearer",
    fallbackModels: [
      { id: "qwen3.8-max", name: "Qwen 3.8 Max" },
      { id: "qwen3.6-flash", name: "Qwen 3.6 Flash" },
    ],
    supportsEffort: false,
    verified: true,
    notes: "Keys are region-specific. The Anthropic-compatible endpoint has no model-list endpoint.",
    docsUrl: "https://help.aliyun.com/en/model-studio/claude-code",
  },
  // Docs: https://help.aliyun.com/en/model-studio/claude-code
  {
    id: "dashscope-cn",
    name: "Qwen (DashScope China)",
    vendorUrl: "https://bailian.console.aliyun.com/",
    anthropicBaseUrl: "https://dashscope.aliyuncs.com/apps/anthropic",
    authHeader: "authorization-bearer",
    fallbackModels: [
      { id: "qwen3.8-max", name: "Qwen 3.8 Max" },
      { id: "qwen3.6-flash", name: "Qwen 3.6 Flash" },
    ],
    supportsEffort: false,
    verified: true,
    notes: "Keys are region-specific. The Anthropic-compatible endpoint has no model-list endpoint.",
    docsUrl: "https://help.aliyun.com/en/model-studio/claude-code",
  },
  // Docs: https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration
  {
    id: "openrouter",
    name: "OpenRouter",
    vendorUrl: "https://openrouter.ai/",
    anthropicBaseUrl: "https://openrouter.ai/api",
    authHeader: "authorization-bearer",
    modelsUrl: "https://openrouter.ai/api/v1/models",
    modelsAuthHeader: "authorization-bearer",
    fallbackModels: [
      { id: "anthropic/claude-sonnet-latest", name: "Claude Sonnet (latest)" },
      { id: "anthropic/claude-opus-latest", name: "Claude Opus (latest)" },
    ],
    supportsEffort: true,
    verified: true,
    notes: "The Anthropic skin passes through thinking blocks and native tool use.",
    docsUrl: "https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration",
  },
];
