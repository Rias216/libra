/**
 * Slash-command catalog — names, params, and interactive pickers.
 */

import { listThemes } from "../tui/theme.js";
import { FONT_PROFILES } from "../tui/font.js";
import { PROVIDERS } from "../auth/types.js";
import { CUSTOM_REASONING_OPTIONS } from "../agent/config.js";

export interface SlashParamValue {
  /** Inserted into the prompt / accepted by the command handler */
  value: string;
  /** Display label in the suggestion popup (defaults to value) */
  label?: string;
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
  label: t.displayName,
  description: t.description ?? t.displayName,
}));

export const FONT_VALUES: SlashParamValue[] = FONT_PROFILES.map((f) => ({
  value: f.name,
  label: f.displayName,
  description: f.description,
}));

export const PROVIDER_VALUES: SlashParamValue[] = PROVIDERS.map((p) => ({
  value: p.id,
  label: p.name,
  description: p.description,
}));

/** Populated dynamically after model fetch — kept empty for static catalog. */
export const MODEL_VALUES: SlashParamValue[] = [];

export const ON_OFF: SlashParamValue[] = [
  { value: "on", label: "On", description: "Enable" },
  { value: "off", label: "Off", description: "Disable" },
];

/** Static harness modes only — effort enums come from live model caps. */
export const CUSTOM_REASONING_VALUES: SlashParamValue[] =
  CUSTOM_REASONING_OPTIONS.map((o) => ({
    value: o.value,
    label: o.label,
    description: o.description,
  }));

/** Matches /subagent picker rows (insertable args). */
export const SUBAGENT_ACTION_VALUES: SlashParamValue[] = [
  { value: "on", label: "Enabled on", description: "Turn subagents on" },
  { value: "off", label: "Enabled off", description: "Turn subagents off" },
  {
    value: "toggle",
    label: "Enabled",
    description: "Toggle subagents on/off",
  },
  {
    value: "auto",
    label: "Auto-spawn",
    description: "Toggle auto-spawn for complex tasks",
  },
  {
    value: "max",
    label: "Max concurrent",
    description: "Cycle max concurrent subagents",
  },
  {
    value: "roles",
    label: "Roles",
    description: "Edit subagent roles",
  },
  {
    value: "model",
    label: "Preferred model",
    description: "Pick preferred subagent model",
  },
  {
    value: "reset",
    label: "Reset defaults",
    description: "Restore default roles and limits",
  },
];

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
    description:
      "Per-model API efforts (live catalog) + ultra / ultra-fusion",
    picker: "select",
    params: [
      {
        name: "mode",
        description:
          "effort from active model catalog, or ultra / ultra-fusion",
        // Values filled dynamically in complete engine from supported_efforts
        freeform: true,
        values: [],
      },
    ],
  },
  {
    name: "subagent",
    aliases: ["subagents", "agents"],
    description: "Configure subagents (roles, concurrency, auto-spawn)",
    picker: "select",
    params: [
      {
        name: "action",
        description: "Menu action (same as the subagent tab)",
        values: SUBAGENT_ACTION_VALUES,
      },
    ],
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
    name: "self-review",
    aliases: ["selfreview", "self-upgrade", "upgrade-self", "evolve"],
    description:
      "Mine .libe sessions for friction, backup sources, self-upgrade with active model",
    picker: "select",
    params: [
      {
        name: "action",
        description:
          "go | sessions | list | restore | status | or free-form focus text",
        freeform: true,
        values: [
          {
            value: "go",
            label: "Start now",
            description: "Mine sessions + backup + run (no confirm)",
          },
          {
            value: "sessions",
            label: "Sessions + friction",
            description: "List ~/.libra/sessions/*.libe and error signals",
          },
          {
            value: "list",
            label: "List source backups",
            description: "Self-review code snapshots",
          },
          {
            value: "restore",
            label: "Restore source",
            description: "Restore a previous code backup",
          },
          {
            value: "status",
            label: "Status",
            description: "Root, sessions, friction, backups",
          },
        ],
      },
    ],
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
