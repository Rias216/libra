# Libra

**Custom TUI renderer for an AI coding harness** — design language inspired by [OpenCode](https://opencode.ai) and [Grok CLI](https://x.ai/cli).

Libra is the *presentation layer* of an agent harness: it paints streaming tokens, tool cards, reasoning blocks, and diffs at interactive frame rates, while staying completely decoupled from LLM / tool execution.

```
┌─ ◆ libra   demo session              local/libra-mock ─┐
│ cwd/path/to/project                                    │
├────────────────────────────────────────────────────────┤
│ ◆ libra                                                │
│ Welcome to **Libra** …                                 │
│                                                        │
│ ❯ you                                                  │
│ sketch a TUI renderer                                  │
│                                                        │
│ ◆ libra                                                │
│ ◈ thought                                              │
│ │ The user wants a custom TUI…                         │
│ ✓ list_dir  .                               400ms      │
│ ⠋ read_file  package.json                              │
│ ▣ src/tui/chrome.ts  +3 -1                             │
│   +  const hint = focus === "prompt"                   │
├────────────────────────────────────────────────────────┤
│ ❯ Message libra…                                       │
│ ready  ·  1.1k tok  ·  PROMPT    enter send · /help    │
└────────────────────────────────────────────────────────┘
```

## Quick start

Requires [Bun](https://bun.sh) ≥ 1.1 and TypeScript **7** (native compiler).

```bash
bun install
bun run dev
```

Type any message and press **Enter** — a mock agent streams a full turn (reasoning → tools → markdown → diff) so you can evaluate the renderer without API keys.

| Script | What it does |
|--------|----------------|
| `bun run dev` | Run CLI from TypeScript source |
| `bun run typecheck` | Native TypeScript 7 check (`tsc --noEmit`) |
| `bun run build` | Emit `dist/` (JS + `.d.ts`) for packaging |
| `bun run test` | Harness + web tool tests |
| `bun run compile` | Single native-ish binary via `bun build --compile` |

### Install as a global `libra` command (PowerShell / any folder)

From the repo root (once):

```powershell
bun install
bun run link
```

That builds the CLI and puts `libra` on your PATH via Bun’s global link.

Then from **any** project directory:

```powershell
cd C:\path\to\your\project
libra
libra --theme=tokyo-night
libra --version
```

Update after pulling code:

```powershell
cd C:\Users\rias\Desktop\libra
bun run link
```

Remove the global command:

```powershell
bun run unlink
```

## Architecture

Inspired by OpenCode’s client/server split and Grok’s scrollback model:

| Layer | Role |
|-------|------|
| **`HarnessStore`** | Single source of truth; reduces events → state |
| **`EventBus`** | Fine-grained push (`text.delta`, `tool.status`, …) |
| **`TuiRenderer`** | Alt-screen frame loop, input, layout |
| **`FrameBuffer`** | Cell grid + dirty-line ANSI diff (OpenTUI-inspired) |
| **Part renderers** | Polymorphic `text` / `reasoning` / `tool` / `diff` / `file` / `status` |

```
User keystrokes ──► TuiRenderer ──onSubmit──► your agent loop
                         ▲                        │
                         │     events             │
                    setState/paint ◄── HarnessStore ◄── tools / LLM stream
```

### Polymorphic parts (OpenCode-style)

Messages are arrays of typed parts — each has its own paint path:

- **`text`** — markdown (headers, lists, code fences, inline styles) + stream caret
- **`reasoning`** — foldable thinking blocks
- **`tool`** — status pipeline `pending → running → completed | error` with spinner + duration
- **`diff`** — path, `+/-` stats, hunk lines
- **`file`** / **`status`** — attachments and system notices

### Themes (Grok-style)

RGB is the source of truth; colors quantize at paint time to truecolor / 256 / 16 / mono.

| Theme | Notes |
|-------|--------|
| `libra-night` | Default violet accent |
| `libra-day` | Light terminals |
| `tokyo-night` | Truecolor-oriented |

```bash
/theme
/theme libra-day
```

## Embed in your harness

```ts
import { HarnessStore, TuiRenderer, newId } from "libra";

const store = new HarnessStore({
  model: "my-model",
  provider: "openai",
  title: "session",
});

const ui = new TuiRenderer({
  onSubmit: async (userText) => {
    store.appendUser(userText);
    const msg = store.startAssistant();
    store.setPhase("streaming");

    const partId = newId("p");
    store.appendPart(msg.id, {
      id: partId,
      type: "text",
      content: "",
      streaming: true,
    });

    // your streaming LLM callback:
    // onDelta(d) => store.textDelta(msg.id, partId, d)
    // onTool(t)  => store.appendPart / store.toolStatus(...)

    store.patchPart(msg.id, partId, { streaming: false } as never);
    store.setPhase("idle");
  },
  onCommand: (cmd) => {
    if (cmd === "thinking") store.toggle("showThinking");
  },
});

store.subscribe((_event, state) => {
  ui.setState(state);
  ui.paint();
});

ui.setState(store.state);
await ui.start();
```

## Scrollbar

When the conversation is taller than the viewport, a **right-edge scrollbar** shows track (`|`) + thumb (`#`). Status bar shows `top` / `%` / `bot`. Focus scrollback with `Tab`, then `j/k`, `PgUp/PgDn`, or `g`/`G`.

## Autocomplete (`/` and `@` only)

| Trigger | Sources |
|---------|---------|
| `/` | Slash commands |
| `/cmd ` | **Parameters** (e.g. `on`/`off`, theme names) |
| `@` | Workspace files + paths from the session |

| Key | Action |
|-----|--------|
| `Tab` | Fill selected suggestion |
| `up` / `down` | Move selection |
| `Enter` | Run command / send message |
| `Esc` | Dismiss popup |

### Settings pickers

`/thinking`, `/details`, `/compact`, and `/theme` open a **modal picker** when run without args (OpenCode-style). Arrows or `j`/`k` move, Enter applies, Esc cancels — nothing is written into the transcript.

Direct values still work: `/thinking off`, `/theme libra-day`.

## Keys & slash commands

| Input | Action |
|-------|--------|
| `Enter` | Send prompt or run `/` command |
| `Tab` | Complete, or toggle prompt / scrollback |
| `Ctrl+T` | Open thinking picker |
| `Ctrl+L` | Full redraw |
| `Ctrl+C` | Quit |
| `j` / `k` or arrows | Scroll (scrollback focused) |
| `g` / `G` | Top / bottom |
| `/help` | Command list |
| `/theme [name]` | Theme picker or set |
| `/thinking [on\|off]` | Reasoning visibility picker |
| `/details [on\|off]` | Tool detail picker |
| `/compact [on\|off]` | Layout density picker |
| `/clear` | Reset session |
| `/quit` | Exit |

## Project layout

```
src/
  cli.ts                 # interactive demo entry
  index.ts               # public exports
  core/                  # harness state machine
    types.ts             # Message / Part schemas
    events.ts            # EventBus + reduce()
    store.ts             # HarnessStore API
  memory/                # durable + session memory
    history.ts           # prompt history (disk)
    paths.ts             # workspace path index
    session-memory.ts    # tokens from live conversation
  toolcalling/           # tools + demo agent
    tools.ts             # builtin tool registry
    mock-agent.ts        # streaming demo agent
  complete/              # deep autocomplete
    fuzzy.ts             # subsequence / path scoring
    commands.ts          # slash + shell catalogs
    engine.ts            # multi-source complete()
    popup.ts             # suggestion list layout
  tui/
    renderer.ts          # alt-screen app shell
    buffer.ts            # frame buffer + line diff
    scrollbar.ts         # scrollback gutter thumb
    ansi.ts · theme.ts · markdown.ts
    scrollback.ts · prompt.ts · chrome.ts · input.ts
    components/parts.ts
```

## Design references

- **OpenCode** — part polymorphism, tool status machine, UI decoupled from agent loop, frame-diff mindset ([OpenTUI](https://github.com/anomalyco/opentui))
- **Grok CLI** — themed scrollback + prompt chrome, compact mode, thinking folds, semantic color roles, terminal capability detection

## Profiles & per-model system prompts (OpenCode-style)

Routing mirrors OpenCode `system.ts` → prompt packs in `src/agent/prompts/packs.ts`:

| Pack | When |
| --- | --- |
| `anthropic` | Claude |
| `beast` | gpt-4* / o1 / o3 |
| `codex` | *codex* models |
| `gpt` | other GPT |
| `gemini` | Gemini |
| `grok` | xAI / Grok |
| `kimi` | Kimi / Moonshot |
| `default` | fallback |
| `slim` | light turns |

```ts
buildSystemPrompt({ provider: "xai", model: "grok-4.5", cwd });
// → grok pack + env block + optional AGENTS.md

buildSystemPrompt({ profile: "slim" });
registry.schemas({ slim: true });
// TurnOptions: { promptProfile: "slim", slimTools: true }
```

### Multi-model tool calling

| Provider API | Tools |
| --- | --- |
| OpenAI-compatible (OpenAI, xAI, OpenRouter, …) | native `tools` / `tool_calls` |
| Anthropic | `tools` + `tool_use` / `tool_result` blocks |
| Gemini | `functionDeclarations` + `functionCall` / `functionResponse` |

Compat helpers (`src/toolcalling/compat.ts`): arg JSON repair, alias normalization, per-model caps (parallel, max tools), Anthropic/Gemini schema conversion.

### Tool discipline

`ToolRunner` appends a soft `[libra:discipline]` note when shell is used to echo a prior tool result or replace list_dir/read_file/grep. See `src/toolcalling/discipline.ts`.

### Latency

Tool timings accumulate in `globalLatency` (`src/toolcalling/latency.ts`). Live runs write `latency.json` (case p50/p95 + shell buckets).

## License

MIT
