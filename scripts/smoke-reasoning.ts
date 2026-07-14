/**
 * Smoke: native reasoning caps are fetched per model from OpenRouter,
 * clamped (hy3 has no max/xhigh), and emitted as API fields not prompts.
 */
import { fetchModelsForProvider } from "../src/auth/models.js";
import {
  getCachedReasoningCaps,
  buildReasoningApiFields,
  effortPickerOptions,
  setEffortForModel,
  resolveEffortForModel,
} from "../src/agent/reasoning.js";

async function main() {
  const r = await fetchModelsForProvider("openrouter", { force: true });
  console.log("openrouter models:", r.models.length, r.error ?? "ok");

  const want = [
    "tencent/hy3:free",
    "tencent/hy3",
    "openai/o3-mini",
    "openai/gpt-5",
    "x-ai/grok-4",
  ];

  for (const id of want) {
    const m =
      r.models.find((x) => x.id === id) ??
      r.models.find((x) => x.id.includes(id.split("/").pop()!));
    if (!m) {
      console.log("---", id, "NOT IN CATALOG");
      continue;
    }
    const caps = getCachedReasoningCaps("openrouter", m.id);
    console.log("\n---", m.id);
    console.log(
      "  caps:",
      caps?.supported,
      caps?.efforts,
      "source=" + caps?.source,
      "style=" + caps?.style,
    );

    setEffortForModel("openrouter", m.id, "max");
    const maxRes = resolveEffortForModel("openrouter", m.id);
    console.log(
      "  set max → effort=",
      maxRes.effort,
      "clamped=",
      maxRes.clamped,
      "fields=",
      JSON.stringify(buildReasoningApiFields("openrouter", m.id)),
    );

    setEffortForModel("openrouter", m.id, "high");
    console.log(
      "  set high → fields=",
      JSON.stringify(buildReasoningApiFields("openrouter", m.id)),
    );

    console.log(
      "  picker options:",
      effortPickerOptions("openrouter", m.id)
        .map((o) => o.value)
        .join(", "),
    );

    // Ensure we never inject "think step by step" style prompts
    const fields = buildReasoningApiFields("openrouter", m.id);
    const keys = Object.keys(fields);
    if (keys.some((k) => /prompt|system|message/i.test(k))) {
      throw new Error("reasoning leaked into prompt fields: " + keys.join(","));
    }
  }

  // xAI heuristic path
  const x = await fetchModelsForProvider("xai", { force: true });
  console.log("\nxai models:", x.models.length, x.error ?? "ok");
  const grok = x.models.find((m) => /reason/i.test(m.id)) ?? x.models[0];
  if (grok) {
    const caps = getCachedReasoningCaps("xai", grok.id);
    console.log("xai sample", grok.id, caps?.efforts, caps?.source);
    setEffortForModel("xai", grok.id, "high");
    console.log("xai fields", JSON.stringify(buildReasoningApiFields("xai", grok.id)));
  }

  console.log("\nOK — native API fields only, per-model efforts.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
