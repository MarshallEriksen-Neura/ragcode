import type { CodeChunk, CodeFile, GraphEdge, SymbolKind, SymbolNode } from "../../core/types.js";
import { sha256, stableId } from "../../utils/hash.js";
import { createFileSymbol, fallbackFileAnalysis } from "./fallback-analyzer.js";
import type { FileAnalysis, LanguageAnalyzer } from "./types.js";

export const goAnalyzer: LanguageAnalyzer = {
  language: "go",
  capabilities: ["symbols", "imports", "exports", "calls", "tests"],
  analyzeFile: ({ repoRoot, file, content }) => analyzeGoFile(repoRoot, file, content)
};

export function analyzeGoFile(repoRoot: string, file: CodeFile, content: string): FileAnalysis {
  const lines = content.split(/\r?\n/);
  const fileSymbol = createFileSymbol(repoRoot, file, lines.length);
  const symbols: SymbolNode[] = [fileSymbol];
  const chunks: CodeChunk[] = [];
  const edges: GraphEdge[] = [];

  for (const imported of importSources(content)) {
    edges.push({
      projectId: file.projectId,
      sourceId: fileSymbol.id,
      targetId: stableId([repoRoot, imported.source, "module"]),
      kind: "imports",
      metadata: { source: imported.source, sourceFile: file.path, line: imported.line, resolution: "go_import" }
    });
  }

  for (const declaration of declarationsFor(lines)) {
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
        metadata: { sourceFile: file.path, name: symbol.name, resolution: "go_export" }
      });
    }
    for (const call of callsIn(lines.slice(symbol.startLine - 1, symbol.endLine).join("\n"))) {
      edges.push({
        projectId: file.projectId,
        sourceId: symbol.id,
        targetId: stableId([repoRoot, call.name, "symbol"]),
        kind: "calls",
        metadata: { targetName: call.name, sourceFile: file.path, line: symbol.startLine + call.lineOffset, resolution: "go_call" }
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
    const functionMatch = /^\s*func\s+(?:\([^)]+\)\s*)?([A-Za-z_]\w*)\s*\(/.exec(line);
    const typeMatch = /^\s*type\s+([A-Za-z_]\w*)\s+(?:struct|interface)\b/.exec(line);
    const name = functionMatch?.[1] ?? typeMatch?.[1];
    if (!name) continue;
    declarations.push({
      name,
      kind: functionMatch ? (line.includes("func (") ? "method" : "function") : "type",
      startLine: index + 1,
      endLine: blockEnd(lines, index),
      signature: line.trim()
    });
  }
  return declarations;
}

function blockEnd(lines: string[], startIndex: number): number {
  let depth = 0;
  let seenOpen = false;
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index]!;
    for (const char of line) {
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
    language: "go",
    startLine: declaration.startLine,
    endLine: declaration.endLine,
    signature: declaration.signature,
    exported: /^[A-Z]/.test(declaration.name)
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
    language: "go",
    kind: symbol.kind === "unknown" ? "block" : symbol.kind,
    symbolName: symbol.name,
    startLine: symbol.startLine,
    endLine: symbol.endLine,
    content: body,
    contentHash: sha256(body)
  };
}

function importSources(content: string): Array<{ source: string; line: number }> {
  const imports: Array<{ source: string; line: number }> = [];
  const lines = content.split(/\r?\n/);
  let inBlock = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (/^\s*import\s*\(/.test(line)) {
      inBlock = true;
      continue;
    }
    if (inBlock && /^\s*\)/.test(line)) {
      inBlock = false;
      continue;
    }
    const source = /^\s*import\s+"([^"]+)"/.exec(line)?.[1]
      ?? (inBlock ? /^\s*(?:[A-Za-z_]\w*\s+)?"([^"]+)"/.exec(line)?.[1] : undefined);
    if (source) imports.push({ source, line: index + 1 });
  }
  return imports;
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
      if (["func", "if", "for", "switch", "return"].includes(name)) continue;
      calls.push({ name, lineOffset: index });
    }
  }
  return calls;
}
