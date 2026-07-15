/**
 * Multi-provider auth types.
 *
 * xAI Grok developer API uses Bearer API keys from console.x.ai
 * (OpenAI-compatible). Other providers use their standard API keys.
 * Multiple providers can be logged in simultaneously.
 */

export type AuthMethod = "api_key" | "oauth_browser";

export type ProviderId =
  | "xai"
  | "gemini"
  | "openai"
  | "codex"
  | "openrouter"
  | "anthropic"
  | "opencode"
  | "opencode-go"
  | "deepseek"
  | "groq"
  | "together"
  | "mistral"
  | "fireworks"
  | "cerebras"
  | "moonshot"
  | "deepinfra"
  | "custom";

export interface ProviderDef {
  id: ProviderId;
  name: string;
  description: string;
  methods: AuthMethod[];
  /** Default base URL for API calls */
  baseUrl?: string;
  /** Env var fallback for API keys */
  envKey?: string;
  /** Additional env vars checked after envKey (shared keys, aliases) */
  envKeyAliases?: string[];
  /** Placeholder shown in API key modal */
  keyPlaceholder?: string;
  docsUrl?: string;
  /** How to list models / route chat */
  modelsStyle: "openai" | "gemini" | "anthropic" | "none";
}

export interface StoredCredential {
  provider: ProviderId;
  method: AuthMethod;
  /** API key or access token */
  token?: string;
  refreshToken?: string;
  expiresAt?: number;
  label?: string;
  meta?: Record<string, string>;
  updatedAt: number;
}

export interface AuthFile {
  version: 1;
  credentials: StoredCredential[];
}

/** CLI aliases → canonical ProviderId */
const PROVIDER_ALIASES: Record<string, ProviderId> = {
  zen: "opencode",
  "opencode-zen": "opencode",
  "opencode_zen": "opencode",
  go: "opencode-go",
  "opencode_go": "opencode-go",
  "opencodigo": "opencode-go",
  google: "gemini",
  "google-ai": "gemini",
  claude: "anthropic",
  chatgpt: "codex",
  or: "openrouter",
  kimi: "moonshot",
  ds: "deepseek",
};

