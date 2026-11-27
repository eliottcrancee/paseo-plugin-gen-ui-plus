import type { PluginTimelineItem } from "@getpaseo/plugin";
import { findFences } from "./fallback";

export const GENUI_BLOCK_KIND = "genui-block";
export const GENUI_TEXT_KIND = "genui-text";

export type MessageSegment =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "fence";
      readonly language: "ui" | "app";
      readonly code: string;
      readonly complete: boolean;
      readonly fenceIndex: number;
    };

export function segmentMessage(text: string, phase: "streaming" | "complete"): MessageSegment[] {
  const lines = text.split("\n");
  const allFences = findFences(lines);
  const uiFences = allFences.filter((fence) => fence.language === "ui" || fence.language === "app");
  if (uiFences.length === 0) return [{ kind: "text", text }];

  const segments: MessageSegment[] = [];
  let cursor = 0;
  let fenceIndex = 0;
  for (const fence of uiFences) {
    if (fence.open > cursor) {
      const prose = lines.slice(cursor, fence.open).join("\n").trim();
      if (prose !== "") segments.push({ kind: "text", text: prose });
    }
    const language = fence.language === "app" ? "app" : "ui";
    segments.push({
      kind: "fence",
      language,
      code: fence.body,
      complete: fence.closed,
      fenceIndex: fenceIndex++,
    });
    cursor = fence.close + 1;
  }
  if (cursor < lines.length) {
    const tail = lines.slice(cursor).join("\n").trim();
    if (tail !== "") segments.push({ kind: "text", text: tail });
  }
  return segments;
}

const FENCED_CODE_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`[^`\n]+`/g;
const DISPLAY_MATH_RE = /\$\$[^\n$][\s\S]*?\$\$/;
const INLINE_MATH_RE = /(?<!\\)\$(?!\$)([^$\n]+?)(?<!\\)\$(?!\$)/g;
const LATEX_SIGNAL_RE = /\\[a-zA-Z]{2,}|[\w)}\]]\^[\w({\\+-]|[\w)}\]]_[\w({\\]/;

/**
 * Returns true when prose outside code blocks contains LaTeX math (`$$...$$` or
 * inline `$...$` with LaTeX commands/exponents/subscripts), ignoring prices like `$10 and $20`.
 */
export function containsLatexMath(text: string): boolean {
  if (!text.includes("$")) return false;
  const stripped = text.replace(FENCED_CODE_RE, "").replace(INLINE_CODE_RE, "");
  if (DISPLAY_MATH_RE.test(stripped)) return true;
  INLINE_MATH_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = INLINE_MATH_RE.exec(stripped)) !== null) {
    const inner = match[1] ?? "";
    if (!inner || /^\s|\s$/.test(inner)) continue;
    if (LATEX_SIGNAL_RE.test(inner)) return true;
  }
  return false;
}

export function splitTimelineMessage(
  text: string,
  phase: "streaming" | "complete",
  messageId?: string,
): { items: PluginTimelineItem[] } | undefined {
  const segments = segmentMessage(text, phase);
  const hasFence = segments.some((segment) => segment.kind === "fence");
  if (!hasFence && !containsLatexMath(text)) return undefined;

  const items: PluginTimelineItem[] = [];
  segments.forEach((segment) => {
    if (segment.kind === "fence") {
      items.push({
        type: "plugin",
        kind: GENUI_BLOCK_KIND,
        version: 1,
        data: {
          language: segment.language,
          code: segment.code,
          complete: segment.complete,
          fenceIndex: segment.fenceIndex,
          ...(messageId ? { messageId } : {}),
        },
      });
    } else {
      items.push({
        type: "plugin",
        kind: GENUI_TEXT_KIND,
        version: 1,
        data: { text: segment.text, phase },
      });
    }
  });
  return { items };
}
