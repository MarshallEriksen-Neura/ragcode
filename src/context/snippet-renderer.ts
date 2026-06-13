import type { ContextMode, ContextSnippet, SearchHit } from "../core/types.js";
import { chooseExpansion } from "./expansion-policy.js";
import { skeletonizeChunk } from "./skeletonizer.js";

const FOCUS_WINDOW_LINES = 28;
const MAX_SNIPPET_LINES = 150;
const MAX_SNIPPET_CHARS = 8000;

export function renderSnippet(hit: SearchHit, query: string, mode: Exclude<ContextMode, "auto">): ContextSnippet {
  const originalLineCount = lineCount(hit.chunk.content);
  const decision = chooseExpansion(hit.chunk, query, mode);
  const rendered = renderContent(hit, decision.expansionLevel, decision.focusLine);
  const returnedLineCount = lineCount(rendered);

  return {
    filePath: hit.chunk.filePath,
    startLine: renderedStartLine(hit, decision.focusLine),
    endLine: renderedEndLine(hit, rendered, decision.focusLine),
    content: rendered,
    score: hit.score,
    reason: hit.reason,
    role: roleForHit(hit),
    expansionLevel: decision.expansionLevel,
    originalLineCount,
    returnedLineCount,
    elidedLineCount: Math.max(0, originalLineCount - returnedLineCount)
  };
}

function renderContent(hit: SearchHit, expansionLevel: ContextSnippet["expansionLevel"], focusLine?: number): string {
  let content: string;
  if (expansionLevel === "full_body") content = hit.chunk.content;
  else if (expansionLevel === "skeleton") content = skeletonizeChunk(hit.chunk);
  else if (expansionLevel === "file_card") content = fileCard(hit);
  else if (focusLine !== undefined) content = focusedWindow(hit.chunk.content, focusLine);
  else content = hit.chunk.content;

  return truncateContent(content, MAX_SNIPPET_LINES, MAX_SNIPPET_CHARS);
}

function truncateContent(content: string, maxLines: number, maxChars: number): string {
  // Check character limit first
  if (content.length > maxChars) {
    return content.substring(0, maxChars) + '\n... [truncated: +' + (content.length - maxChars) + ' chars]';
  }

  // Check line limit
  const lines = content.split(/\r?\n/);
  if (lines.length <= maxLines) {
    return content;
  }

  // Try smart truncation: find function/class boundaries within ±10 lines of limit
  const targetLine = maxLines;
  let bestCutLine = targetLine;

  for (let i = Math.max(0, targetLine - 10); i <= Math.min(lines.length - 1, targetLine + 10); i++) {
    const line = lines[i]?.trim() || '';
    // Look for function/class/method endings (closing braces at start of line)
    if (line === '}' || line.startsWith('} ') || line === '};') {
      bestCutLine = i + 1;
      break;
    }
  }

  // If we found a better boundary, use it; otherwise use the limit
  const cutLine = bestCutLine;
  const truncatedLines = lines.slice(0, cutLine);
  const omittedCount = lines.length - cutLine;

  return truncatedLines.join('\n') + '\n... [truncated: +' + omittedCount + ' lines]';
}

function focusedWindow(content: string, focusLine: number): string {
  const lines = content.split(/\r?\n/);
  const half = Math.floor(FOCUS_WINDOW_LINES / 2);
  const start = Math.max(0, focusLine - 1 - half);
  const end = Math.min(lines.length, start + FOCUS_WINDOW_LINES);
  const prefix = start > 0 ? ["..."] : [];
  const suffix = end < lines.length ? ["..."] : [];
  return [...prefix, ...lines.slice(start, end), ...suffix].join("\n");
}

function renderedStartLine(hit: SearchHit, focusLine?: number): number {
  if (focusLine === undefined) return hit.chunk.startLine;
  return hit.chunk.startLine + Math.max(0, focusLine - 1 - Math.floor(FOCUS_WINDOW_LINES / 2));
}

function renderedEndLine(hit: SearchHit, content: string, focusLine?: number): number {
  if (focusLine === undefined) return hit.chunk.startLine + Math.max(0, lineCount(content) - 1);
  return renderedStartLine(hit, focusLine) + Math.max(0, lineCount(content) - 1);
}

function fileCard(hit: SearchHit): string {
  return [
    `${hit.chunk.kind}: ${hit.chunk.symbolName ?? hit.chunk.filePath}`,
    `language: ${hit.chunk.language}`,
    `lines: ${hit.chunk.startLine}-${hit.chunk.endLine}`
  ].join("\n");
}

function roleForHit(hit: SearchHit): string {
  if (hit.chunk.symbolName) return `${hit.chunk.kind}: ${hit.chunk.symbolName}`;
  return `${hit.chunk.kind} evidence`;
}

function lineCount(content: string): number {
  return content.length === 0 ? 0 : content.split(/\r?\n/).length;
}
