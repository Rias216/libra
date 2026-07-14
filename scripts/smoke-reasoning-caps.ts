/**
 * Verify per-model efforts come from catalog supported_efforts, not a static list.
 */
import { fetchModelsForProvider } from "../src/auth/models.js";
import {
  effortPickerOptions,
  getCachedReasoningCaps,
  reasoningCompleteValues,
} from "../src/agent/reasoning.js";

async function main() {
  const r = await fetchModelsForProvider("openrouter", { force: true });
  console.log("models", r.models.length, r.error ?? "ok");

  const want = ["tencent/hy3", "tencent/hy3:free", "x-ai/grok-4.20", "openai/o3-mini"];
  for (const id of want) {
    const m = r.models.find((x) => x.id === id);
    if (!m) {
      console.log("---", id, "missing");
      continue;
    }
    const rawR = (m.raw as { reasoning?: unknown } | undefined)?.reasoning;
    const caps = getCachedReasoningCaps("openrouter", m.id);
    const opts = effortPickerOptions("openrouter", m.id, { allowHeuristic: false });
    console.log("\n---", m.id);
    console.log("  catalog.reasoning =", JSON.stringify(rawR));
    console.log("  caps.source =", caps?.source, "efforts =", caps?.efforts);
    console.log(
      "  picker =",
      opts.map((o) => o.value).join(", "),
    );
    console.log(
      "  complete =",
      reasoningCompleteValues("openrouter", m.id)
        .map((v) => v.value)
        .join(", "),
    );

    // Must not invent xhigh/max for hy3
    if (id.includes("hy3")) {
      const bad = opts.some((o) => o.value === "xhigh" || o.value === "max" || o.value === "medium");
      if (bad) throw new Error("hy3 must not show medium/xhigh/max");
    }
  }
  console.log("\nOK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
