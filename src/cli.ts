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
  PROVIDER_EFFORT_OPTIONS,
  saveAgentSettings,
  type CustomReasoningMode,
  type ProviderReasoningEffort,
} from "./agent/config.js";
import { runFusionReasoning } from "./agent/fusion.js";

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
          `- Reasoning: effort=\`${agentCfg.reasoning.effort}\` custom=\`${agentCfg.reasoning.custom}\`` +
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
              "- `/login [provider]` — connect API keys; stay logged into many at once\n" +
              "- `/model` — pick any model from **all** connected providers (fetched live)\n" +
              "- `/reasoning` — provider effort + Libra custom modes\n" +
              "- `/subagent` — deep subagent config\n" +
              "- `/verify [provider]` — live model list proves the key\n" +
              "- `/theme` `/font` `/whoami` `/logout`\n\n" +
              "### Custom reasoning ladder\n\n" +
              "- **deep** — strongest model, long plan\n" +
              "- **swarm** — multi-agent on demand\n" +
              "- **ultra** — max effort + auto subagents\n" +
              "- **ultra-fusion** — REASONING ONLY: run your chosen models side-by-side, analyze, fuse best result\n\n" +
              "Fusion model list is configured under `/reasoning` → Ultra + Fusion → models.",
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
        lines.push(
          `- **${c.provider}** (${c.method}) ${c.label ?? ""}  token ${maskSecret(c.token)}`,
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
              `\n**Reasoning effort:** \`${agentCfg.reasoning.effort}\`` +
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
    ui.openPicker({
      title: "xAI (Grok) — API key",
      options: [
        {
          value: "paste",
          label: "Paste API key",
          description: "Key from console.x.ai (xai-...)",
        },
        {
          value: "browser",
          label: "Open console + paste key",
          description: "Opens console.x.ai API keys page",
        },
      ],
      onSelect: (method) => {
        if (method === "browser") openBrowser(XAI_CONSOLE_URL);
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
  const { models, errors } = await fetchAllConnectedModels({ force: true });

  if (models.length === 0) {
    const errText = Object.entries(errors)
      .map(([p, e]) => `${p}: ${e}`)
      .join("; ");
    notify(store, `no models: ${errText || "empty"}`, "error");
    return;
  }

  const errNote = Object.keys(errors).length
    ? `  (! ${Object.keys(errors).join(",")})`
    : "";

  const currentKey =
    loadConfig().modelKey ??
    modelKey({
      provider: store.state.session.provider as ProviderId,
      model: store.state.session.model,
    });

  ui.openPicker({
    title: `Models  (${models.length} from ${connected.length} providers)${errNote}`,
    current: currentKey,
    options: models.map((m) => ({
      value: modelKey({ provider: m.provider, model: m.id }),
      label: m.id,
      description: `${m.provider}${m.reasoning ? "  reasoning" : ""}${m.description ? "  " + m.description : ""}`,
    })),
    onSelect: (value) => {
      const ref = parseModelKey(value);
      if (!ref) return;
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
  const cur = loadAgentSettings();

  if (arg) {
    const effort = PROVIDER_EFFORT_OPTIONS.find((o) => o.value === arg);
    const custom = CUSTOM_REASONING_OPTIONS.find((o) => o.value === arg);
    if (effort) {
      saveAgentSettings({ reasoning: { effort: effort.value } });
      notify(store, `reasoning effort → ${effort.value}`);
      return;
    }
    if (custom) {
      applyCustomReasoning(store, ui, custom.value);
      return;
    }
    notify(store, `unknown reasoning mode: ${arg}`, "warn");
    return;
  }

  ui.openPicker({
    title: "Reasoning",
    options: [
      {
        value: "menu:effort",
        label: "Provider effort",
        description: `current: ${cur.reasoning.effort}  (API thinking budget)`,
      },
      {
        value: "menu:custom",
        label: "Libra custom mode",
        description: `current: ${cur.reasoning.custom}`,
      },
      {
        value: "menu:fusion",
        label: "Ultra + Fusion setup",
        description:
          cur.reasoning.custom === "ultra-fusion"
            ? `${cur.reasoning.fusion.modelKeys.length || "auto"} models · REASONING ONLY`
            : "Select models, judge, instructions (activates ultra-fusion)",
      },
      {
        value: "menu:instructions",
        label: "Custom instructions",
        description: cur.reasoning.customInstructions
          ? truncate(cur.reasoning.customInstructions, 40)
          : "(empty)",
      },
    ],
    onSelect: (value) => {
      if (value === "menu:effort") {
        ui.openPicker({
          title: "Provider reasoning effort",
          current: cur.reasoning.effort,
          options: PROVIDER_EFFORT_OPTIONS.map((o) => ({
            value: o.value,
            label: o.label,
            description: o.description,
          })),
          onSelect: (v) => {
            saveAgentSettings({
              reasoning: { effort: v as ProviderReasoningEffort },
            });
            notify(store, `reasoning effort → ${v}`);
          },
        });
      } else if (value === "menu:custom") {
        ui.openPicker({
          title: "Libra custom reasoning  (not provider-native)",
          current: cur.reasoning.custom,
          options: CUSTOM_REASONING_OPTIONS.map((o) => ({
            value: o.value,
            label: o.label,
            description: o.description,
          })),
          onSelect: (v) => {
            applyCustomReasoning(store, ui, v as CustomReasoningMode);
          },
        });
      } else if (value === "menu:fusion") {
        saveAgentSettings({ reasoning: { custom: "ultra-fusion" } });
        openFusionConfig(store, ui);
      } else if (value === "menu:instructions") {
        ui.openModalInput({
          title: "Custom reasoning instructions",
          lines: [
            "Injected for deep/swarm/ultra/ultra-fusion",
            "Fusion also has separate analysis/fuse instruction fields",
          ],
          placeholder: cur.reasoning.customInstructions || "instructions...",
          onSubmit: (text) => {
            saveAgentSettings({
              reasoning: { customInstructions: text.trim() },
            });
            ui.dismissModal();
            notify(store, "custom reasoning instructions saved");
          },
        });
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
  let msg = `custom reasoning → ${mode}`;
  if (mode === "ultra" || mode === "ultra-fusion") {
    msg +=
      mode === "ultra-fusion"
        ? "  (REASONING ONLY multi-model fuse)"
        : "  (max effort + auto subagents)";
    void fetchAllConnectedModels({ force: false }).then(({ models }) => {
      const best = pickHighestReasoningModel(models);
      if (best) {
        applyModel(store, best.provider, best.id);
        const a = loadAgentSettings();
        saveAgentSettings({
          subagents: {
            ...a.subagents,
            preferredModelKey: modelKey({
              provider: best.provider,
              model: best.id,
            }),
          },
        });
      }
    });
  }
  notify(store, msg);
  if (mode === "ultra-fusion") {
    openFusionConfig(store, ui);
  }
}

/** Configure fusion roster + judge (reasoning-only multi-model). */
function openFusionConfig(store: HarnessStore, ui: TuiRenderer): void {
  const cur = loadAgentSettings().reasoning.fusion;
  ui.openPicker({
    title: "Ultra + Fusion  (reasoning only)",
    options: [
      {
        value: "models",
        label: "Select models",
        description:
          cur.modelKeys.length > 0
            ? `${cur.modelKeys.length} selected`
            : "auto-pick top reasoning models across providers",
      },
      {
        value: "judge",
        label: "Judge / fuse model",
        description: cur.judgeModelKey ?? "(highest reasoning)",
      },
      {
        value: "parallel",
        label: `Max parallel: ${cur.maxParallel}`,
        description: "Side-by-side streams",
      },
      {
        value: "analysis",
        label: "Analysis instructions",
        description: truncate(cur.analysisInstructions, 40),
      },
      {
        value: "fuse",
        label: "Fuse instructions",
        description: truncate(cur.fuseInstructions, 40),
      },
      {
        value: "done",
        label: "Done",
        description: "Keep ultra-fusion active",
      },
    ],
    onSelect: (value) => {
      if (value === "done") return;
      if (value === "models") {
        void openFusionModelMultiSelect(store, ui);
        return;
      }
      if (value === "judge") {
        void openFusionJudgePicker(store, ui);
        return;
      }
      if (value === "parallel") {
        ui.openPicker({
          title: "Max parallel fusion models",
          current: String(cur.maxParallel),
          options: [2, 3, 4, 5, 6].map((n) => ({
            value: String(n),
            label: String(n),
            description: n === 4 ? "default" : "",
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
        const field = value === "analysis" ? "analysisInstructions" : "fuseInstructions";
        const live = loadAgentSettings().reasoning.fusion;
        ui.openModalInput({
          title: field === "analysisInstructions" ? "Analysis instructions" : "Fuse instructions",
          lines: [
            "REASONING ONLY — models must not claim tool use or file edits",
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
    ui.openPicker({
      title: `Fusion models  (${selected.size} selected, min ${fusion.minModels})`,
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
            label: `${on ? "*" : " "} ${m.id}`,
            description: `${m.provider}${m.reasoning ? "  reasoning" : ""}`,
          };
        }),
      ],
      onSelect: (value) => {
        if (value === "__done__") {
          const n = loadAgentSettings().reasoning.fusion.modelKeys.length;
          notify(
            store,
            n >= 2
              ? `fusion roster: ${n} models`
              : "fusion roster empty — will auto-pick at runtime",
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
      },
    });
  };
  show();
}

async function openFusionJudgePicker(
  store: HarnessStore,
  ui: TuiRenderer,
): Promise<void> {
  const { models } = await fetchAllConnectedModels({ force: false });
  const fusion = loadAgentSettings().reasoning.fusion;
  ui.openPicker({
    title: "Fusion judge model",
    current: fusion.judgeModelKey,
    options: [
      {
        value: "",
        label: "(auto) highest reasoning",
        description: "Pick strongest available at run time",
      },
      ...models.map((m) => ({
        value: modelKey({ provider: m.provider, model: m.id }),
        label: m.id,
        description: m.provider,
      })),
    ],
    onSelect: (value) => {
      saveAgentSettings({
        reasoning: {
          fusion: {
            ...loadAgentSettings().reasoning.fusion,
            judgeModelKey: value || undefined,
          },
        },
      });
      notify(store, value ? `fusion judge → ${value}` : "fusion judge → auto");
      openFusionConfig(store, ui);
    },
  });
}

/** Route: fusion → live agent (if auth+model) → mock demo. */
async function handleUserSubmit(
  text: string,
  store: HarnessStore,
  mock: MockAgent,
  live: AgentLoop,
): Promise<void> {
  const mode = loadAgentSettings().reasoning.custom;
  if (mode === "ultra-fusion") {
    store.appendUser(text);
    try {
      await runFusionReasoning(store, text);
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

  const provider = store.state.session.provider as ProviderId;
  const model = store.state.session.model;
  const hasAuth =
    Boolean(getProvider(provider) && resolveToken(provider)) &&
    model &&
    model !== "unset" &&
    model !== "libra-mock" &&
    model !== "libra-demo";

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

  ui.openPicker({
    title: "Subagents",
    options: [
      {
        value: "toggle",
        label: cfg.subagents.enabled ? "Disable" : "Enable",
        description: `currently ${cfg.subagents.enabled ? "on" : "off"}`,
      },
      {
        value: "auto",
        label: "Auto-spawn",
        description: cfg.subagents.autoSpawn
          ? "ON — spawn on complex tasks (ultra forces this)"
          : "OFF — only when explicitly delegated",
      },
      {
        value: "max",
        label: `Max concurrent: ${cfg.subagents.maxConcurrent}`,
        description: "Parallel child agents",
      },
      {
        value: "roles",
        label: "Roles",
        description: `${cfg.subagents.roles.filter((r) => r.enabled).length}/${cfg.subagents.roles.length} enabled`,
      },
      {
        value: "model",
        label: "Preferred model",
        description:
          cfg.subagents.preferredModelKey ??
          "(highest reasoning among connected)",
      },
      {
        value: "reset",
        label: "Reset defaults",
        description: "Restore default roles and limits",
      },
    ],
    onSelect: (value) => {
      const live = loadAgentSettings();
      if (value === "toggle") {
        saveAgentSettings({
          subagents: { ...live.subagents, enabled: !live.subagents.enabled },
        });
        notify(
          store,
          `subagents ${!live.subagents.enabled ? "enabled" : "disabled"}`,
        );
      } else if (value === "auto") {
        saveAgentSettings({
          subagents: {
            ...live.subagents,
            autoSpawn: !live.subagents.autoSpawn,
            enabled: true,
          },
        });
        notify(
          store,
          `auto-spawn ${!live.subagents.autoSpawn ? "on" : "off"}`,
        );
      } else if (value === "max") {
        ui.openPicker({
          title: "Max concurrent subagents",
          current: String(live.subagents.maxConcurrent),
          options: [1, 2, 3, 4, 6, 8].map((n) => ({
            value: String(n),
            label: String(n),
            description: n === 4 ? "default" : "",
          })),
          onSelect: (v) => {
            saveAgentSettings({
              subagents: {
                ...loadAgentSettings().subagents,
                maxConcurrent: Number(v),
              },
            });
            notify(store, `max concurrent → ${v}`);
          },
        });
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
      }
    },
  });
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
