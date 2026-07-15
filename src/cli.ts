#!/usr/bin/env node
/**
 * Libra CLI — TUI harness entry.
 *
 *   npm run dev
 */

import { HarnessStore } from "./core/store.js";
import { newId } from "./core/types.js";
import { MockAgent } from "./toolcalling/mock-agent.js";
import { AgentLoop } from "./agent/loop.js";
import { TuiRenderer } from "./tui/renderer.js";
import { resolveToken } from "./auth/api-key.js";
import { listThemes, resolveTheme } from "./tui/theme.js";
import { FONT_PROFILES, resolveFont } from "./tui/font.js";
import { getSlashCommand, ON_OFF } from "./complete/commands.js";
import { loadConfig, saveConfig } from "./config/store.js";
import {
  PROVIDERS,
  getProvider,
  type ProviderId,
} from "./auth/types.js";
import {
  connectXaiApiKey,
  openBrowser,
  XAI_CONSOLE_URL,
} from "./auth/device.js";
import {
  importGrokCliAuth,
  loadGrokCliCredentials,
  loginXaiOAuth,
} from "./auth/xai-oauth.js";
import { saveApiKey } from "./auth/api-key.js";
import {
  listCredentials,
  maskSecret,
  removeCredential,
  getCredential,
} from "./auth/store.js";
import {
  clearModelCache,
  connectedProviders,
  fetchAllConnectedModels,
  fetchModelsForProvider,
  modelKey,
  parseModelKey,
  pickHighestReasoningModel,
  type RemoteModel,
} from "./auth/models.js";
import {
  verifyAll,
  verifyAuthModelsOffline,
  verifyProvider,
  type VerifyResult,
} from "./auth/verify.js";
import {
  CUSTOM_REASONING_OPTIONS,
  DEFAULT_SUBAGENT_ROLES,
  loadAgentSettings,
  saveAgentSettings,
  type CustomReasoningMode,
} from "./agent/config.js";
import {
  effortLabel,
  effortPickerOptions,
  getCachedReasoningCaps,
  getEffortForModel,
  pickHighestNativeReasoningModel,
  resolveCapsForModel,
  setEffortForModel,
  setMaxEffortForModel,
  type EffortLevel,
} from "./agent/reasoning.js";
import { prepareFusionForMain } from "./agent/fusion.js";
import { buildSystemPrompt } from "./agent/loop.js";
import { initDebug, dbg } from "./agent/debug.js";

async function main(): Promise<void> {
  if (process.argv.includes("--version") || process.argv.includes("-v")) {
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    let version = "0.1.0";
    try {
      version = require("../package.json").version ?? version;
    } catch {
      try {
        version = require("../../package.json").version ?? version;
      } catch {
        /* dist/cli.js → package.json is one up from dist */
      }
    }
    console.log(`libra ${version}`);
    return;
  }
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(`libra — AI coding harness TUI

Usage:
  libra [options]

Options:
  --theme=<name>   Theme (libra-night, tokyo-night, …)
  --version, -v    Print version
  --help, -h       Show this help

Environment:
  LIBRA_THEME      Default theme
  LIBRA_FONT       Font profile
  LIBRA_DEBUG      Debug level (1 / info / trace)

Run from any project directory — the workspace is process.cwd().
After install:  npm run link   (from the libra repo)
`);
    return;
  }

  initDebug();
  const cfg = loadConfig();
  const themeArg = process.argv.find((a) => a.startsWith("--theme="));
  const theme =
    themeArg?.split("=")[1] ??
    process.env.LIBRA_THEME ??
    cfg.theme ??
    "libra-night";
  const font = process.env.LIBRA_FONT ?? cfg.font ?? "default";

  const store = new HarnessStore({
    title: "demo session",
    model: cfg.model ?? "unset",
    provider: cfg.provider ?? "none",
    cwd: process.cwd(),
  });
  dbg("cli", "boot", {
    model: cfg.model,
    provider: cfg.provider,
    reasoning: loadAgentSettings().reasoning.custom,
  });

  const mockAgent = new MockAgent(store);
  const liveAgent = new AgentLoop(store);

  const ui = new TuiRenderer({
    theme,
    font,
    cwd: process.cwd(),
    onSubmit: (text) => {
      void handleUserSubmit(text, store, mockAgent, liveAgent);
    },
    onCommand: (cmd, args) => {
      handleCommand(cmd, args, store, ui, mockAgent, liveAgent);
    },
    onQuit: () => {
      mockAgent.cancel();
      liveAgent.cancel();
    },
    // OpenCode-style: click reasoning / tool headers to expand or collapse
    onTogglePart: (messageId, partId) => {
      togglePartCollapsed(store, messageId, partId);
    },
  });

  store.subscribe((_event, state) => {
    ui.setState(state, _event);
    // Coalesce stream/tool events — full paint on every token is the main lag source
    ui.requestPaint();
  });

  // Quiet start — no welcome wall of text
  ui.setState(store.state);

  const shutdown = () => {
    ui.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await ui.start();
}

/**
 * OpenCode-style expand/collapse for reasoning, tool, and diff parts.
 * Pure click on the header row (no drag) invokes this via the renderer.
 */
function togglePartCollapsed(
  store: HarnessStore,
  messageId: string,
  partId: string,
): void {
  const msg = store.state.messages.find((m) => m.id === messageId);
  const part = msg?.parts.find((p) => p.id === partId);
  if (!part) return;

  if (part.type === "reasoning") {
    // Default: expanded while streaming, folded when done
    const collapsed =
      part.collapsed != null ? part.collapsed : !part.streaming;
    store.patchPart(messageId, partId, {
      collapsed: !collapsed,
    } as never);
    return;
  }

  if (part.type === "tool") {
    const collapsed =
      part.collapsed != null
        ? part.collapsed
        : !store.state.showToolDetails;
    store.patchPart(messageId, partId, {
      collapsed: !collapsed,
    } as never);
    return;
  }

  if (part.type === "diff") {
    store.patchPart(messageId, partId, {
      collapsed: !part.collapsed,
    } as never);
  }
}

