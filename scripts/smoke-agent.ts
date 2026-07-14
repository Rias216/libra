import { saveApiKey, resolveToken } from "../src/auth/api-key.js";
import { saveConfig } from "../src/config/store.js";
import { HarnessStore } from "../src/core/store.js";
import { AgentLoop } from "../src/agent/loop.js";
import { initDebug, getDebugLogPath } from "../src/agent/debug.js";

const KEY = process.env.OPENROUTER_API_KEY || resolveToken("openrouter") || "";

async function main() {
  initDebug(process.env.LIBRA_DEBUG ? undefined : "info");
  if (!KEY) {
    console.error("No OpenRouter key. Set OPENROUTER_API_KEY or /login openrouter");
    process.exit(1);
  }
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
      lightReasoning: true,
      label: "smoke",
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
  console.log("debug", getDebugLogPath());
  if (store.state.phase === "error") process.exit(1);
  if (!tools.some((t) => t.includes("completed"))) {
    console.error("FAIL: expected completed tool call");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
