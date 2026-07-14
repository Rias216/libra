import { saveApiKey } from "../src/auth/api-key.js";
import { saveConfig } from "../src/config/store.js";
import { HarnessStore } from "../src/core/store.js";
import { AgentLoop } from "../src/agent/loop.js";

const KEY =
  process.env.OPENROUTER_API_KEY ||
  "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";

async function main() {
  saveApiKey("openrouter", KEY, { label: "user" });
  saveConfig({
    provider: "openrouter",
    model: "tencent/hy3:free",
    modelKey: "openrouter/tencent/hy3:free",
  });

  const store = new HarnessStore({
    provider: "openrouter",
    model: "tencent/hy3:free",
    title: "smoke",
  });
  store.subscribe(() => {
    /* drain */
  });
  const agent = new AgentLoop(store);
  const t0 = Date.now();
  await agent.handle(
    "Use list_dir on . and tell me what top-level files you see. Be brief.",
    {
      provider: "openrouter",
      model: "tencent/hy3:free",
      cwd: process.cwd(),
      tools: true,
    },
  );
  const ms = Date.now() - t0;
  const last = store.state.messages[store.state.messages.length - 1];
  const tools =
    last?.parts
      .filter((p) => p.type === "tool")
      .map((p) =>
        p.type === "tool" ? `${p.toolName}:${p.status}` : "",
      ) ?? [];
  const text =
    last?.parts
      .filter((p) => p.type === "text")
      .map((p) => (p.type === "text" ? p.content : ""))
      .join("\n") ?? "";
  console.log("phase", store.state.phase, "ms", ms);
  console.log("tools", tools.join(", ") || "(none)");
  console.log("text:", text.slice(0, 500));
  console.log("tokens", store.state.tokens);
  if (store.state.phase === "error") process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