function handleCommand(
  cmd: string,
  args: string,
  store: HarnessStore,
  ui: TuiRenderer,
  agent: MockAgent,
  liveAgent?: AgentLoop,
): void {
  switch (cmd) {
    case "help":
    case "h":
    case "?":
      store.appendMessage({
        id: newId("m"),
        role: "assistant",
        createdAt: Date.now(),
        parts: [
          {
            id: newId("p"),
            type: "text",
            content:
              "### Commands\n\n" +
              "- `/login [provider]` — OAuth (xAI SuperGrok PKCE) or API keys; multi-login OK\n" +
              "- `/model` — pick any model from **all** connected providers (fetched live)\n" +
              "- `/reasoning` — official model effort modes + ultra / ultra-fusion\n" +
              "- `/subagent` — subagent config\n" +
              "- `/verify [provider]` — live model list proves the key\n" +
              "- `/theme` `/font` `/whoami` `/logout`\n" +
              "- `Ctrl+T` — show/hide all thinking blocks\n" +
              "- **Click** a Thought / tool header to expand or collapse\n\n" +
              "### Reasoning\n\n" +
              "Effort levels are **per model** (from the provider catalog). Esc goes **back** in nested pickers.\n\n" +
              "- **ultra** — max effort + Codex multi-agent (spawn/wait, proactive)\n" +
              "- **ultra-fusion** — peer reasons; main compares, then multi-agent execute",
          },
        ],
      });
      break;

    case "model":
    case "m":
      void openModelPicker(store, ui, args.trim());
      break;

    case "reasoning":
    case "reason":
      openReasoningPicker(store, ui, args.trim().toLowerCase());
      break;

    case "subagent":
    case "subagents":
    case "agents":
      openSubagentMenu(store, ui, args.trim().toLowerCase());
      break;

    case "verify":
    case "check":
      void runVerify(store, args.trim().toLowerCase());
      break;

    case "theme":
    case "t": {
      const name = args.trim().toLowerCase();
      if (name) {
        ui.setTheme(name);
        saveConfig({ theme: resolveTheme(name).name });
        break;
      }
      const current = ui.getThemeName();
      ui.openPicker({
        title: "Theme  (live preview)",
        current,
        options: listThemes().map((t) => ({
          value: t.name,
          label: t.displayName,
          description: t.description,
        })),
        onPreview: (value) => ui.setTheme(value, { preview: true }),
        onSelect: (value) => {
          ui.setTheme(value);
          saveConfig({ theme: resolveTheme(value).name });
        },
      });
      break;
    }

    case "font":
    case "f": {
      const name = args.trim().toLowerCase();
      if (name) {
        ui.setFont(name);
        saveConfig({ font: resolveFont(name).name });
        break;
      }
      const current = ui.getFontName();
      ui.openPicker({
        title: "Font profile  (live preview)",
        current,
        options: FONT_PROFILES.map((f) => ({
          value: f.name,
          label: f.displayName,
          description: f.description,
        })),
        onPreview: (value) => ui.setFont(value, { preview: true }),
        onSelect: (value) => {
          ui.setFont(value);
          saveConfig({ font: resolveFont(value).name });
        },
        onCancel: () => ui.setFont(current),
      });
      break;
    }

    case "login":
    case "auth":
    case "connect": {
      const id = args.trim().toLowerCase() as ProviderId | "";
      if (id && getProvider(id)) {
        startProviderLogin(id, ui, store);
        break;
      }
      ui.openPicker({
        title: "Connect provider  (multi-login OK)",
        options: PROVIDERS.map((p) => {
          const on = Boolean(getCredential(p.id));
          return {
            value: p.id,
            label: `${on ? "*" : " "} ${p.name}`,
            description: p.description,
          };
        }),
        onSelect: (value) => startProviderLogin(value as ProviderId, ui, store),
      });
      break;
    }

    case "logout": {
      const id = args.trim().toLowerCase() as ProviderId | "";
      if (id && getProvider(id)) {
        removeCredential(id);
        clearModelCache(id);
        notify(store, `logged out of ${id}`);
        break;
      }
      const creds = listCredentials();
      if (creds.length === 0) {
        notify(store, "no stored credentials", "info");
        break;
      }
      ui.openPicker({
        title: "Logout",
        options: creds.map((c) => ({
          value: c.provider,
          label: c.provider,
          description: c.label ?? c.method,
        })),
        onSelect: (value) => {
          removeCredential(value as ProviderId);
          clearModelCache(value as ProviderId);
          notify(store, `logged out of ${value}`);
        },
      });
      break;
    }

    case "whoami":
    case "status": {
      const creds = listCredentials();
      const agentCfg = loadAgentSettings();
      const lines: string[] = [];
      if (creds.length === 0) {
        lines.push("No stored credentials. Run `/login`.");
      }
      for (const c of creds) {
        const exp =
          c.method === "oauth_browser" && c.expiresAt
            ? c.expiresAt > Date.now()
              ? ` · expires ${new Date(c.expiresAt).toLocaleString()}`
              : " · expired (will refresh)"
            : "";
        lines.push(
          `- **${c.provider}** (${c.method}) ${c.label ?? ""}  token ${maskSecret(c.token)}${exp}`,
        );
      }
      for (const p of PROVIDERS) {
        if (creds.some((c) => c.provider === p.id)) continue;
        if (p.envKey && process.env[p.envKey]) {
          lines.push(
            `- **${p.id}** (env ${p.envKey})  token ${maskSecret(process.env[p.envKey])}`,
          );
        }
      }
      store.appendMessage({
        id: newId("m"),
        role: "assistant",
        createdAt: Date.now(),
        parts: [
          {
            id: newId("p"),
            type: "text",
            content:
              "### Auth status\n\n" +
              lines.join("\n") +
              `\n\n**Active:** \`${store.state.session.provider}/${store.state.session.model}\`` +
              `\n**Reasoning (this model):** \`${
                store.state.session.provider !== "none" &&
                store.state.session.model !== "unset"
                  ? getEffortForModel(
                      store.state.session.provider as ProviderId,
                      store.state.session.model,
                    )
                  : agentCfg.reasoning.effort
              }\` (native API, per model)` +
              `\n**Custom mode:** \`${agentCfg.reasoning.custom}\`` +
              `\n**Subagents:** ${agentCfg.subagents.enabled ? "on" : "off"}` +
              `  max=${agentCfg.subagents.maxConcurrent}` +
              `  auto=${agentCfg.subagents.autoSpawn ? "on" : "off"}`,
          },
        ],
      });
      break;
    }

    case "thinking":
      applyToggleOrPicker({
        args,
        ui,
        title: "Thinking blocks",
        current: store.state.showThinking ? "on" : "off",
        options: [
          { value: "on", label: "Show", description: "Display reasoning blocks" },
          { value: "off", label: "Hide", description: "Fold reasoning away" },
        ],
        apply: (v) => {
          if (v === "on" && !store.state.showThinking) store.toggle("showThinking");
          if (v === "off" && store.state.showThinking) store.toggle("showThinking");
        },
      });
      break;

    case "details":
      applyToggleOrPicker({
        args,
        ui,
        title: "Tool details",
        current: store.state.showToolDetails ? "on" : "off",
        options: [
          { value: "on", label: "Expanded", description: "Show tool args/results" },
          { value: "off", label: "Collapsed", description: "Status lines only" },
        ],
        apply: (v) => {
          if (v === "on" && !store.state.showToolDetails) store.toggle("showToolDetails");
          if (v === "off" && store.state.showToolDetails) store.toggle("showToolDetails");
        },
      });
      break;

    case "compact":
      applyToggleOrPicker({
        args,
        ui,
        title: "Layout",
        current: store.state.compact ? "on" : "off",
        options: [
          { value: "on", label: "Compact", description: "Less padding" },
          { value: "off", label: "Comfortable", description: "Default spacing" },
        ],
        apply: (v) => {
          if (v === "on" && !store.state.compact) store.toggle("compact");
          if (v === "off" && store.state.compact) store.toggle("compact");
        },
      });
      break;

    case "clear":
    case "new":
      agent.cancel();
      liveAgent?.cancel();
      store.reset({
        title: "demo session",
        model: store.state.session.model,
        provider: store.state.session.provider,
      });
      store.appendMessage({
        id: newId("m"),
        role: "assistant",
        createdAt: Date.now(),
        parts: [
          {
            id: newId("p"),
            type: "text",
            content: "Session cleared.",
          },
        ],
      });
      break;

    case "quit":
    case "exit":
    case "q":
      ui.stop();
      process.exit(0);
      break;

    default: {
      const known = getSlashCommand(cmd);
      notify(
        store,
        known ? `usage: /${known.name}` : `unknown command: /${cmd}  (try /help)`,
        "warn",
      );
    }
  }
}

