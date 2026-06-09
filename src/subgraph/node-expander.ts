import type { CodeChunk, ContextSnippet, ExpandNodeResult, ExpansionLevel, SymbolNode } from "../core/types.js";
import { skeletonizeChunk } from "../context/skeletonizer.js";
import { normalizeUserPath } from "../utils/path.js";

const DEFAULT_BUDGET_CHARS = 4_000;
const FOCUS_WINDOW_LINES = 36;

export interface ExpandNodeBuildInput {
  nodeRef: string;
  chunks: CodeChunk[];
  symbols: SymbolNode[];
  expansionLevel?: ExpansionLevel;
  budgetChars?: number;
}

export function expandNode(input: ExpandNodeBuildInput): ExpandNodeResult {
  const budgetChars = input.budgetChars ?? DEFAULT_BUDGET_CHARS;
  const parsed = parseNodeRef(input.nodeRef);
  const symbol = selectSymbol(input.symbols, parsed.filePath, parsed.symbolName);
  const filePath = symbol?.filePath ?? parsed.filePath;
  const symbolName = symbol?.kind === "file" ? parsed.symbolName : symbol?.name ?? parsed.symbolName;
  const chunk = selectChunk(input.chunks, filePath, symbolName, symbol);
  const expansionLevel = input.expansionLevel ?? defaultExpansion(chunk);
  const missingEvidence: string[] = [];
  const snippets: ContextSnippet[] = [];

  if (!chunk) {
    missingEvidence.push(`No indexed chunk matched ${input.nodeRef}.`);
    return {
      nodeRef: input.nodeRef,
      filePath,
      symbolName,
      expansionLevel,
      snippets,
      missingEvidence,
      budgetChars,
      usedChars: 0
    };
  }

  const content = renderChunk(chunk, expansionLevel, symbol);
  const cost = chunk.filePath.length + content.length + 120;
  if (cost > budgetChars && expansionLevel === "full_body") {
    missingEvidence.push(`Full body for ${input.nodeRef} exceeds budget; request a larger budget or use skeleton/focused_body.`);
  } else if (cost > budgetChars) {
    missingEvidence.push(`Expanded node ${input.nodeRef} was reduced to skeleton to fit budget.`);
  }
  const finalLevel = cost > budgetChars && expansionLevel !== "file_card" ? "skeleton" : expansionLevel;
  const finalContent = finalLevel === expansionLevel ? content : renderChunk(chunk, finalLevel, symbol);
  const usedChars = Math.min(budgetChars, chunk.filePath.length + finalContent.length + 120);
  if (usedChars <= budgetChars) {
    snippets.push(snippetFor(chunk, finalContent, finalLevel, input.nodeRef, symbol));
  }

  return {
    nodeRef: input.nodeRef,
    filePath: chunk.filePath,
    symbolName: chunk.symbolName ?? symbolName,
    expansionLevel: finalLevel,
    snippets,
    missingEvidence,
    budgetChars,
    usedChars
  };
}

export function parseNodeRef(nodeRef: string): { filePath: string; symbolName?: string } {
  const separator = nodeRef.lastIndexOf(":");
  if (separator > 0 && !/^[a-zA-Z]:[\\/]/.test(nodeRef)) {
    return {
      filePath: normalizeUserPath(nodeRef.slice(0, separator)),
      symbolName: nodeRef.slice(separator + 1).trim() || undefined
    };
  }
  return { filePath: normalizeUserPath(nodeRef) };
}

function selectSymbol(symbols: SymbolNode[], filePath: string, symbolName?: string): SymbolNode | undefined {
  if (symbolName) {
    return symbols.find((symbol) => symbol.filePath === filePath && symbol.name === symbolName)
      ?? symbols.find((symbol) => symbol.filePath.endsWith(filePath) && symbol.name === symbolName);
  }
  return symbols.find((symbol) => symbol.filePath === filePath && symbol.kind === "file")
    ?? symbols.find((symbol) => symbol.filePath.endsWith(filePath) && symbol.kind === "file");
}

function selectChunk(chunks: CodeChunk[], filePath: string, symbolName?: string, symbol?: SymbolNode): CodeChunk | undefined {
  const sameFile = chunks.filter((chunk) => chunk.filePath === filePath || chunk.filePath.endsWith(filePath));
  if (sameFile.length === 0) return undefined;
  if (symbolName) {
    const exact = sameFile.find((chunk) => chunk.symbolName === symbolName);
    if (exact) return exact;
  }
  if (symbol) {
    const containing = sameFile.find((chunk) => chunk.startLine <= symbol.startLine && chunk.endLine >= symbol.startLine);
    if (containing) return containing;
  }
  return sameFile[0];
}

function defaultExpansion(chunk: CodeChunk | undefined): ExpansionLevel {
  if (!chunk) return "focused_body";
  return lineCount(chunk.content) > 80 ? "skeleton" : "focused_body";
}

function renderChunk(chunk: CodeChunk, expansionLevel: ExpansionLevel, symbol?: SymbolNode): string {
  if (expansionLevel === "file_card") {
    return [
      `${chunk.kind}: ${chunk.symbolName ?? chunk.filePath}`,
      `language: ${chunk.language}`,
      `lines: ${chunk.startLine}-${chunk.endLine}`
    ].join("\n");
  }
  if (expansionLevel === "skeleton") return skeletonizeChunk(chunk);
  if (expansionLevel === "full_body") return chunk.content;
  return focusedBody(chunk.content, symbol ? Math.max(1, symbol.startLine - chunk.startLine + 1) : undefined);
}

function focusedBody(content: string, focusLine?: number): string {
  const lines = content.split(/\r?\n/);
  if (lines.length <= FOCUS_WINDOW_LINES) return content;
  const focus = focusLine ?? 1;
  const half = Math.floor(FOCUS_WINDOW_LINES / 2);
  const start = Math.max(0, focus - 1 - half);
  const end = Math.min(lines.length, start + FOCUS_WINDOW_LINES);
  return [
    ...(start > 0 ? ["..."] : []),
    ...lines.slice(start, end),
    ...(end < lines.length ? ["..."] : [])
  ].join("\n");
}

function snippetFor(chunk: CodeChunk, content: string, expansionLevel: ExpansionLevel, nodeRef: string, symbol?: SymbolNode): ContextSnippet {
  const returnedLineCount = lineCount(content);
  const originalLineCount = lineCount(chunk.content);
  return {
    filePath: chunk.filePath,
    startLine: symbol?.startLine ?? chunk.startLine,
    endLine: (symbol?.startLine ?? chunk.startLine) + Math.max(0, returnedLineCount - 1),
    content,
    score: 1,
    reason: `Expanded node ${nodeRef}`,
    role: chunk.symbolName ? `${chunk.kind}: ${chunk.symbolName}` : `${chunk.kind} evidence`,
    expansionLevel,
    originalLineCount,
    returnedLineCount,
    elidedLineCount: Math.max(0, originalLineCount - returnedLineCount)
  };
}

function lineCount(content: string): number {
  return content.length === 0 ? 0 : content.split(/\r?\n/).length;
}
