"use strict";

// Used only while the router is starting up or an older router does not yet expose
// /api/presets and /api/claude-models. The API response replaces these lists.
const FALLBACK_CLAUDE_MODELS = [
  { id: "claude-fable-5-1", name: "Fable 5.1" },
  { id: "claude-opus-5", name: "Opus 5" },
  { id: "claude-sonnet-5", name: "Sonnet 5" },
  { id: "claude-haiku-4-5", name: "Haiku 4.5" },
  { id: "claude-fable-5", name: "Fable 5" },
  { id: "claude-opus-4-8", name: "Opus 4.8" },
  { id: "claude-opus-4-7", name: "Opus 4.7" },
  { id: "claude-opus-4-6", name: "Opus 4.6" },
  { id: "claude-sonnet-4-6", name: "Sonnet 4.6" },
];

const CHATGPT_MODELS = [
  { id: "gpt-5.6-terra", name: "GPT-5.6 Terra" },
  { id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
  { id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
  { id: "gpt-6-astra", name: "GPT-6 Astra" },
];

const FALLBACK_PRESETS = [
  {
    id: "deepseek",
    name: "DeepSeek",
    vendorUrl: "https://platform.deepseek.com/",
    anthropicBaseUrl: "https://api.deepseek.com/anthropic",
    authHeader: "x-api-key",
    fallbackModels: [
      { id: "deepseek-chat", name: "DeepSeek V3" },
      { id: "deepseek-reasoner", name: "DeepSeek R1" },
    ],
    supportsEffort: false,
    verified: false,
    docsUrl: "https://api-docs.deepseek.com/",
  },
  {
    id: "moonshot",
    name: "Moonshot AI",
    vendorUrl: "https://platform.moonshot.ai/",
    anthropicBaseUrl: "https://api.moonshot.ai/anthropic",
    authHeader: "x-api-key",
    fallbackModels: [{ id: "kimi-k2", name: "Kimi K2" }],
    supportsEffort: false,
    verified: false,
    docsUrl: "https://platform.moonshot.ai/docs",
  },
  {
    id: "zai",
    name: "Z.AI",
    vendorUrl: "https://www.z.ai/",
    anthropicBaseUrl: "https://open.bigmodel.cn/api/anthropic",
    authHeader: "authorization-bearer",
    fallbackModels: [{ id: "glm-4.7", name: "GLM-4.7" }],
    supportsEffort: false,
    verified: false,
    docsUrl: "https://docs.z.ai/",
  },
];