// ── login ─────────────────────────────────────────────

function startProviderLogin(
  provider: ProviderId,
  ui: TuiRenderer,
  store: HarnessStore,
): void {
  const def = getProvider(provider);
  if (!def) {
    notify(store, `unknown provider: ${provider}`, "error");
    return;
  }

  if (provider === "xai") {
    const hasGrokCli = Boolean(loadGrokCliCredentials());
    const opts = [
      {
        value: "oauth",
        label: "Browser OAuth (SuperGrok)",
        description:
          "PKCE on 127.0.0.1 · opens auth.x.ai · access + refresh tokens",
      },
      ...(hasGrokCli
        ? [
            {
              value: "grok-cli",
              label: "Import Grok CLI (~/.grok/auth.json)",
              description: "Reuse official Grok CLI OAuth tokens",
            },
          ]
        : []),
      {
        value: "paste",
        label: "Paste API key",
        description: "Key from console.x.ai (xai-...)",
      },
      {
        value: "console",
        label: "Open console.x.ai API keys",
        description: "Then paste a developer API key",
      },
    ];
    ui.openPicker({
      title: "xAI (Grok) — auth",
      options: opts,
      onSelect: (method) => {
        if (method === "oauth") {
          void runXaiOAuthLogin(ui, store);
          return;
        }
        if (method === "grok-cli") {
          void runXaiImportGrokCli(store, ui);
          return;
        }
        if (method === "console") openBrowser(XAI_CONSOLE_URL);
        promptXaiKey(ui, store);
      },
    });
    return;
  }

  if (provider === "custom") {
    promptCustom(ui, store);
    return;
  }

  promptApiKey(provider, ui, store);
}

function promptXaiKey(ui: TuiRenderer, store: HarnessStore): void {
  ui.openModalInput({
    title: "xAI API key",
    lines: [
      "Create a key at console.x.ai → API keys",
      "Paste the key below (Bearer auth to api.x.ai/v1)",
      "Prefer Browser OAuth for SuperGrok subscription access",
      XAI_CONSOLE_URL,
    ],
    placeholder: "xai-...",
    secret: true,
    onSubmit: (key) => {
      const r = connectXaiApiKey(key);
      if (!r.ok) {
        ui.setModalError(r.error);
        return;
      }
      ui.dismissModal();
      void onProviderConnected(store, ui, "xai");
    },
  });
}

async function runXaiOAuthLogin(
  ui: TuiRenderer,
  store: HarnessStore,
): Promise<void> {
  // Prefer existing Grok CLI tokens when present (avoids re-auth)
  if (loadGrokCliCredentials()) {
    notify(store, "Found ~/.grok/auth.json — importing Grok CLI OAuth…");
    const imported = await importGrokCliAuth();
    if (imported.ok) {
      notify(store, "xAI connected via Grok CLI tokens (auto-refresh enabled)");
      void onProviderConnected(store, ui, "xai");
      return;
    }
    notify(
      store,
      `Grok CLI import failed (${imported.error}) — starting browser OAuth…`,
      "warn",
    );
  }

  notify(
    store,
    "xAI OAuth: starting local callback on 127.0.0.1:56121…",
  );
  const r = await loginXaiOAuth({
    onProgress: (msg) => notify(store, msg),
    onAuthUrl: (url) => {
      notify(store, "Browser opened to xAI login (auth.x.ai)");
      // Always show full URL — Windows used to truncate &client_id=...
      store.appendMessage({
        id: newId("m"),
        role: "system",
        createdAt: Date.now(),
        parts: [
          {
            id: newId("p"),
            type: "status",
            level: "info",
            message:
              `If the browser shows "Missing or invalid client_id", open this full URL manually (copy entire line):\n${url}`,
          },
        ],
      });
    },
  });
  if (!r.ok) {
    notify(store, `xAI OAuth failed: ${r.error}`, "error");
    return;
  }
  notify(store, "xAI OAuth connected — tokens saved (auto-refresh enabled)");
  void onProviderConnected(store, ui, "xai");
}

async function runXaiImportGrokCli(
  store: HarnessStore,
  ui: TuiRenderer,
): Promise<void> {
  notify(store, "Importing ~/.grok/auth.json…");
  const r = await importGrokCliAuth();
  if (!r.ok) {
    notify(store, `Grok CLI import failed: ${r.error}`, "error");
    return;
  }
  notify(store, "Imported Grok CLI OAuth tokens into Libra");
  void onProviderConnected(store, ui, "xai");
}

