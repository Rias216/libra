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

async function main(): Promise<void> {
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
  });

  store.subscribe((_event, state) => {
    ui.setState(state, _event);
    ui.paint();
  });

  const connected = connectedProviders();
  const agentCfg = loadAgentSettings();
  const authLine =
    connected.length > 0
      ? `Connected: ${connected.join(", ")}`
      : "Not logged in — `/login` (multi-provider OK)";

  store.appendMessage({
    id: newId("m"),
    role: "assistant",
    createdAt: Date.now(),
    parts: [
      {
        id: newId("p"),
        type: "text",
        content:
          "Welcome to **Libra** — live chat + tool calling.\n\n" +
          "- Chat uses the active **provider/model** with tools (`list_dir`, `read_file`, `grep`, …)\n" +
          "- `/login` · `/model` · `/verify` · `/reasoning` · `/subagent`\n" +
          `- ${authLine}\n` +
          `- Active: **${store.state.session.provider}** / \`${store.state.session.model}\`\n` +
          `- Reasoning: per-model native API effort (see \`/reasoning\`) · custom=\`${agentCfg.reasoning.custom}\`` +
          (agentCfg.reasoning.custom === "ultra-fusion"
            ? `\n- Fusion models: ${agentCfg.reasoning.fusion.modelKeys.length || "(auto-pick)"}`
            : "") +
          (resolveToken("openrouter")
            ? "\n\nOpenRouter key detected — try: `/model tencent/hy3:free` then ask a question."
            : "\n\nConnect a provider with `/login` to start live chat."),
      },
    ],
  });

  ui.setState(store.state);

  const shutdown = () => {
    ui.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await ui.start();
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
              "- `/theme` `/font` `/whoami` `/logout`\n\n" +
              "### Reasoning\n\n" +
              "Effort levels are **per model** (from the provider catalog). Esc goes **back** in nested pickers.\n\n" +
              "- **ultra** — max effort + auto subagents\n" +
              "- **ultra-fusion** — both reason; main compares both traces & executes",
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

  notify(store, `fetching models from ${connected.join(", ")}...`, "info");
  const { models, byProvider, errors } = await fetchAllConnectedModels({
    force: true,
  });

  // Surface per-provider status so missing xAI keys aren't silent
  for (const p of connected) {
    const n = byProvider[p]?.length ?? 0;
    if (errors[p]) {
      notify(store, `${p}: ${errors[p]}`, "warn");
    } else {
      notify(store, `${p}: ${n} models`, "info");
    }
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

  ui.openPicker({
    title: `Models  (${models.length})`,
    current: currentKey,
    searchable: true,
    options: models.map((m) => ({
      value: modelKey({ provider: m.provider, model: m.id }),
      // Show provider prefix so multi-login lists are scannable
      label: `${m.provider}/${m.id}`,
      description: `${m.reasoning ? "reasoning  " : ""}${m.description ?? ""}`.trim(),
    })),
    onSelect: (value) => {
      const ref = parseModelKey(value);
      if (!ref) {
        // openrouter ids can contain slashes — parseModelKey uses first segment
        notify(store, `bad model key: ${value}`, "warn");
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
  saveConfig({
    provider,
    model,
    modelKey: modelKey({ provider, model }),
  });
  store.patchSession({ provider, model });
  notify(store, `model → ${provider}/${model}`);
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

  // Open effort modes directly for the active model (no submenu wrapper)
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
        notify(
          store,
          e === "default"
            ? `${provider}/${model} → model default`
            : `${provider}/${model} → ${effortLabel(e)} (native API)`,
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
 * Ultra / ultra-fusion: select the strongest native-reasoning model from
 * live provider catalogs and pin its highest supported API effort.
 */
async function activateUltraNative(
  store: HarnessStore,
  mode: "ultra" | "ultra-fusion",
): Promise<void> {
  notify(
    store,
    mode === "ultra-fusion"
      ? "ultra-fusion: loading native reasoning catalogs…"
      : "ultra: loading native reasoning catalogs…",
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

  const best = pickHighestNativeReasoningModel(models);
  if (!best) {
    notify(store, "could not pick a reasoning model", "warn");
    return;
  }

  const caps = resolveCapsForModel(best.provider, best.id, best.reasoning === true);
  const top = setMaxEffortForModel(best.provider, best.id);
  applyModel(store, best.provider, best.id);

  const a = loadAgentSettings();
  saveAgentSettings({
    reasoning: {
      ...a.reasoning,
      custom: mode,
      // Global fallback also max so new models clamp high
      effort: top ?? a.reasoning.effort,
    },
    subagents: {
      ...a.subagents,
      enabled: true,
      autoSpawn: true,
      preferredModelKey: modelKey({
        provider: best.provider,
        model: best.id,
      }),
    },
  });

  const effortNote = top
    ? `native effort=${top}`
    : caps.supported
      ? "native reasoning (no effort enum)"
      : "no native effort control on this model";
  const source = caps.source === "api" ? "catalog" : caps.source;
  notify(
    store,
    `${mode} → ${best.provider}/${best.id} (${effortNote}, ${source})` +
      (mode === "ultra-fusion"
        ? " · both reason → main compares & executes"
        : " · auto subagents"),
  );
}

/** Configure fusion: secondary reasoners + compare instructions. */
function openFusionConfig(store: HarnessStore, ui: TuiRenderer): void {
  const cur = loadAgentSettings().reasoning.fusion;
  const main = `${store.state.session.provider}/${store.state.session.model}`;
  ui.openPicker({
    title: "Ultra + Fusion  (both reason · main compares & executes)",
    options: [
      {
        value: "models",
        label: "Secondary reasoner models",
        description:
          cur.modelKeys.length > 0
            ? `${cur.modelKeys.length} selected (reason with main)`
            : "auto-pick peers (main always reasons too)",
      },
      {
        value: "parallel",
        label: `Max secondaries: ${cur.maxParallel}`,
        description: "Parallel phase-1 reasoners (+ main)",
      },
      {
        value: "analysis",
        label: "Phase-1 reasoning instructions",
        description: truncate(cur.analysisInstructions, 40),
      },
      {
        value: "fuse",
        label: "Main compare instructions",
        description: truncate(cur.fuseInstructions, 40),
      },
      {
        value: "done",
        label: "Done",
        description: `Main (reason + execute): ${main}`,
      },
    ],
    onSelect: (value) => {
      if (value === "done") return;
      if (value === "models") {
        void openFusionModelMultiSelect(store, ui);
        return;
      }
      if (value === "parallel") {
        ui.openPicker({
          title: "Max secondary reasoners",
          current: String(cur.maxParallel),
          options: [1, 2, 3, 4, 5, 6].map((n) => ({
            value: String(n),
            label: String(n),
            description: n === 3 ? "default" : "",
          })),
          onSelect: (v) => {
            saveAgentSettings({
              reasoning: {
                fusion: {
                  ...loadAgentSettings().reasoning.fusion,
                  maxParallel: Number(v),
                },
              },
            });
            notify(store, `fusion max parallel → ${v}`);
            openFusionConfig(store, ui);
          },
        });
        return;
      }
      if (value === "analysis" || value === "fuse") {
        const field =
          value === "analysis" ? "analysisInstructions" : "fuseInstructions";
        const live = loadAgentSettings().reasoning.fusion;
        ui.openModalInput({
          title:
            field === "analysisInstructions"
              ? "Phase-1 reasoning instructions"
              : "Main compare instructions",
          lines:
            field === "analysisInstructions"
              ? [
                  "Sent to main + secondaries in the reason-only pass",
                  "No tools or edits in phase 1",
                ]
              : [
                  "Sent to main with both reasonings",
                  "Main compares, merges, then executes with tools",
                ],
          placeholder: live[field],
          onSubmit: (text) => {
            saveAgentSettings({
              reasoning: {
                fusion: {
                  ...loadAgentSettings().reasoning.fusion,
                  [field]: text.trim() || live[field],
                },
              },
            });
            ui.dismissModal();
            notify(store, `${field} saved`);
            openFusionConfig(store, ui);
          },
        });
      }
    },
  });
}

/**
 * Multi-select fusion models: toggle membership in fusion.modelKeys.
 * Uses repeated picker (toggle on select) for TUI simplicity.
 */
async function openFusionModelMultiSelect(
  store: HarnessStore,
  ui: TuiRenderer,
): Promise<void> {
  notify(store, "loading models for fusion roster...", "info");
  const { models, errors } = await fetchAllConnectedModels({ force: true });
  if (models.length === 0) {
    notify(
      store,
      `no models available (${Object.values(errors).join("; ") || "login first"})`,
      "error",
    );
    return;
  }

  const show = (): void => {
    const fusion = loadAgentSettings().reasoning.fusion;
    const selected = new Set(fusion.modelKeys);
    const toggle = (value: string) => {
      if (value === "__done__") {
        const n = loadAgentSettings().reasoning.fusion.modelKeys.length;
        notify(
          store,
          n >= 1
            ? `secondary reasoners: ${n}`
            : "no secondaries selected — will auto-pick at runtime",
        );
        openFusionConfig(store, ui);
        return;
      }
      if (value === "__clear__") {
        saveAgentSettings({
          reasoning: {
            fusion: {
              ...loadAgentSettings().reasoning.fusion,
              modelKeys: [],
            },
          },
        });
        show();
        return;
      }
      const live = loadAgentSettings().reasoning.fusion;
      const set = new Set(live.modelKeys);
      if (set.has(value)) set.delete(value);
      else set.add(value);
      saveAgentSettings({
        reasoning: {
          fusion: {
            ...live,
            modelKeys: [...set],
          },
        },
      });
      show();
    };
    ui.openPicker({
      title: `Secondary reasoners  (${selected.size} selected · reason only)`,
      searchable: true,
      closeOnSelect: false,
      options: [
        {
          value: "__done__",
          label: "Done",
          description: "Save roster and return",
        },
        {
          value: "__clear__",
          label: "Clear all",
          description: "Use auto-pick at runtime",
        },
        ...models.map((m) => {
          const key = modelKey({ provider: m.provider, model: m.id });
          const on = selected.has(key);
          return {
            value: key,
            label: `${on ? "[on]" : "[  ]"} ${m.provider}/${m.id}`,
            description: m.reasoning ? "reasoning" : "",
            cycleValues: ["off", "on"],
            cycleIndex: on ? 1 : 0,
          };
        }),
      ],
      // Space / left / right toggle without leaving
      onActivate: (value) => {
        if (value === "__done__") {
          ui.closePicker();
          toggle(value);
          return;
        }
        toggle(value);
      },
      onCycle: (value) => {
        if (value.startsWith("__")) return;
        toggle(value);
      },
      onSelect: (value) => {
        if (value === "__done__") {
          ui.closePicker();
          toggle(value);
          return;
        }
        toggle(value);
      },
    });
  };
  show();
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
      const prep = await prepareFusionForMain(
        store,
        text,
        provider,
        model,
      );
      notify(store, prep.summary);
      const system =
        buildSystemPrompt(settings.reasoning.customInstructions) +
        "\n\n" +
        prep.systemAddon;
      await live.handle(text, {
        provider,
        model,
        cwd: process.cwd(),
        tools: true,
        systemPrompt: system,
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

  if (arg === "on" || arg === "off") {
    saveAgentSettings({
      subagents: { ...cfg.subagents, enabled: arg === "on" },
    });
    notify(store, `subagents ${arg}`);
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
      onActivate: (value) => applySubagentAction(store, ui, value, show),
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

function notify(
  store: HarnessStore,
  message: string,
  level: "success" | "info" | "warn" | "error" = "success",
): void {
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
