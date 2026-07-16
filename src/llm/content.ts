/**
 * Multimodal chat content parts (text + image).
 * Shared by ChatMessage wire format and image-returning tools.
 */

export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string /* base64 */ };

export type ChatContent = string | null | ChatContentPart[];

/** True when content is a non-empty content-part array. */
export function isContentParts(
  content: ChatContent | undefined,
): content is ChatContentPart[] {
  return Array.isArray(content);
}

/** Flatten content to plain text (images become short placeholders). */
export function contentToPlainText(content: ChatContent | undefined): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content
    .map((p) =>
      p.type === "text"
        ? p.text
        : `[image ${p.mimeType} ${Math.round((p.data?.length ?? 0) * 0.75)} bytes]`,
    )
    .join("\n");
}

/** True when any part is an image. */
export function contentHasImage(content: ChatContent | undefined): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((p) => p.type === "image");
}

/**
 * Text fallback when the active model has no vision input.
 * Path is the saved screenshot/file path when known.
 */
export function visionFallbackText(path?: string): string {
  if (path && path.trim()) {
    return `screenshot saved to \`${path.trim()}\`, model has no vision input.`;
  }
  return "screenshot saved, model has no vision input.";
}

/**
 * For non-vision models: replace image parts with the text fallback,
 * keeping any existing text parts.
 */
export function applyVisionGate(
  content: ChatContent,
  modelSupportsVision: boolean,
  savedPath?: string,
): ChatContent {
  if (modelSupportsVision || !Array.isArray(content)) return content;
  if (!contentHasImage(content)) return content;
  const texts = content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text.trim())
    .filter(Boolean);
  const fallback = visionFallbackText(savedPath);
  const body = texts.length ? `${texts.join("\n")}\n${fallback}` : fallback;
  return body;
}

/** Detect common image extensions / mime. */
export function mimeFromPath(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".bmp")) return "image/bmp";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

export function imagePart(
  mimeType: string,
  base64Data: string,
): ChatContentPart {
  return { type: "image", mimeType, data: base64Data };
}

export function textPart(text: string): ChatContentPart {
  return { type: "text", text };
}