function promptApiKey(
  provider: ProviderId,
  ui: TuiRenderer,
  store: HarnessStore,
  baseUrl?: string,
): void {
  const def = getProvider(provider)!;
  const existing = getCredential(provider);
  ui.openModalInput({
    title: `API key — ${def.name}`,
    lines: [
      def.description,
      baseUrl ? `Base URL: ${baseUrl}` : "",
      def.envKey ? `Env fallback: ${def.envKey}` : "",
      def.docsUrl ? `Docs: ${def.docsUrl}` : "",
      existing ? `Existing: ${maskSecret(existing.token)}` : "",
    ].filter(Boolean),
    placeholder: def.keyPlaceholder ?? "API key",
    secret: true,
    onSubmit: (key) => {
      const r = saveApiKey(provider, key, baseUrl ? { baseUrl } : undefined);
      if (!r.ok) {
        ui.setModalError(r.error);
        return;
      }
      ui.dismissModal();
      void onProviderConnected(store, ui, provider);
    },
  });
}

function promptCustom(ui: TuiRenderer, store: HarnessStore): void {
  ui.openModalInput({
    title: "Custom base URL",
    lines: [
      "OpenAI-compatible root (no trailing slash)",
      "Example: http://127.0.0.1:11434/v1",
    ],
    placeholder: "https://api.example.com/v1",
    onSubmit: (url) => {
      const u = url.trim().replace(/\/$/, "");
      if (!u.startsWith("http")) {
        ui.setModalError("URL must start with http:// or https://");
        return;
      }
      ui.dismissModal();
      promptApiKey("custom", ui, store, u);
    },
  });
}

async function onProviderConnected(
  store: HarnessStore,
  ui: TuiRenderer,
  provider: ProviderId,
): Promise<void> {
  clearModelCache(provider);
  notify(store, `${provider} key saved — fetching models...`, "info");
  const listed = await fetchModelsForProvider(provider, { force: true });
  if (listed.error) {
    notify(store, `${provider} connected but model list failed: ${listed.error}`, "warn");
    saveConfig({ provider });
    store.patchSession({ provider });
    return;
  }
  const best = pickHighestReasoningModel(listed.models) ?? listed.models[0];
  if (best) {
    saveConfig({
      provider,
      model: best.id,
      modelKey: modelKey({ provider, model: best.id }),
    });
    store.patchSession({ provider, model: best.id });
    notify(
      store,
      `${provider} OK — ${listed.models.length} models; active ${best.id}`,
    );
  } else {
    saveConfig({ provider });
    store.patchSession({ provider });
    notify(store, `${provider} OK — 0 models returned`, "warn");
  }
  // Offer model picker across ALL connected providers
  await openModelPicker(store, ui, "");
}

// ── models (dynamic, multi-provider) ──────────────────

async function openModelPicker(
  store: HarnessStore,
  ui: TuiRenderer,
  arg: string,
): Promise<void> {
  if (arg) {
    const ref = parseModelKey(arg) ?? {
      provider: (store.state.session.provider as ProviderId) || "xai",
      model: arg,
    };
    if (!getProvider(ref.provider)) {
      // bare id — search connected caches after fetch
      const all = await fetchAllConnectedModels({ force: false });
      const hit = all.models.find(
        (m) => m.id === arg || m.id.endsWith(arg),
      );
      if (hit) {
        applyModel(store, hit.provider, hit.id);
        return;
      }
      notify(store, `unknown model: ${arg}`, "warn");
      return;
    }
    applyModel(store, ref.provider, ref.model);
    return;
  }

  const connected = connectedProviders();
  if (connected.length === 0) {
    notify(store, "no connected providers — run /login first", "warn");
    return;
  }

  toast(store, `loading models…`);
  const { models, byProvider, errors } = await fetchAllConnectedModels({
    force: true,
  });

  for (const p of connected) {
    if (errors[p]) notify(store, `${p}: ${errors[p]}`, "warn");
  }

  if (models.length === 0) {
    const errText = Object.entries(errors)
      .map(([p, e]) => `${p}: ${e}`)
      .join("; ");
    notify(store, `no models: ${errText || "empty"}`, "error");
    return;
  }

  const currentKey =
    loadConfig().modelKey ??
    modelKey({
      provider: store.state.session.provider as ProviderId,
      model: store.state.session.model,
    });

  // Stable sorted list — same order every open
  const sorted = [...models].sort((a, b) => {
    if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
    return a.id.localeCompare(b.id);
  });

  ui.openPickerRoot({
    title: `Models  (${sorted.length})  · enter to select`,
    current: currentKey,
    searchable: true,
    // Enter only — space must NOT apply a random filtered hover
    closeOnSelect: true,
    options: sorted.map((m) => ({
      value: modelKey({ provider: m.provider, model: m.id }),
      label: `${m.provider}/${m.id}`,
      description: `${m.reasoning ? "reasoning  " : ""}${m.description ?? ""}`.trim(),
    })),
    onActivate: () => {
      // no-op: prevent space from applying model mid-browse
    },
    onSelect: (value) => {
      const ref = parseModelKey(value);
      if (!ref) {
        notify(store, `bad model key: ${value}`, "warn");
        return;
      }
      // Only accept exact keys from this list
      const ok = sorted.some(
        (m) => modelKey({ provider: m.provider, model: m.id }) === value,
      );
      if (!ok) {
        notify(store, `model not in catalog: ${value}`, "warn");
        return;
      }
      applyModel(store, ref.provider, ref.model);
    },
  });
}

function applyModel(
  store: HarnessStore,
  provider: ProviderId,
  model: string,
): void {
  if (!getProvider(provider)) {
    notify(store, `unknown provider: ${provider}`, "warn");
    return;
  }
  const id = model.trim();
  if (!id || id === "unset" || id.includes("::")) {
    notify(store, `invalid model id: ${model}`, "warn");
    return;
  }
  const key = modelKey({ provider, model: id });
  saveConfig({
    provider,
    model: id,
    modelKey: key,
  });
  store.patchSession({ provider, model: id });
  toast(store, `model → ${key}`);
}

// ── reasoning ─────────────────────────────────────────

