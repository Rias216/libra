/**
 * Slash-command catalog — names, params, and interactive pickers.
 */

import { listThemes } from "../tui/theme.js";
import { FONT_PROFILES } from "../tui/font.js";
import { PROVIDERS } from "../auth/types.js";
import {
  CUSTOM_REASONING_OPTIONS,
  PROVIDER_EFFORT_OPTIONS,
} from "../agent/config.js";

export interface SlashParamValue {
  value: string;
  description?: string;
}

export interface SlashParam {
  name: string;
  description?: string;
  values?: SlashParamValue[];
  freeform?: boolean;
}

export interface SlashCommand {
  name: string;
  aliases?: string[];
  description: string;
  params?: SlashParam[];
  picker?: "select" | "toggle";
}

export const THEME_VALUES: SlashParamValue[] = listThemes().map((t) => ({
  value: t.name,
  description: t.description ?? t.displayName,
}));

export const FONT_VALUES: SlashParamValue[] = FONT_PROFILES.map((f) => ({
  value: f.name,
  description: f.description,
}));

export const PROVIDER_VALUES: SlashParamValue[] = PROVIDERS.map((p) => ({
  value: p.id,
  description: p.description,
}));

/** Populated dynamically after model fetch — kept empty for static catalog. */
export const MODEL_VALUES: SlashParamValue[] = [];

export const ON_OFF: SlashParamValue[] = [
  { value: "on", description: "Enable" },
  { value: "off", description: "Disable" },
];

export const REASONING_EFFORT_VALUES: SlashParamValue[] =
  PROVIDER_EFFORT_OPTIONS.map((o) => ({
    value: o.value,
    description: o.description,
  }));

export const CUSTOM_REASONING_VALUES: SlashParamValue[] =
  CUSTOM_REASONING_OPTIONS.map((o) => ({
    value: o.value,
    description: o.description,
  }));

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: "help",
    aliases: ["h", "?"],
    description: "Show help",
  },
  {
    name: "theme",
    aliases: ["t"],
    description: "Theme picker with live preview",
    picker: "select",
    params: [
      {
        name: "name",
        description: "Theme id",
        values: THEME_VALUES,
      },
    ],
  },
  {
    name: "font",
    aliases: ["f"],
    description: "UI font / glyph profile",
    picker: "select",
    params: [
      {
        name: "name",
        description: "Font profile",
        values: FONT_VALUES,
      },
    ],
  },
  {
    name: "model",
    aliases: ["m"],
    description: "Pick a model from all connected providers (live fetch)",
    picker: "select",
    params: [
      {
        name: "id",
        description: "provider/model or model id",
        freeform: true,
      },
    ],
  },
  {
    name: "reasoning",
    aliases: ["reason"],
    description: "Effort + custom modes (ultra, ultra-fusion multi-model)",
    picker: "select",
    params: [
      {
        name: "mode",
        description: "effort or custom mode",
        values: [
          ...REASONING_EFFORT_VALUES,
          ...CUSTOM_REASONING_VALUES,
        ],
      },
    ],
  },
  {
    name: "subagent",
    aliases: ["subagents", "agents"],
    description: "Configure subagents (roles, concurrency, auto-spawn)",
    picker: "select",
  },
  {
    name: "login",
    aliases: ["auth", "connect"],
    description: "Connect a provider API key (multi-login supported)",
    picker: "select",
    params: [
      {
        name: "provider",
        description: "Provider id",
        values: PROVIDER_VALUES,
      },
    ],
  },
  {
    name: "logout",
    description: "Remove stored credentials",
    params: [
      {
        name: "provider",
        description: "Provider id",
        values: PROVIDER_VALUES,
      },
    ],
  },
  {
    name: "verify",
    aliases: ["check"],
    description: "Verify credentials + list models live",
    params: [
      {
        name: "provider",
        description: "Optional provider id (default: all connected)",
        values: PROVIDER_VALUES,
      },
    ],
  },
  {
    name: "whoami",
    aliases: ["status"],
    description: "Show connected providers and active model",
  },
  {
    name: "thinking",
    description: "Show or hide reasoning blocks",
    picker: "toggle",
    params: [
      {
        name: "mode",
        description: "Visibility",
        values: ON_OFF,
      },
    ],
  },
  {
    name: "details",
    description: "Expand or collapse tool results",
    picker: "toggle",
    params: [
      {
        name: "mode",
        description: "Detail level",
        values: ON_OFF,
      },
    ],
  },
  {
    name: "compact",
    description: "Dense or comfortable layout",
    picker: "toggle",
    params: [
      {
        name: "mode",
        description: "Layout density",
        values: ON_OFF,
      },
    ],
  },
  {
    name: "clear",
    aliases: ["new"],
    description: "Reset the session",
  },
  {
    name: "quit",
    aliases: ["exit", "q"],
    description: "Exit Libra",
  },
];

export function getSlashCommand(name: string): SlashCommand | undefined {
  const n = name.toLowerCase().replace(/^\/+/, "");
  return SLASH_COMMANDS.find(
    (c) => c.name === n || c.aliases?.includes(n),
  );
}

export function paramHint(cmd: SlashCommand): string {
  if (!cmd.params?.length) return "";
  return cmd.params.map((p) => `<${p.name}>`).join(" ");
}
