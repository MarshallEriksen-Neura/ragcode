import type { CodeChunk, CodeFile, GraphEdge, SymbolKind, SymbolNode } from "../../core/types.js";
import { sha256, stableId } from "../../utils/hash.js";
import { createFileSymbol, fallbackFileAnalysis } from "./fallback-analyzer.js";
import type { FileAnalysis, LanguageAnalyzer } from "./types.js";

export const pythonAnalyzer: LanguageAnalyzer = {
  language: "python",
  capabilities: ["symbols", "imports", "exports", "calls"],
  analyzeFile: ({ repoRoot, file, content }) => analyzePythonFile(repoRoot, file, content)
};

export function analyzePythonFile(repoRoot: string, file: CodeFile, content: string): FileAnalysis {
  const lines = content.split(/\r?\n/);
  const fileSymbol = createFileSymbol(repoRoot, file, lines.length);
  const symbols: SymbolNode[] = [fileSymbol];
  const chunks: CodeChunk[] = [];
  const edges: GraphEdge[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const importSource = importSourceFromLine(lines[index]!);
    if (!importSource) continue;
    edges.push({
      projectId: file.projectId,
      sourceId: fileSymbol.id,
      targetId: stableId([repoRoot, importSource, "module"]),
      kind: "imports",
      metadata: { source: importSource, sourceFile: file.path, line: index + 1, resolution: "python_import" }
    });
  }

  const declarations = declarationsFor(lines);
  for (const declaration of declarations) {
    const symbol = symbolFromDeclaration(repoRoot, file, declaration);
    symbols.push(symbol);
    chunks.push(chunkFromSymbol(repoRoot, file, content, symbol));
    edges.push({
      projectId: file.projectId,
      sourceId: fileSymbol.id,
      targetId: symbol.id,
      kind: "contains",
      metadata: { sourceFile: file.path }
    });
    if (symbol.exported) {
      edges.push({
        projectId: file.projectId,
        sourceId: fileSymbol.id,
        targetId: symbol.id,
        kind: "exports",
        metadata: { sourceFile: file.path, name: symbol.name, resolution: "python_export" }
      });
    }
    for (const call of callsIn(lines.slice(symbol.startLine - 1, symbol.endLine).join("\n"))) {
      edges.push({
        projectId: file.projectId,
        sourceId: symbol.id,
        targetId: stableId([repoRoot, call.name, "symbol"]),
        kind: "calls",
        metadata: { targetName: call.name, sourceFile: file.path, line: symbol.startLine + call.lineOffset, resolution: "python_call" }
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
}

function declarationsFor(lines: string[]): Declaration[] {
  const declarations: Declaration[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const match = /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/.exec(line)
      ?? /^(\s*)class\s+([A-Za-z_]\w*)\b/.exec(line);
    if (!match) continue;
    const indent = match[1]!.length;
    const name = match[2]!;
    const endLine = blockEnd(lines, index, indent);
    declarations.push({
      name,
      kind: /^\s*class\b/.test(line) ? "class" : "function",
      startLine: index + 1,
      endLine,
      signature: line.trim()
    });
  }
  return declarations;
}

function blockEnd(lines: string[], startIndex: number, indent: number): number {
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line.trim()) continue;
    const currentIndent = line.match(/^\s*/)?.[0].length ?? 0;
    if (currentIndent <= indent && /^(?:async\s+)?def\s+|^class\s+/.test(line.trim())) return index;
  }
  return lines.length;
}

function symbolFromDeclaration(repoRoot: string, file: CodeFile, declaration: Declaration): SymbolNode {
  return {
    id: stableId([repoRoot, file.path, declaration.name, declaration.startLine, declaration.endLine, declaration.kind]),
    projectId: file.projectId,
    filePath: file.path,
    name: declaration.name,
    kind: declaration.kind,
    language: "python",
    startLine: declaration.startLine,
    endLine: declaration.endLine,
    signature: declaration.signature,
    exported: !declaration.name.startsWith("_")
  };
}

function chunkFromSymbol(repoRoot: string, file: CodeFile, content: string, symbol: SymbolNode): CodeChunk {
  const lines = content.split(/\r?\n/).slice(symbol.startLine - 1, symbol.endLine);
  const body = lines.join("\n");
  return {
    id: stableId([repoRoot, file.path, symbol.name, symbol.startLine, symbol.endLine, sha256(body)]),
    projectId: file.projectId,
    repoRoot,
    filePath: file.path,
    language: "python",
    kind: symbol.kind === "unknown" ? "block" : symbol.kind,
    symbolName: symbol.name,
    startLine: symbol.startLine,
    endLine: symbol.endLine,
    content: body,
    contentHash: sha256(body)
  };
}

function importSourceFromLine(line: string): string | undefined {
  return /^\s*import\s+([A-Za-z_][\w.]*)/.exec(line)?.[1]
    ?? /^\s*from\s+([A-Za-z_][\w.]*)\s+import\s+/.exec(line)?.[1];
}

function callsIn(content: string): Array<{ name: string; lineOffset: number }> {
  const calls: Array<{ name: string; lineOffset: number }> = [];
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const pattern = /\b([A-Za-z_]\w*)\s*\(/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(line))) {
      const name = match[1]!;
      if (["def", "class", "return", "if", "for", "while"].includes(name)) continue;
      calls.push({ name, lineOffset: index });
    }
  }
  return calls;
}