function openReasoningPicker(
  store: HarnessStore,
  ui: TuiRenderer,
  arg: string,
): void {
  const provider = store.state.session.provider as ProviderId;
  const model = store.state.session.model;
  const hasModel =
    Boolean(provider) &&
    provider !== ("none" as ProviderId) &&
    Boolean(model) &&
    model !== "unset";

  if (arg) {
    const custom = CUSTOM_REASONING_OPTIONS.find((o) => o.value === arg);
    if (custom) {
      applyCustomReasoning(store, ui, custom.value);
      return;
    }
    // Direct effort arg — only if active model supports it
    if (hasModel) {
      const opts = effortPickerOptions(provider, model);
      const hit = opts.find((o) => o.value === arg);
      if (hit) {
        setEffortForModel(
          provider,
          model,
          hit.value as EffortLevel | "default",
        );
        notify(
          store,
          `reasoning → ${effortLabel(hit.value as EffortLevel | "default")} for ${provider}/${model}`,
        );
        return;
      }
      notify(
        store,
        `"${arg}" not supported by ${model}. Supported: ${opts.map((o) => o.value).join(", ")}`,
        "warn",
      );
      return;
    }
    notify(store, `unknown reasoning mode: ${arg}`, "warn");
    return;
  }

  // Main model efforts + (if fusion) peer effort entry
  void openEffortModesPicker(store, ui);
}

/**
 * Reasoning modes for the active model only — live supported_efforts.
 * Root picker (Esc closes). Nested fusion/custom open via openPicker (Esc back).
 */
async function openEffortModesPicker(
  store: HarnessStore,
  ui: TuiRenderer,
): Promise<void> {
  const provider = store.state.session.provider as ProviderId;
  const model = store.state.session.model;
  const cur = loadAgentSettings();

  if (
    !provider ||
    provider === ("none" as ProviderId) ||
    !model ||
    model === "unset"
  ) {
    // No model: show custom harness modes only
    ui.openPickerRoot({
      title: "Reasoning",
      current: cur.reasoning.custom,
      options: CUSTOM_REASONING_OPTIONS.map((o) => ({
        value: `custom:${o.value}`,
        label: o.label,
        description: o.description,
      })),
      onSelect: (v) => {
        const mode = v.replace(/^custom:/, "") as CustomReasoningMode;
        applyCustomReasoning(store, ui, mode);
      },
    });
    notify(store, "pick a model (/model) for per-model effort levels", "warn");
    return;
  }

  // Always refresh catalog so supported_efforts are real, not stale heuristics
  notify(store, `loading reasoning modes for ${provider}/${model}…`);
  try {
    await fetchModelsForProvider(provider, { force: true });
  } catch {
    /* caps may still be cached from a prior fetch */
  }

  const caps = getCachedReasoningCaps(provider, model);
  const current = getEffortForModel(provider, model);
  // Prefer API cache only — do not invent full effort lists
  const effortOpts = effortPickerOptions(provider, model, {
    allowHeuristic: caps?.source !== "api",
  });

  const options: { value: string; label: string; description?: string }[] = [];

  for (const o of effortOpts) {
    options.push({
      value: `effort:${o.value}`,
      label: o.label,
      description: o.description,
    });
  }

  // Peer effort when fusion is active
  if (cur.reasoning.custom === "ultra-fusion") {
    const peerKey = cur.reasoning.fusion.modelKeys[0];
    if (peerKey) {
      const pref = parseModelKey(peerKey);
      const pe = pref
        ? getEffortForModel(pref.provider, pref.model)
        : "default";
      options.push({
        value: "menu:peer-effort",
        label: "Peer effort",
        description: `${peerKey} · ${pe}`,
      });
    } else {
      options.push({
        value: "menu:peer-setup",
        label: "Peer model + effort",
        description: "Pick the fusion peer and its reasoning effort",
      });
    }
  }

  // ultra / ultra-fusion (not API effort levels)
  for (const o of CUSTOM_REASONING_OPTIONS) {
    if (o.value === "none") continue;
    options.push({
      value: `custom:${o.value}`,
      label: o.label,
      description: o.description,
    });
  }

  const currentKey =
    current && current !== "default"
      ? `effort:${current}`
      : "effort:default";

  const effortList =
    caps?.efforts?.length
      ? caps.efforts.join(", ")
      : caps?.source === "api"
        ? "none in catalog"
        : "unknown";
  const src = caps?.source ?? "none";

  ui.openPickerRoot({
    title: `Reasoning · ${model}  [${src}: ${effortList}]`,
    current: currentKey,
    options,
    onSelect: (v) => {
      if (v === "menu:peer-effort") {
        const peerKey = loadAgentSettings().reasoning.fusion.modelKeys[0];
        const pref = peerKey ? parseModelKey(peerKey) : null;
        if (pref) {
          void openModelEffortPicker(
            store,
            ui,
            pref.provider,
            pref.model,
          );
        }
        return;
      }
      if (v === "menu:peer-setup") {
        openFusionConfig(store, ui);
        return;
      }
      if (v.startsWith("effort:")) {
        const e = v.slice("effort:".length) as EffortLevel | "default";
        // Reject efforts not in catalog when we have API caps
        if (
          e !== "default" &&
          caps?.source === "api" &&
          caps.efforts.length > 0 &&
          !caps.efforts.includes(e)
        ) {
          notify(
            store,
            `${model} does not support "${e}" (catalog: ${caps.efforts.join(", ")})`,
            "warn",
          );
          return;
        }
        setEffortForModel(provider, model, e);
        toast(
          store,
          e === "default"
            ? `${provider}/${model} → default`
            : `${provider}/${model} → ${effortLabel(e)}`,
        );
        return;
      }
      if (v.startsWith("custom:")) {
        const mode = v.slice("custom:".length) as CustomReasoningMode;
        applyCustomReasoning(store, ui, mode);
      }
    },
  });
}

function applyCustomReasoning(
  store: HarnessStore,
  ui: TuiRenderer,
  mode: CustomReasoningMode,
): void {
  saveAgentSettings({ reasoning: { custom: mode } });
  if (mode === "ultra" || mode === "ultra-fusion") {
    void activateUltraNative(store, mode).then(() => {
      if (mode === "ultra-fusion") openFusionConfig(store, ui);
    });
    return;
  }
  notify(store, `harness mode → ${mode}`);
}

/**
 * Ultra / ultra-fusion: keep the user's current model (do not randomly swap).
 * Pin max native effort on that model; only auto-pick if none is selected.
 */