export const PROVIDERS: ProviderDef[] = [
  {
    id: "xai",
    name: "xAI (Grok)",
    description:
      "SuperGrok OAuth (browser PKCE) or API key from console.x.ai",
    methods: ["oauth_browser", "api_key"],
    baseUrl: "https://api.x.ai/v1",
    envKey: "XAI_API_KEY",
    keyPlaceholder: "xai-...",
    docsUrl: "https://console.x.ai",
    modelsStyle: "openai",
  },
  {
    id: "opencode",
    name: "OpenCode Zen",
    description:
      "Curated coding models gateway (pay-as-you-go). Key from opencode.ai/auth",
    methods: ["api_key"],
    baseUrl: "https://opencode.ai/zen/v1",
    envKey: "OPENCODE_API_KEY",
    envKeyAliases: ["OPENCODE_ZEN_API_KEY"],
    keyPlaceholder: "opencode api key",
    docsUrl: "https://opencode.ai/zen",
    modelsStyle: "openai",
  },
  {
    id: "opencode-go",
    name: "OpenCode Go",
    description:
      "Low-cost open coding models subscription. Same console key as Zen works",
    methods: ["api_key"],
    baseUrl: "https://opencode.ai/zen/go/v1",
    envKey: "OPENCODE_GO_API_KEY",
    envKeyAliases: ["OPENCODE_API_KEY"],
    keyPlaceholder: "opencode api key",
    docsUrl: "https://opencode.ai/docs/go",
    modelsStyle: "openai",
  },
  {
    id: "gemini",
    name: "Google Gemini",
    description: "API key from Google AI Studio",
    methods: ["api_key"],
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    envKey: "GEMINI_API_KEY",
    envKeyAliases: ["GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
    keyPlaceholder: "AIza...",
    docsUrl: "https://aistudio.google.com/apikey",
    modelsStyle: "gemini",
  },
  {
    id: "openai",
    name: "OpenAI",
    description: "OpenAI platform API key",
    methods: ["api_key"],
    baseUrl: "https://api.openai.com/v1",
    envKey: "OPENAI_API_KEY",
    keyPlaceholder: "sk-...",
    docsUrl: "https://platform.openai.com/api-keys",
    modelsStyle: "openai",
  },
  {
    id: "codex",
    name: "Codex / ChatGPT",
    description: "OpenAI key for Codex-class models",
    methods: ["api_key"],
    baseUrl: "https://api.openai.com/v1",
    envKey: "OPENAI_API_KEY",
    keyPlaceholder: "sk-...",
    docsUrl: "https://platform.openai.com",
    modelsStyle: "openai",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    description: "Claude API key",
    methods: ["api_key"],
    baseUrl: "https://api.anthropic.com",
    envKey: "ANTHROPIC_API_KEY",
    keyPlaceholder: "sk-ant-...",
    docsUrl: "https://console.anthropic.com",
    modelsStyle: "anthropic",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    description: "Unified API for many models",
    methods: ["api_key"],
    baseUrl: "https://openrouter.ai/api/v1",
    envKey: "OPENROUTER_API_KEY",
    keyPlaceholder: "sk-or-...",
    docsUrl: "https://openrouter.ai/keys",
    modelsStyle: "openai",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    description: "DeepSeek chat / reasoner API",
    methods: ["api_key"],
    baseUrl: "https://api.deepseek.com",
    envKey: "DEEPSEEK_API_KEY",
    keyPlaceholder: "sk-...",
    docsUrl: "https://platform.deepseek.com/api_keys",
    modelsStyle: "openai",
  },
  {
    id: "groq",
    name: "Groq",
    description: "Fast inference (Llama, Qwen, …)",
    methods: ["api_key"],
    baseUrl: "https://api.groq.com/openai/v1",
    envKey: "GROQ_API_KEY",
    keyPlaceholder: "gsk_...",
    docsUrl: "https://console.groq.com/keys",
    modelsStyle: "openai",
  },
  {
    id: "together",
    name: "Together AI",
    description: "Open models via Together",
    methods: ["api_key"],
    baseUrl: "https://api.together.xyz/v1",
    envKey: "TOGETHER_API_KEY",
    envKeyAliases: ["TOGETHERAI_API_KEY"],
    keyPlaceholder: "together api key",
    docsUrl: "https://api.together.xyz/settings/api-keys",
    modelsStyle: "openai",
  },
  {
    id: "mistral",
    name: "Mistral",
    description: "Mistral / Codestral API",
    methods: ["api_key"],
    baseUrl: "https://api.mistral.ai/v1",
    envKey: "MISTRAL_API_KEY",
    keyPlaceholder: "mistral api key",
    docsUrl: "https://console.mistral.ai/api-keys",
    modelsStyle: "openai",
  },
  {
    id: "fireworks",
    name: "Fireworks",
    description: "Fireworks AI inference",
    methods: ["api_key"],
    baseUrl: "https://api.fireworks.ai/inference/v1",
    envKey: "FIREWORKS_API_KEY",
    keyPlaceholder: "fw_...",
    docsUrl: "https://fireworks.ai/account/api-keys",
    modelsStyle: "openai",
  },
  {
    id: "cerebras",
    name: "Cerebras",
    description: "Cerebras inference API",
    methods: ["api_key"],
    baseUrl: "https://api.cerebras.ai/v1",
    envKey: "CEREBRAS_API_KEY",
    keyPlaceholder: "csk-...",
    docsUrl: "https://inference-docs.cerebras.ai",
    modelsStyle: "openai",
  },
  {
    id: "moonshot",
    name: "Moonshot (Kimi)",
    description: "Moonshot / Kimi API (global endpoint)",
    methods: ["api_key"],
    baseUrl: "https://api.moonshot.ai/v1",
    envKey: "MOONSHOT_API_KEY",
    envKeyAliases: ["KIMI_API_KEY"],
    keyPlaceholder: "sk-...",
    docsUrl: "https://platform.moonshot.ai",
    modelsStyle: "openai",
  },
  {
    id: "deepinfra",
    name: "DeepInfra",
    description: "DeepInfra OpenAI-compatible API",
    methods: ["api_key"],
    baseUrl: "https://api.deepinfra.com/v1/openai",
    envKey: "DEEPINFRA_API_KEY",
    keyPlaceholder: "deepinfra api key",
    docsUrl: "https://deepinfra.com/dash/api_keys",
    modelsStyle: "openai",
  },
  {
    id: "custom",
    name: "Custom OpenAI-compatible",
    description: "Any OpenAI-style base URL + key (Ollama, vLLM, …)",
    methods: ["api_key"],
    keyPlaceholder: "API key or ollama",
    modelsStyle: "openai",
  },
];

/** Map alias or id → canonical ProviderId when known. */
export function canonicalizeProviderId(id: string): ProviderId | undefined {
  const k = id.trim().toLowerCase();
  if (!k) return undefined;
  const aliased = PROVIDER_ALIASES[k];
  if (aliased) return aliased;
  if (PROVIDERS.some((p) => p.id === k)) return k as ProviderId;
  return undefined;
}

export function getProvider(id: string): ProviderDef | undefined {
  const canonical = canonicalizeProviderId(id);
  if (!canonical) return undefined;
  return PROVIDERS.find((p) => p.id === canonical);
}

/** Providers that share the OpenCode console key (Zen ↔ Go). */
export function isOpenCodeFamily(id: ProviderId | string): boolean {
  const c = canonicalizeProviderId(String(id));
  return c === "opencode" || c === "opencode-go";
}
