/**
 * Multimodal wire helpers for provider request serialization
 * and vision capability checks.
 */

import type { ChatContent, ChatContentPart } from "../llm/content.js";
import {
  applyVisionGate,
  contentHasImage,
  contentToPlainText,
  isContentParts,
  visionFallbackText,
} from "../llm/content.js";

export type {
  ChatContent,
  ChatContentPart,
} from "../llm/content.js";
export {
  applyVisionGate,
  contentHasImage,
  contentToPlainText,
  isContentParts,
  mimeFromPath,
  imagePart,
  textPart,
  visionFallbackText,
} from "../llm/content.js";

/**
 * Heuristic: does this model accept image inputs?
 * Catalog-backed when available; name heuristics as fallback.
 */
export function modelSupportsVision(
  model: string | undefined | null,
  catalogVision?: boolean,
): boolean {
  if (catalogVision === true) return true;
  if (catalogVision === false) return false;
  if (!model) return false;
  const m = model.toLowerCase();
  if (/\bvision\b/.test(m)) return true;
  if (/\bgpt-4o\b/.test(m) || /\bgpt-4\.1\b/.test(m) || /\bgpt-5\b/.test(m)) {
    return true;
  }
  if (/\bclaude-(3|4|sonnet|opus|haiku)/.test(m) && !/haiku-3(?!\.)/.test(m)) {
    return true;
  }
  if (/\bgemini/.test(m) && !/text/.test(m)) return true;
  if (/\bgrok-2-vision/.test(m) || /\bgrok-4/.test(m)) return true;
  // Explicit free text / non-vision coding models
  if (/deepseek|hy3|llama-3\.1-8b|qwen.*coder|big-pickle|kimi-k2/.test(m)) {
    return false;
  }
  return false;
}

/** OpenAI / OpenRouter-compatible content parts. */
export function toOpenAIContentParts(
  content: ChatContent,
): string | null | Array<Record<string, unknown>> {
  if (content == null) return null;
  if (typeof content === "string") return content;
  return content.map((p) => {
    if (p.type === "text") {
      return { type: "text", text: p.text };
    }
    const url = p.data.startsWith("data:")
      ? p.data
      : `data:${p.mimeType};base64,${p.data}`;
    return {
      type: "image_url",
      image_url: { url },
    };
  });
}

/** Anthropic Messages API content blocks. */
export function toAnthropicContentBlocks(
  content: ChatContent,
): string | Array<Record<string, unknown>> {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content.map((p) => {
    if (p.type === "text") {
      return { type: "text", text: p.text };
    }
    const mediaType = p.mimeType || "image/png";
    const data = p.data.replace(/^data:[^;]+;base64,/, "");
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: mediaType,
        data,
      },
    };
  });
}

/** Gemini generateContent parts. */
export function toGeminiParts(
  content: ChatContent,
): Array<Record<string, unknown>> {
  if (content == null) return [{ text: "" }];
  if (typeof content === "string") {
    return content.trim() ? [{ text: content }] : [{ text: "" }];
  }
  const parts: Array<Record<string, unknown>> = [];
  for (const p of content) {
    if (p.type === "text") {
      if (p.text) parts.push({ text: p.text });
    } else {
      const data = p.data.replace(/^data:[^;]+;base64,/, "");
      parts.push({
        inlineData: {
          mimeType: p.mimeType || "image/png",
          data,
        },
      });
    }
  }
  if (!parts.length) parts.push({ text: "" });
  return parts;
}

/**
 * Gate image content for a model: non-vision models get text fallback.
 * Returns content suitable for the wire format.
 */
export function gateContentForModel(
  content: ChatContent,
  model: string | undefined,
  savedPath?: string,
  catalogVision?: boolean,
): ChatContent {
  return applyVisionGate(
    content,
    modelSupportsVision(model, catalogVision),
    savedPath,
  );
}

/** Build tool-result content: prefer parts when images present (after vision gate). */
export function toolResultContent(
  output: string | ChatContentPart[],
  opts?: {
    model?: string;
    savedPath?: string;
    catalogVision?: boolean;
  },
): ChatContent {
  if (typeof output === "string") return output || "(empty)";
  const gated = gateContentForModel(
    output,
    opts?.model,
    opts?.savedPath,
    opts?.catalogVision,
  );
  if (gated == null) return "(empty)";
  if (typeof gated === "string") return gated;
  if (!contentHasImage(gated)) {
    // All text parts — can still send as array or collapse
    return gated.length === 1 && gated[0]!.type === "text"
      ? gated[0]!.text
      : gated;
  }
  return gated;
}

/** Extract saved path from a short summary string if present. */
export function extractSavedScreenshotPath(summary: string): string | undefined {
  const m = summary.match(
    /(?:saved (?:to|as)|screenshot saved to)\s+`?([^\s`]+)`?/i,
  );
  return m?.[1];
}