async function activateUltraNative(
  store: HarnessStore,
  mode: "ultra" | "ultra-fusion",
): Promise<void> {
  toast(
    store,
    mode === "ultra-fusion" ? "ultra-fusion: preparing…" : "ultra: preparing…",
  );
  const { models, errors } = await fetchAllConnectedModels({ force: true });
  if (models.length === 0) {
    notify(
      store,
      `no models available${Object.keys(errors).length ? ` (${Object.values(errors).join("; ")})` : ""} — /login`,
      "warn",
    );
    return;
  }

  const curProvider = store.state.session.provider as ProviderId;
  const curModel = store.state.session.model;
  const hasCurrent =
    Boolean(getProvider(curProvider)) &&
    curModel &&
    curModel !== "unset" &&
    curModel !== "libra-mock" &&
    curModel !== "libra-demo" &&
    models.some((m) => m.provider === curProvider && m.id === curModel);

  // Prefer staying on the active model — never jump to a random "highest" model
  let provider = curProvider;
  let modelId = curModel;
  if (!hasCurrent) {
    const best = pickHighestNativeReasoningModel(models);
    if (!best) {
      notify(store, "could not pick a reasoning model", "warn");
      return;
    }
    provider = best.provider;
    modelId = best.id;
    applyModel(store, provider, modelId);
  }

  const caps = resolveCapsForModel(provider, modelId, true);
  const top = setMaxEffortForModel(provider, modelId);

  const a = loadAgentSettings();
  saveAgentSettings({
    reasoning: {
      ...a.reasoning,
      custom: mode,
      effort: top ?? a.reasoning.effort,
    },
    subagents: {
      ...a.subagents,
      enabled: true,
      autoSpawn: true,
      preferredModelKey: modelKey({ provider, model: modelId }),
    },
  });

  const effortNote = top
    ? `native effort=${top}`
    : caps.supported
      ? "native reasoning"
      : "no effort control";
  toast(
    store,
    `${mode} · ${provider}/${modelId} · ${effortNote}` +
      (mode === "ultra-fusion" ? " · peer reasons too" : ""),
  );
}

/**
 * Ultra + Fusion setup — keep it simple:
 *   Main = your active model (reasons + executes)
 *   Peer = one additional model (reasons only)
 */
function openFusionConfig(store: HarnessStore, ui: TuiRenderer): void {
  const cur = loadAgentSettings().reasoning.fusion;
  const mainProv = store.state.session.provider as ProviderId;
  const mainModel = store.state.session.model;
  const main = `${mainProv}/${mainModel}`;
  const peer = cur.modelKeys[0];
  const mainEff =
    mainModel && mainModel !== "unset"
      ? getEffortForModel(mainProv, mainModel)
      : "default";
  let peerEff = "default";
  if (peer) {
    const ref = parseModelKey(peer);
    if (ref) peerEff = getEffortForModel(ref.provider, ref.model);
  }

  ui.openPickerRoot({
    title: "Ultra + Fusion",
    options: [
      {
        value: "main-effort",
        label: "Main reasoning effort",
        description: `${main} · ${mainEff}`,
      },
      {
        value: "peer",
        label: "Peer model",
        description: peer
          ? `${peer} · effort ${peerEff}`
          : "Auto-pick strongest other model",
      },
      {
        value: "peer-effort",
        label: "Peer reasoning effort",
        description: peer
          ? `${peerEff} (for ${peer.split("/").slice(-1)[0]})`
          : "Pick a peer model first",
      },
      {
        value: "done",
        label: "Done",
        description: `Main: ${main}`,
      },
    ],
    onSelect: (value) => {
      if (value === "done") return;
      if (value === "main-effort") {
        void openModelEffortPicker(store, ui, mainProv, mainModel, () =>
          openFusionConfig(store, ui),
        );
        return;
      }
      if (value === "peer") {
        void openFusionPeerPicker(store, ui);
        return;
      }
      if (value === "peer-effort") {
        if (!peer) {
          toast(store, "pick a peer model first");
          openFusionConfig(store, ui);
          return;
        }
        const ref = parseModelKey(peer);
        if (!ref) {
          notify(store, `bad peer key: ${peer}`, "warn");
          return;
        }
        void openModelEffortPicker(store, ui, ref.provider, ref.model, () =>
          openFusionConfig(store, ui),
        );
      }
    },
  });
}

/** Effort picker for any provider/model (main or peer). */
async function openModelEffortPicker(
  store: HarnessStore,
  ui: TuiRenderer,
  provider: ProviderId,
  model: string,
  onBack?: () => void,
): Promise<void> {
  if (!provider || !model || model === "unset") {
    toast(store, "no model selected");
    onBack?.();
    return;
  }
  try {
    await fetchModelsForProvider(provider, { force: false });
  } catch {
    /* caps may be cached */
  }
  const caps = getCachedReasoningCaps(provider, model);
  const current = getEffortForModel(provider, model);
  const opts = effortPickerOptions(provider, model, {
    allowHeuristic: caps?.source !== "api",
  });
  const effortList = caps?.efforts?.length
    ? caps.efforts.join(", ")
    : caps?.source === "api"
      ? "none in catalog"
      : "unknown";

  ui.openPicker({
    title: `Effort · ${model}  [${caps?.source ?? "?"}: ${effortList}]`,
    current,
    options: opts.map((o) => ({
      value: o.value,
      label: o.label,
      description: o.description,
    })),
    onSelect: (v) => {
      setEffortForModel(provider, model, v as EffortLevel | "default");
      toast(store, `${provider}/${model} → ${effortLabel(v as EffortLevel | "default")}`);
      onBack?.();
    },
  });
}

/** Pick exactly one peer reasoner (hard cap = 1). */
async function openFusionPeerPicker(
  store: HarnessStore,
  ui: TuiRenderer,
): Promise<void> {
  toast(store, "loading models…");
  const { models, errors } = await fetchAllConnectedModels({ force: true });
  if (models.length === 0) {
    notify(
      store,
      `no models (${Object.values(errors).join("; ") || "login first"})`,
      "error",
    );
    return;
  }

  const mainKey = modelKey({
    provider: store.state.session.provider as ProviderId,
    model: store.state.session.model,
  });
  const cur = loadAgentSettings().reasoning.fusion.modelKeys[0] ?? "";

  ui.openPicker({
    title: "Peer model  (1 max · reasons with main)",
    current: cur || "__auto__",
    searchable: true,
    options: [
      {
        value: "__auto__",
        label: "(auto) strongest other model",
        description: "Picked at run time from connected providers",
      },
      ...models
        .filter(
          (m) => modelKey({ provider: m.provider, model: m.id }) !== mainKey,
        )
        .map((m) => {
          const key = modelKey({ provider: m.provider, model: m.id });
          return {
            value: key,
            label: `${m.provider}/${m.id}`,
            description: m.reasoning ? "reasoning" : "",
          };
        }),
    ],
    onSelect: (value) => {
      saveAgentSettings({
        reasoning: {
          fusion: {
            ...loadAgentSettings().reasoning.fusion,
            modelKeys: value === "__auto__" ? [] : [value],
            maxParallel: 1,
          },
        },
      });
      toast(
        store,
        value === "__auto__" ? "peer → auto" : `peer → ${value}`,
      );
      if (value !== "__auto__") {
        const ref = parseModelKey(value);
        if (ref) {
          // Next: set peer effort (catalog-backed)
          void openModelEffortPicker(store, ui, ref.provider, ref.model, () =>
            openFusionConfig(store, ui),
          );
          return;
        }
      }
      openFusionConfig(store, ui);
    },
  });
}

