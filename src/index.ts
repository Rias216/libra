/**
 * Public API — embed Libra's TUI renderer in your own AI harness.
 */

// ── core ──────────────────────────────────────────────
export {
  type Role,
  type ToolStatus,
  type Part,
  type TextPart,
  type ReasoningPart,
  type ToolPart,
  type DiffPart,
  type FilePart,
  type StatusPart,
  type Message,
  type SessionMeta,
  type AgentPhase,
  type HarnessState,
  createEmptyState,
  newId,
} from "./core/types.js";

export {
  type HarnessEvent,
  EventBus,
  reduce,
} from "./core/events.js";

export { HarnessStore } from "./core/store.js";

// ── memory ────────────────────────────────────────────
export { PromptHistory } from "./memory/history.js";
export { PathIndex, type PathEntry } from "./memory/paths.js";
export {
  extractSessionTokens,
  type SessionTokens,
} from "./memory/session-memory.js";

// ── toolcalling ───────────────────────────────────────
export { MockAgent } from "./toolcalling/mock-agent.js";
export {
  BUILTIN_TOOLS,
  toolByName,
  toolNames,
  type ToolDef,
} from "./toolcalling/tools.js";
export { ToolExecutor } from "./toolcalling/executor.js";
export { ToolRunner } from "./toolcalling/runner.js";
export {
  PermissionChecker,
  DEFAULT_PERMISSIONS,
  HEADLESS_PERMISSIONS,
  type PermissionAction,
  type PermissionRules,
  type PermissionAskFn,
} from "./toolcalling/permissions.js";
export {
  validateToolArgs,
  formatValidationError,
} from "./toolcalling/validate.js";
export {
  ToolRegistry,
  createDefaultRegistry,
  type ToolsetId,
} from "./toolcalling/registry.js";
export { scheduleToolWaves, runInWaves } from "./toolcalling/concurrency.js";
export {
  normalizeToolArgs,
  parseToolArgs,
  toolFingerprint,
} from "./toolcalling/normalize.js";
export { OPENAI_TOOLS } from "./toolcalling/schema.js";

// ── complete ──────────────────────────────────────────
export {
  complete,
  applySuggestion,
  parseSlashInput,
  resolveSlashCommand,
  fuzzyScore,
  fuzzyFilter,
  SLASH_COMMANDS,
  getSlashCommand,
  type Suggestion,
  type CompleteResult,
  type CompleteContext,
} from "./complete/index.js";

export type { PickerSpec, PickerOption } from "./tui/picker.js";

// ── tui ───────────────────────────────────────────────
export { TuiRenderer, type RendererOptions } from "./tui/renderer.js";
export {
  type Theme,
  type ColorLevel,
  THEMES,
  THEME_ORDER,
  resolveTheme,
  listThemes,
  detectColorLevel,
} from "./tui/theme.js";
export {
  FONT_PROFILES,
  resolveFont,
  glyphsFor,
  type FontProfile,
} from "./tui/font.js";
export { FrameBuffer } from "./tui/buffer.js";
export { renderMarkdown } from "./tui/markdown.js";
export { renderPart, renderRoleHeader } from "./tui/components/parts.js";
export { computeScrollbar, scrollPercent } from "./tui/scrollbar.js";

// ── auth ──────────────────────────────────────────────
export {
  PROVIDERS,
  getProvider,
  loadAuth,
  getCredential,
  listCredentials,
  maskSecret,
  saveApiKey,
  resolveToken,
  connectXaiApiKey,
  openBrowser,
  XAI_CONSOLE_URL,
  fetchModelsForProvider,
  fetchAllConnectedModels,
  connectedProviders,
  modelKey,
  parseModelKey,
  pickHighestReasoningModel,
  clearModelCache,
  validateKeyFormat,
  verifyProvider,
  verifyAll,
  verifyAuthModelsOffline,
  type ProviderId,
  type ProviderDef,
  type StoredCredential,
  type RemoteModel,
  type ModelRef,
  type VerifyResult,
} from "./auth/index.js";

// ── agent ─────────────────────────────────────────────
export {
  loadAgentSettings,
  saveAgentSettings,
  PROVIDER_EFFORT_OPTIONS,
  CUSTOM_REASONING_OPTIONS,
  prepareFusionForMain,
  resolveSecondaryReasoners,
  runFusionReasoning,
  type AgentSettings,
  type ReasoningConfig,
  type SubagentConfig,
  type FusionConfig,
  type CustomReasoningMode,
  type ProviderReasoningEffort,
  type FusionPrepResult,
  type FusionCandidate,
} from "./agent/index.js";

// ── config ────────────────────────────────────────────
export { loadConfig, saveConfig, type LibraConfig } from "./config/store.js";
