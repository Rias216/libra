/**
 * Tool arg normalization + fingerprinting for cache / dedupe.
 * Supports both Libra-native names and Fusion catalog aliases.
 */

import { parseToolArgumentsLoose } from "./compat.js";

/**
 * Strip pasted read_file line-number prefixes (`N→` or padded `N|`) so
 * models that copy numbered read output into search_replace still match file text.
 * Only strips when the line matches the numbered-read pattern; plain content is unchanged.
 */
export function stripLineNumberPrefixes(text: string): string {
  if (!text || typeof text !== "string") return text;
  // Match Grok-style `12→` and legacy Libra `  12|` prefixes at line start
  const re = /^(\d+)(→|\|)/;
  const lines = text.split("\n");
  let any = false;
  const out = lines.map((line) => {
    // Preserve CRLF content: only strip from start of logical line
    const m = line.match(re);
    if (!m) return line;
    any = true;
    return line.slice(m[0].length);
  });
  return any ? out.join("\n") : text;
}

/** Stable JSON with sorted keys (for fingerprints). */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableJson(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(",")}}`;
}

/**
 * Canonical tool names (Libra internal). Catalog aliases map here for
 * fingerprinting so `write` and `write_file` share cache keys when args match.
 */
export function canonicalToolName(name: string): string {
  // Lazy import avoided — keep alias table here in sync with tool.ts TOOL_ALIASES
  switch (name) {
    case "write_file":
    case "Write":
      return "write";
    case "edit_file":
    case "edit":
    case "Edit":
    case "str_replace":
      return "search_replace";
    case "run_shell":
    case "bash":
    case "shell":
    case "Shell":
    case "local_shell":
      return "run_terminal_command";
    case "read":
    case "Read":
      return "read_file";
    case "ls":
    case "list":
      return "list_dir";
    case "Grep":
      return "grep";
    case "Glob":
      return "glob";
    case "websearch":
      return "web_search";
    case "webfetch":
      return "web_fetch";
    case "todowrite":
      return "todo_write";
    default:
      return name;
  }
}

/**
 * Fill defaults / normalize paths and catalog ↔ native arg aliases so
 * `{}` and `{target_directory:"."}` / `{path:"."}` hash the same for list_dir.
 */
export function normalizeToolArgs(
  name: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...args };
  // Drop undefined / empty-string noise
  for (const k of Object.keys(out)) {
    if (out[k] === undefined || out[k] === "") delete out[k];
  }

  const canon = canonicalToolName(name);

  // Catalog path aliases → native field names (and vice versa for catalog)
  // Use canon so OpenCode/Codex aliases (read, bash, …) normalize the same.
  switch (canon) {
    case "list_dir": {
      if (out.path != null && out.target_directory == null) {
        out.target_directory = out.path;
        delete out.path;
      }
      break;
    }
    case "read_file": {
      if (out.path != null && out.target_file == null && out.target_files == null) {
        out.target_file = out.path;
        delete out.path;
      }
      // paths: ["a","b"] → target_files
      if (Array.isArray(out.paths) && out.target_files == null) {
        out.target_files = out.paths;
        delete out.paths;
      }
      // files alias
      if (Array.isArray(out.files) && out.target_files == null) {
        out.target_files = out.files;
        delete out.files;
      }
      break;
    }
    case "write": {
      if (out.path != null && out.file_path == null) {
        out.file_path = out.path;
        delete out.path;
      }
      break;
    }
    case "search_replace": {
      if (out.path != null && out.file_path == null) {
        out.file_path = out.path;
        delete out.path;
      }
      break;
    }
    case "run_terminal_command": {
      // Catalog / models often pass timeout or timeout_s instead of timeout_ms
      if (out.timeout_s != null && out.timeout_ms == null) {
        const s = Number(out.timeout_s);
        if (Number.isFinite(s)) out.timeout_ms = Math.round(s * 1000);
        delete out.timeout_s;
      }
      if (out.timeout != null && out.timeout_ms == null) {
        const t = Number(out.timeout);
        if (Number.isFinite(t)) {
          // Heuristic: values ≤ 600 look like seconds; larger are ms
          out.timeout_ms = t > 0 && t <= 600 ? Math.round(t * 1000) : Math.round(t);
        }
        delete out.timeout;
      }
      break;
    }
    default:
      break;
  }

  switch (canon) {
    case "list_dir": {
      const d = out.target_directory;
      if (d == null || d === "" || d === "./" || d === ".\\") {
        out.target_directory = ".";
      } else if (typeof d === "string") {
        out.target_directory =
          d.replace(/\\/g, "/").replace(/\/+$/, "") || ".";
      }
      break;
    }
    case "read_file": {
      if (typeof out.target_file === "string") {
        out.target_file = out.target_file.replace(/\\/g, "/");
      }
      // Normalize batch paths: slash, drop empties, sort for stable fingerprint
      if (Array.isArray(out.target_files)) {
        const files = (out.target_files as unknown[])
          .map((p) => String(p ?? "").replace(/\\/g, "/").trim())
          .filter(Boolean);
        // If only one entry, collapse to single-file form
        if (files.length === 1 && out.target_file == null) {
          out.target_file = files[0];
          delete out.target_files;
        } else if (files.length > 1) {
          out.target_files = [...files].sort();
          // Batch ignores single-file range args (ambiguous across files)
          delete out.offset;
          delete out.limit;
          delete out.target_file;
        } else {
          delete out.target_files;
        }
      }
      break;
    }
    case "write": {
      if (typeof out.file_path === "string") {
        out.file_path = out.file_path.replace(/\\/g, "/");
      }
      break;
    }
    case "search_replace": {
      if (typeof out.file_path === "string") {
        out.file_path = out.file_path.replace(/\\/g, "/");
      }
      // Models often paste numbered read_file output into old/new_string
      if (typeof out.old_string === "string") {
        out.old_string = stripLineNumberPrefixes(out.old_string);
      }
      if (typeof out.new_string === "string") {
        out.new_string = stripLineNumberPrefixes(out.new_string);
      }
      break;
    }
    case "grep": {
      if (out.path == null || out.path === "") out.path = ".";
      if (typeof out.path === "string") {
        out.path = out.path.replace(/\\/g, "/");
      }
      break;
    }
    case "glob": {
      if (typeof out.pattern === "string") {
        out.pattern = out.pattern.replace(/\\/g, "/");
      }
      break;
    }
    case "run_terminal_command": {
      if (out.timeout_ms == null) out.timeout_ms = 30_000;
      break;
    }
    case "calc": {
      if (typeof out.expression === "string") {
        // Trim only; preserve expression for hard checks that want exact match
        out.expression = out.expression.trim();
      }
      break;
    }
    default:
      break;
  }
  return out;
}

/** Cache key for a tool invocation. */
export function toolFingerprint(
  name: string,
  args: Record<string, unknown>,
): string {
  const n = normalizeToolArgs(name, args);
  return `${canonicalToolName(name)}:${stableJson(n)}`;
}

/** Parse tool arguments JSON with multi-model repair (see toolcalling/compat). */
export function parseToolArgs(raw: string | undefined): Record<string, unknown> {
  return parseToolArgumentsLoose(raw);
}