/** Route: ultra-fusion prep → live agent (if auth+model) → mock demo. */
async function handleUserSubmit(
  text: string,
  store: HarnessStore,
  mock: MockAgent,
  live: AgentLoop,
): Promise<void> {
  const provider = store.state.session.provider as ProviderId;
  const model = store.state.session.model;
  const hasAuth =
    Boolean(getProvider(provider) && resolveToken(provider)) &&
    model &&
    model !== "unset" &&
    model !== "libra-mock" &&
    model !== "libra-demo";

  const mode = loadAgentSettings().reasoning.custom;

  // Ultra + Fusion: secondaries reason only → main reviews & executes with tools
  if (mode === "ultra-fusion") {
    if (!hasAuth) {
      notify(
        store,
        "ultra-fusion needs a logged-in main model (/login + /model)",
        "warn",
      );
      return;
    }
    try {
      const settings = loadAgentSettings();
      // Collect dual reasoning off-screen; display as one normal thinking block
      const prep = await prepareFusionForMain(
        store,
        text,
        provider,
        model,
      );
      toast(store, prep.summary);
      const system =
        buildSystemPrompt({
          extra: settings.reasoning.customInstructions,
          model,
          provider,
          cwd: process.cwd(),
        }) +
        "\n\n" +
        prep.systemAddon;
      await live.handle(text, {
        provider,
        model,
        cwd: process.cwd(),
        tools: true,
        systemPrompt: system,
        // Same assistant turn as tools/text — not a split second panel
        seedReasoning: prep.displayReasoning,
      });
    } catch (err) {
      notify(
        store,
        err instanceof Error ? err.message : String(err),
        "error",
      );
      store.setPhase("idle");
    }
    return;
  }

  if (hasAuth) {
    await live.handle(text, {
      provider,
      model,
      cwd: process.cwd(),
      tools: true,
    });
    return;
  }

  // Fallback demo loop so the TUI still responds without keys
  notify(
    store,
    "No live model selected — using demo agent. /login openrouter then /model",
    "info",
  );
  await mock.handle(text);
}

// ── subagents ─────────────────────────────────────────

function openSubagentMenu(
  store: HarnessStore,
  ui: TuiRenderer,
  arg: string,
): void {
  const cfg = loadAgentSettings();
  const action = arg.trim().toLowerCase();

  if (action === "on" || action === "off") {
    saveAgentSettings({
      subagents: { ...cfg.subagents, enabled: action === "on" },
    });
    notify(store, `subagents ${action}`);
    return;
  }

  // Same actions as the subagent tab / autocomplete suggestions
  if (
    action === "toggle" ||
    action === "auto" ||
    action === "max" ||
    action === "roles" ||
    action === "model" ||
    action === "reset"
  ) {
    applySubagentAction(store, ui, action, () =>
      openSubagentMenu(store, ui, ""),
    );
    return;
  }

  const show = (): void => {
    const live = loadAgentSettings();
    ui.openPicker({
      title: "Subagents",
      closeOnSelect: false,
      options: [
        {
          value: "toggle",
          label: "Enabled",
          description: live.subagents.enabled ? "on" : "off",
          cycleValues: ["off", "on"],
          cycleIndex: live.subagents.enabled ? 1 : 0,
        },
        {
          value: "auto",
          label: "Auto-spawn",
          description: live.subagents.autoSpawn
            ? "ON — complex tasks (ultra forces this)"
            : "OFF — explicit only",
          cycleValues: ["off", "on"],
          cycleIndex: live.subagents.autoSpawn ? 1 : 0,
        },
        {
          value: "max",
          label: "Max concurrent",
          description: String(live.subagents.maxConcurrent),
          cycleValues: ["1", "2", "3", "4", "6", "8"],
          cycleIndex: Math.max(
            0,
            ["1", "2", "3", "4", "6", "8"].indexOf(
              String(live.subagents.maxConcurrent),
            ),
          ),
        },
        {
          value: "roles",
          label: "Roles",
          description: `${live.subagents.roles.filter((r) => r.enabled).length}/${live.subagents.roles.length} enabled`,
        },
        {
          value: "model",
          label: "Preferred model",
          description:
            live.subagents.preferredModelKey ??
            "(highest reasoning among connected)",
        },
        {
          value: "reset",
          label: "Reset defaults",
          description: "Restore default roles and limits",
        },
        {
          value: "done",
          label: "Done",
          description: "Close this menu",
        },
      ],
      // Space / left / right → onCycle only (toggle value). Enter → onSelect.
      onCycle: (value, dir) => {
        const s = loadAgentSettings();
        if (value === "toggle") {
          saveAgentSettings({
            subagents: { ...s.subagents, enabled: !s.subagents.enabled },
          });
          show();
        } else if (value === "auto") {
          saveAgentSettings({
            subagents: {
              ...s.subagents,
              autoSpawn: !s.subagents.autoSpawn,
              enabled: true,
            },
          });
          show();
        } else if (value === "max") {
          const vals = [1, 2, 3, 4, 6, 8];
          const i = Math.max(0, vals.indexOf(s.subagents.maxConcurrent));
          const next = vals[(i + dir + vals.length) % vals.length]!;
          saveAgentSettings({
            subagents: { ...s.subagents, maxConcurrent: next },
          });
          show();
        }
        // roles / model / done: not cyclable — enter only
      },
      onSelect: (value) => {
        applySubagentAction(store, ui, value, show);
      },
    });
  };
  show();
}

