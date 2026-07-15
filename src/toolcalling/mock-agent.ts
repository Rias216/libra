/**
 * Demo agent — streams a realistic multi-step coding turn so the TUI
 * can be evaluated without wiring a real LLM provider.
 */

import { newId, type DiffPart, type ToolPart } from "../core/types.js";
import type { HarnessStore } from "../core/store.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function streamText(
  store: HarnessStore,
  messageId: string,
  partId: string,
  text: string,
  cps = 40,
): Promise<void> {
  // stream in small chunks for a natural feel
  const words = text.split(/(\s+)/);
  for (const w of words) {
    store.textDelta(messageId, partId, w);
    await sleep(Math.max(8, 1000 / cps));
  }
  store.patchPart(messageId, partId, { streaming: false } as never);
}

async function streamReasoning(
  store: HarnessStore,
  messageId: string,
  partId: string,
  text: string,
): Promise<void> {
  const chunks = text.match(/.{1,12}/g) ?? [text];
  for (const c of chunks) {
    store.reasoningDelta(messageId, partId, c);
    await sleep(18);
  }
  store.patchPart(messageId, partId, { streaming: false } as never);
}

export class MockAgent {
  private busy = false;
  private abort = false;

  constructor(private store: HarnessStore) {}

  cancel(): void {
    this.abort = true;
  }

  async handle(userText: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.abort = false;

    try {
      this.store.appendUser(userText);
      const assistant = this.store.startAssistant();
      const mid = assistant.id;

      this.store.setPhase("thinking", "planning approach");

      // Reasoning block
      const rid = newId("p");
      this.store.appendPart(mid, {
        id: rid,
        type: "reasoning",
        content: "",
        streaming: true,
      });
      await streamReasoning(
        this.store,
        mid,
        rid,
        "The user wants a custom TUI renderer. I should inspect the workspace layout, " +
          "sketch a part-based message model, then stream tool activity the way OpenCode and Grok CLI do.",
      );
      if (this.abort) return;

      // Tool: list_dir
      await this.runTool(mid, {
        toolName: "list_dir",
        args: { target_directory: "." },
        result:
          ".\n├── package.json\n├── src/\n│   ├── core/\n│   ├── memory/\n│   ├── toolcalling/\n│   ├── complete/\n│   └── tui/\n└── tsconfig.json",
        delay: 400,
      });
      if (this.abort) return;

      // Tool: read_file
      await this.runTool(mid, {
        toolName: "read_file",
        args: { target_file: "package.json", limit: 40 },
        result:
          '{\n  "name": "libra",\n  "version": "0.1.0",\n  "type": "module",\n  "scripts": {\n    "dev": "bun src/cli.ts"\n  }\n}',
        delay: 350,
      });
      if (this.abort) return;

      this.store.setPhase("streaming", "writing response");

      const tid = newId("p");
      this.store.appendPart(mid, {
        id: tid,
        type: "text",
        content: "",
        streaming: true,
      });

      await streamText(
        this.store,
        mid,
        tid,
        "I've sketched a **custom TUI renderer** for the harness with these pieces:\n\n" +
          "1. **Polymorphic parts** — `text`, `reasoning`, `tool`, `diff`, `file`, `status`\n" +
          "2. **Event bus** — harness mutates state; the renderer only paints\n" +
          "3. **Frame buffer** — dirty-line diffing (OpenTUI-inspired)\n" +
          "4. **Themes** — Libra Night / Day / Tokyo Night with RGB quantization\n\n" +
          "Here's a small edit I'll apply to the status chrome:\n",
        55,
      );
      if (this.abort) return;

      // Diff part
      const diff: DiffPart = {
        id: newId("p"),
        type: "diff",
        path: "src/tui/chrome.ts",
        additions: 3,
        deletions: 1,
        hunks: [
          {
            header: "@@ -12,7 +12,9 @@ export function renderStatus",
            lines: [
              { kind: "context", text: "  const tokens = formatTokens(state);" },
              { kind: "del", text: "  const hint = \"enter send\";" },
              { kind: "add", text: "  const hint = focus === \"prompt\"" },
              { kind: "add", text: "    ? \"enter send · /help\"" },
              { kind: "add", text: "    : \"j/k scroll · tab prompt\";" },
              { kind: "context", text: "  return { segments: [...] };" },
            ],
          },
        ],
      };
      this.store.appendPart(mid, diff);
      await sleep(200);

      await this.runTool(mid, {
        toolName: "search_replace",
        args: {
          file_path: "src/tui/chrome.ts",
          old_string: 'const hint = "enter send";',
          new_string:
            'const hint = focus === "prompt" ? "enter send · /help" : "j/k scroll · tab prompt";',
        },
        result: "updated 1 occurrence",
        delay: 500,
      });
      if (this.abort) return;

      const tid2 = newId("p");
      this.store.appendPart(mid, {
        id: tid2,
        type: "text",
        content: "",
        streaming: true,
      });
      await streamText(
        this.store,
        mid,
        tid2,
        "\nDone. Try `/theme`, `/compact`, `/thinking`, or `/details` — " +
          "or ask me anything else to exercise the scrollback.",
        50,
      );

      this.store.addTokens(420, 680);
      this.store.setPhase("idle");
    } catch (err) {
      this.store.setPhase(
        "error",
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      this.busy = false;
    }
  }

  private async runTool(
    messageId: string,
    opts: {
      toolName: string;
      args: Record<string, unknown>;
      result: string;
      delay: number;
      error?: string;
    },
  ): Promise<void> {
    this.store.setPhase("tool", opts.toolName);
    const part: ToolPart = {
      id: newId("p"),
      type: "tool",
      toolName: opts.toolName,
      args: opts.args,
      status: "pending",
    };
    this.store.appendPart(messageId, part);
    await sleep(80);
    this.store.toolStatus(messageId, part.id, "running");
    await sleep(opts.delay);
    if (opts.error) {
      this.store.toolStatus(messageId, part.id, "error", { error: opts.error });
    } else {
      this.store.toolStatus(messageId, part.id, "completed", {
        result: opts.result,
      });
    }
  }
}
