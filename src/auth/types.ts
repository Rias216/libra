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
  /** Placeholder shown in API key modal */
  keyPlaceholder?: string;
  docsUrl?: string;
  /** How to list models */
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

export const PROVIDERS: ProviderDef[] = [
  {
    id: "xai",
    name: "xAI (Grok)",
    description: "API key from console.x.ai — OpenAI-compatible",
    methods: ["api_key"],
    baseUrl: "https://api.x.ai/v1",
    envKey: "XAI_API_KEY",
    keyPlaceholder: "xai-...",
    docsUrl: "https://console.x.ai",
    modelsStyle: "openai",
  },
  {
    id: "gemini",
    name: "Google Gemini",
    description: "API key from Google AI Studio",
    methods: ["api_key"],
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    envKey: "GEMINI_API_KEY",
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
    id: "custom",
    name: "Custom OpenAI-compatible",
    description: "Any OpenAI-style base URL + key (Ollama, vLLM, ...)",
    methods: ["api_key"],
    keyPlaceholder: "API key or ollama",
    modelsStyle: "openai",
  },
];

export function getProvider(id: string): ProviderDef | undefined {
  return PROVIDERS.find((p) => p.id === id);
}
