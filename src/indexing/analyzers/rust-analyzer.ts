import type { CodeChunk, CodeFile, GraphEdge, SymbolKind, SymbolNode } from "../../core/types.js";
import { sha256, stableId } from "../../utils/hash.js";
import { createFileSymbol, fallbackFileAnalysis } from "./fallback-analyzer.js";
import type { FileAnalysis, LanguageAnalyzer } from "./types.js";

export const rustAnalyzer: LanguageAnalyzer = {
  language: "rust",
  capabilities: ["symbols", "imports", "exports", "calls"],
  analyzeFile: ({ repoRoot, file, content }) => analyzeRustFile(repoRoot, file, content)
};

export function analyzeRustFile(repoRoot: string, file: CodeFile, content: string): FileAnalysis {
  const lines = content.split(/\r?\n/);
  const fileSymbol = createFileSymbol(repoRoot, file, lines.length);
  const symbols: SymbolNode[] = [fileSymbol];
  const chunks: CodeChunk[] = [];
  const edges: GraphEdge[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const source = /^\s*use\s+([^;]+);/.exec(lines[index]!)?.[1] ?? /^\s*mod\s+([A-Za-z_]\w*)\s*;/.exec(lines[index]!)?.[1];
    if (!source) continue;
    edges.push({
      projectId: file.projectId,
      sourceId: fileSymbol.id,
      targetId: stableId([repoRoot, source, "module"]),
      kind: "imports",
      metadata: { source, sourceFile: file.path, line: index + 1, resolution: "rust_import" }
    });
  }

  for (const declaration of declarationsFor(lines)) {
    const symbol = symbolFromDeclaration(repoRoot, file, declaration);
    symbols.push(symbol);
    chunks.push(chunkFromSymbol(repoRoot, file, content, symbol));
    edges.push({ projectId: file.projectId, sourceId: fileSymbol.id, targetId: symbol.id, kind: "contains", metadata: { sourceFile: file.path } });
    if (symbol.exported) {
      edges.push({ projectId: file.projectId, sourceId: fileSymbol.id, targetId: symbol.id, kind: "exports", metadata: { sourceFile: file.path, name: symbol.name, resolution: "rust_export" } });
    }
    for (const call of callsIn(lines.slice(symbol.startLine - 1, symbol.endLine).join("\n"))) {
      edges.push({
        projectId: file.projectId,
        sourceId: symbol.id,
        targetId: stableId([repoRoot, call.name, "symbol"]),
        kind: "calls",
        metadata: { targetName: call.name, sourceFile: file.path, line: symbol.startLine + call.lineOffset, resolution: "rust_call" }
      });
    }
  }

  if (chunks.length === 0) return fallbackFileAnalysis(repoRoot, file, content, fileSymbol, edges);
  return { chunks, symbols, edges };
}

interface Declaration {
  name: string;
  kind: SymbolKind;
  startLine: number;
  endLine: number;
  signature: string;
  exported: boolean;
}

function declarationsFor(lines: string[]): Declaration[] {
  const declarations: Declaration[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const match = /^\s*(pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)\s*\(/.exec(line)
      ?? /^\s*(pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)\b/.exec(line)
      ?? /^\s*(pub\s+)?impl\s+([A-Za-z_]\w*)\b/.exec(line);
    if (!match) continue;
    const name = match[2]!;
    const trimmed = line.trim();
    declarations.push({
      name,
      kind: trimmed.includes("fn ") ? "function" : "type",
      startLine: index + 1,
      endLine: blockEnd(lines, index),
      signature: trimmed,
      exported: Boolean(match[1])
    });
  }
  return declarations;
}

function blockEnd(lines: string[], startIndex: number): number {
  let depth = 0;
  let seenOpen = false;
  for (let index = startIndex; index < lines.length; index += 1) {
    for (const char of lines[index]!) {
      if (char === "{") {
        depth += 1;
        seenOpen = true;
      } else if (char === "}") {
        depth -= 1;
      }
    }
    if (seenOpen && depth <= 0) return index + 1;
  }
  return startIndex + 1;
}

function symbolFromDeclaration(repoRoot: string, file: CodeFile, declaration: Declaration): SymbolNode {
  return {
    id: stableId([repoRoot, file.path, declaration.name, declaration.startLine, declaration.endLine, declaration.kind]),
    projectId: file.projectId,
    filePath: file.path,
    name: declaration.name,
    kind: declaration.kind,
    language: "rust",
    startLine: declaration.startLine,
    endLine: declaration.endLine,
    signature: declaration.signature,
    exported: declaration.exported
  };
}

function chunkFromSymbol(repoRoot: string, file: CodeFile, content: string, symbol: SymbolNode): CodeChunk {
  const body = content.split(/\r?\n/).slice(symbol.startLine - 1, symbol.endLine).join("\n");
  return {
    id: stableId([repoRoot, file.path, symbol.name, symbol.startLine, symbol.endLine, sha256(body)]),
    projectId: file.projectId,
    repoRoot,
    filePath: file.path,
    language: "rust",
    kind: symbol.kind === "unknown" ? "block" : symbol.kind,
    symbolName: symbol.name,
    startLine: symbol.startLine,
    endLine: symbol.endLine,
    content: body,
    contentHash: sha256(body)
  };
}

function callsIn(content: string): Array<{ name: string; lineOffset: number }> {
  const calls: Array<{ name: string; lineOffset: number }> = [];
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const pattern = /\b([A-Za-z_]\w*)\s*(?:::<[^>]+>)?\(/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(lines[index]!))) {
      const name = match[1]!;
      if (["fn", "if", "for", "while", "match", "return"].includes(name)) continue;
      calls.push({ name, lineOffset: index });
    }
  }
  return calls;
}
