Implement extended tool support in this Libra harness (`src/toolcalling/*`, `src/agent/*`, `src/llm/client.ts`, `src/tui/*`). Work through the phases below in order. Every "simple" tool = six-file recipe: `src/toolcalling/schema.ts` (OpenAITool entry), `registry.ts` (ENTRIES: toolset/risk/aliases), `permissions.ts` (DEFAULT_PERMISSIONS), `tool.ts` (PARALLEL_SAFE/EXCLUSIVE + aliases), `normalize.ts` (canonicalToolName, keep in sync with tool.ts), `executor.ts` (dispatch() case + formatText() case). Any tool whose result isn't a plain string (images) or that needs its own state/runtime uses the custom-tool pattern instead: `isCustomTool`/`customDispatch` in `agent/turn.ts` (~line 1129), routed through `toolcalling/runtime.ts`'s `RuntimeHandlers`, with its own `<tool>/runtime.ts` module (template: `agent/subagent/runtime.ts` + `agent/subagent/tools.ts`).

**Phase 0 — multimodal wire format (blocks every visual tool below, do this first)**
- Widen `ChatMessage.content` in `src/llm/client.ts` from `string | null` to `string | null | ChatContentPart[]`, `ChatContentPart = {type:"text",text} | {type:"image",mimeType,data /*base64*/}`.
- In the same file, update OpenAI-compatible / Anthropic / Gemini request serialization to emit each provider's image block (`image_url` / `{type:"image",source:{type:"base64",...}}` / `inlineData`). Add converters in `src/toolcalling/compat.ts` alongside the existing `toAnthropicTools`/`toGeminiFunctionDeclarations`.
- Update the two places that build tool-result messages — `agent/history.ts:126` and `agent/turn.ts:652` — to emit a content-block array when a tool result carries an image.
- Widen `RuntimeHandlers.customDispatch`'s return type in `toolcalling/runtime.ts` the same way (`output: string | ChatContentPart[]`).
- Gate on model vision support (check via `src/auth/models.ts`); non-vision models get a text fallback: "screenshot saved to `<path>`, model has no vision input."

**Phase 1 — `list_windows`** (six-file recipe, new toolset `"vision"`, risk `read`)
- Enumerate visible windows → `{pid, title, processName, bounds}[]`. Windows: `EnumWindows`/`GetWindowThreadProcessId`. macOS: System Events `windows of processes`. Linux: `wmctrl -lp` / `xdotool search --name .`.

**Phase 2 — `screenshot`** (custom-tool pattern; result carries an image)
- Params: `session_id?` (from the existing `process.ts` background-session registry — `getSession(id).pid`), `pid?`, `url?` (+`selector?`, `full_page?`), `engine?: "cdp"|"playwright"`, `full_screen?` (default false, explicit opt-in only).
- Native per-window capture by pid, no third-party lib: Windows → `PrintWindow` via inline P/Invoke PowerShell (next to `shell-win.ts`); macOS → `osascript` window bounds + `screencapture -R$x,$y,$w,$h`; Linux X11 → `xdotool search --pid` + `import -window`/`maim -i`; Wayland → `grim -g "$(slurp)"` best-effort, say so explicitly.
- Browser targets default to raw CDP: launch/reuse with `--remote-debugging-port`, `GET /json` to list targets, `WebSocket` to `webSocketDebuggerUrl`, `Page.captureScreenshot`. Zero new deps (Bun/Node ship `WebSocket`).
- `engine:"playwright"` = optional dev dependency (`bun add -D playwright`, dynamic `import("playwright")`, feature-detect + clear error if not installed) for `full_page`, `selector`-scoped element capture, or when no browser is already running.
- Never capture beyond the resolved target unless `full_screen=true`. Save to `.libra/screenshots/<ts>.png`. Return image content block (Phase 0) + short text summary. Permissions: `allow` for session_id/pid/url-scoped, `ask` for `full_screen=true`.

**Phase 3 — `read_image`** (six-file recipe, uses Phase 0 plumbing)
- Read an existing image file from the workspace, return as an image content block (today `read_file` explicitly rejects binaries in `executor.ts`).

**Phase 4 — `browser_devtools`** (custom-tool pattern, raw CDP, no Playwright)
- One tool, `action: "goto"|"click"|"fill"|"screenshot"|"console_log"|"eval"`, same action-multiplexing shape as the existing `process` tool. Always scoped to one `targetId` (tab) from the same CDP connection as Phase 2.

**Phase 5 — `check`** (six-file recipe)
- Run `tsc --noEmit --pretty false` (+ eslint if configured) via `node:child_process`, parse into `{file,line,col,severity,code,message}[]` JSON instead of raw shell text.

**Phase 6 — `git`** (six-file recipe)
- `action: "status"|"diff"|"log"|"blame"`, structured output; parse diffs into `DiffHunk`/`DiffLine` (`core/types.ts`) so results can render via the existing `DiffPart` UI (`tui/components/parts.ts`).

**Phase 7 — `format` hook** (not a callable tool)
- `ToolRegistry.addHook()` after-hook on `write`/`search_replace`/`patch_apply` → run prettier/biome on the touched path automatically.

**Phase 8 — `patch_apply`** (six-file recipe, risk `write`)
- Parse unified-diff hunks (`@@ -l,c +l,c @@`, hand-rolled parser), apply per file via `write()`'s internals in `executor.ts`, fail loudly (don't silently mis-apply) if hunk context doesn't match current file content. Feed successful diffs into the same `DiffPart` path as Phase 6.

**Phase 9 — small utilities** (six-file recipe each)
- `wait_for_port` — poll `127.0.0.1:<port>` until open or timeout; use before Phase 2/4 target a freshly-started dev server.
- `clipboard_read` — `pbpaste` / `Get-Clipboard` (next to `shell-win.ts`) / `xclip -o`\`wl-paste`. Companion to the existing OSC-52 clipboard *write* in `tui/clipboard.ts`.
- `find_symbol` — TypeScript Language Service or `ts-morph`: go-to-definition, find-references, find-implementations by symbol name.

**Guardrails**
- No tool captures more than its explicitly resolved target (one window, one tab, one page) unless `full_screen=true` is explicitly passed.
- Playwright is the only new required-at-runtime dependency anywhere in this plan, and it must stay optional/dynamically-imported — the native + CDP paths must work with zero extra installs.
- Every new tool gets a `DEFAULT_PERMISSIONS` entry; default `ask` (not `allow`) for anything touching the user's whole screen or data outside the agent's own workspace/process.
- Don't stop to ask for confirmation between phases unless something is genuinely ambiguous (e.g. no `run_terminal_command` pattern to follow for a given OS-specific command).

**Later, not in this pass (only if the core loop above proves it's needed):** `api_probe`, `stack_trace_resolve`, `coverage`, `test_impact`, `db_query`, `env_check`, MCP client bridge, `screendiff`, `secrets_scan`, `notify`, `changelog_draft`, `package_search`.