function applySubagentAction(
  store: HarnessStore,
  ui: TuiRenderer,
  value: string,
  redraw: () => void,
): void {
  const live = loadAgentSettings();
  if (value === "done") {
    ui.closePicker();
    notify(store, "subagent settings saved", "info");
    return;
  }
  if (value === "toggle") {
    saveAgentSettings({
      subagents: { ...live.subagents, enabled: !live.subagents.enabled },
    });
    notify(store, `subagents ${!live.subagents.enabled ? "on" : "off"}`);
    redraw();
  } else if (value === "auto") {
    saveAgentSettings({
      subagents: {
        ...live.subagents,
        autoSpawn: !live.subagents.autoSpawn,
        enabled: true,
      },
    });
    notify(store, `auto-spawn ${!live.subagents.autoSpawn ? "on" : "off"}`);
    redraw();
  } else if (value === "max") {
    // cycle handled by onCycle; activate bumps +1
    const vals = [1, 2, 3, 4, 6, 8];
    const i = Math.max(0, vals.indexOf(live.subagents.maxConcurrent));
    const next = vals[(i + 1) % vals.length]!;
    saveAgentSettings({
      subagents: { ...live.subagents, maxConcurrent: next },
    });
    notify(store, `max concurrent → ${next}`);
    redraw();
  } else if (value === "roles") {
    openRoleEditor(store, ui);
  } else if (value === "model") {
    void openModelPicker(store, ui, "").then(() => {
      const s = store.state.session;
      saveAgentSettings({
        subagents: {
          ...loadAgentSettings().subagents,
          preferredModelKey: `${s.provider}/${s.model}`,
        },
      });
      notify(store, `subagent preferred model → ${s.provider}/${s.model}`);
    });
  } else if (value === "reset") {
    saveAgentSettings({
      subagents: {
        enabled: true,
        maxConcurrent: 4,
        autoSpawn: false,
        preferredModelKey: undefined,
        roles: DEFAULT_SUBAGENT_ROLES.map((r) => ({ ...r })),
      },
    });
    notify(store, "subagent config reset");
    redraw();
  }
}

function openRoleEditor(store: HarnessStore, ui: TuiRenderer): void {
  const cfg = loadAgentSettings();
  ui.openPicker({
    title: "Subagent roles",
    options: cfg.subagents.roles.map((r) => ({
      value: r.id,
      label: `${r.enabled ? "*" : " "} ${r.name}`,
      description: truncate(r.instructions, 50),
    })),
    onSelect: (id) => {
      const live = loadAgentSettings();
      const role = live.subagents.roles.find((r) => r.id === id);
      if (!role) return;
      ui.openPicker({
        title: `Role: ${role.name}`,
        options: [
          {
            value: "toggle",
            label: role.enabled ? "Disable" : "Enable",
            description: "",
          },
          {
            value: "edit",
            label: "Edit instructions",
            description: truncate(role.instructions, 40),
          },
        ],
        onSelect: (act) => {
          if (act === "toggle") {
            const roles = loadAgentSettings().subagents.roles.map((r) =>
              r.id === id ? { ...r, enabled: !r.enabled } : r,
            );
            saveAgentSettings({
              subagents: { ...loadAgentSettings().subagents, roles },
            });
            notify(store, `${role.name} ${role.enabled ? "disabled" : "enabled"}`);
          } else if (act === "edit") {
            ui.openModalInput({
              title: `Instructions — ${role.name}`,
              lines: ["System instructions for this subagent role"],
              placeholder: role.instructions,
              onSubmit: (text) => {
                const roles = loadAgentSettings().subagents.roles.map((r) =>
                  r.id === id
                    ? { ...r, instructions: text.trim() || r.instructions }
                    : r,
                );
                saveAgentSettings({
                  subagents: { ...loadAgentSettings().subagents, roles },
                });
                ui.dismissModal();
                notify(store, `${role.name} instructions updated`);
              },
            });
          }
        },
      });
    },
  });
}

// ── verify ────────────────────────────────────────────

async function runVerify(
  store: HarnessStore,
  providerArg: string,
): Promise<void> {
  notify(store, "verifying auth + fetching models...", "info");
  const offline = await verifyAuthModelsOffline();
  let live: VerifyResult[] = [];
  if (providerArg && getProvider(providerArg)) {
    live = [await verifyProvider(providerArg as ProviderId)];
  } else {
    live = await verifyAll({});
  }

  const lines: string[] = ["### Auth verification\n", "**Offline**\n"];
  for (const r of offline) {
    lines.push(
      `- ${r.ok ? "+" : "x"} **${r.provider}** ${r.status}: ${r.message}`,
    );
  }
  lines.push("\n**Live (model list)**\n");
  if (live.length === 0) lines.push("- (no credentials)");
  for (const r of live) {
    lines.push(
      `- ${r.ok ? "+" : "x"} **${r.provider}** ${r.status}: ${r.message}` +
        (r.modelCount != null ? ` (${r.modelCount} models)` : ""),
    );
  }
  store.appendMessage({
    id: newId("m"),
    role: "assistant",
    createdAt: Date.now(),
    parts: [{ id: newId("p"), type: "text", content: lines.join("\n") }],
  });
}

// ── helpers ───────────────────────────────────────────

function applyToggleOrPicker(opts: {
  args: string;
  ui: TuiRenderer;
  title: string;
  current: string;
  options: { value: string; label: string; description?: string }[];
  apply: (value: string) => void;
}): void {
  const raw = opts.args.trim().toLowerCase();
  if (raw === "on" || raw === "off" || raw === "true" || raw === "false") {
    opts.apply(raw === "true" ? "on" : raw === "false" ? "off" : raw);
    return;
  }
  if (raw) {
    const hit = ON_OFF.find((o) => o.value === raw || o.value.startsWith(raw));
    if (hit) {
      opts.apply(hit.value);
      return;
    }
  }
  opts.ui.openPicker({
    title: opts.title,
    current: opts.current,
    options: opts.options,
    onSelect: (value) => opts.apply(value),
  });
}

/** Brief status-bar feedback — does not spam the scrollback. */
function toast(store: HarnessStore, message: string): void {
  const phase = store.state.phase;
  store.setPhase(phase === "error" ? "idle" : phase, message);
  // Clear toast after a moment if still idle with this label
  const label = message;
  setTimeout(() => {
    if (
      store.state.phase === "idle" &&
      store.state.activityLabel === label
    ) {
      store.setPhase("idle");
    }
  }, 2500);
}

/**
 * Log to scrollback. Use for real events (auth, errors).
 * Prefer toast() for settings / picker feedback.
 */
function notify(
  store: HarnessStore,
  message: string,
  level: "success" | "info" | "warn" | "error" = "success",
): void {
  // Settings-style info/success stay in the status bar only
  if (level === "success" || level === "info") {
    toast(store, message);
    return;
  }
  store.appendMessage({
    id: newId("m"),
    role: "system",
    createdAt: Date.now(),
    parts: [
      {
        id: newId("p"),
        type: "status",
        level,
        message,
      },
    ],
  });
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 3) + "...";
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
