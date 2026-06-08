import type { CodeChunk, ContextMode, ExpansionLevel } from "../core/types.js";

export interface ExpansionDecision {
  expansionLevel: ExpansionLevel;
  focusLine?: number;
}

const LARGE_CHUNK_LINES = 80;

export function chooseExpansion(chunk: CodeChunk, query: string, mode: Exclude<ContextMode, "auto">): ExpansionDecision {
  const originalLineCount = lineCount(chunk.content);
  if (explicitFullRequest(query)) return { expansionLevel: "full_body" };
  if (originalLineCount <= LARGE_CHUNK_LINES) return { expansionLevel: "focused_body" };

  const focusLine = bestMatchingLine(chunk.content, query);
  if (focusLine !== undefined && shouldFocusLargeChunk(chunk, query, mode)) {
    return { expansionLevel: "focused_body", focusLine };
  }

  if (mode === "debug" && focusLine !== undefined) return { expansionLevel: "focused_body", focusLine };
  return { expansionLevel: "skeleton" };
}

function explicitFullRequest(query: string): boolean {
  return /\b(full body|full source|entire file|完整|全部源码)\b/i.test(query);
}

function shouldFocusLargeChunk(chunk: CodeChunk, query: string, mode: Exclude<ContextMode, "auto">): boolean {
  if (mode === "debug" || mode === "review") return true;
  if (chunk.symbolName && query.toLowerCase().includes(chunk.symbolName.toLowerCase())) return true;
  return false;
}

function bestMatchingLine(content: string, query: string): number | undefined {
  const terms = queryTerms(query);
  if (terms.length === 0) return undefined;
  const lines = content.split(/\r?\n/);
  let best: { line: number; score: number } | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const lower = lines[index]!.toLowerCase();
    const score = terms.reduce((sum, term) => lower.includes(term) ? sum + term.length : sum, 0);
    if (score > 0 && (!best || score > best.score)) best = { line: index + 1, score };
  }
  return best?.line;
}

function queryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_:-]+/i)
    .map((part) => part.trim())
    .filter((part) => part.length >= 3);
}

function lineCount(content: string): number {
  return content.length === 0 ? 0 : content.split(/\r?\n/).length;
}
