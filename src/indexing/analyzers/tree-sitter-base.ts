import Parser from "tree-sitter";
import type { CodeChunk, CodeFile, GraphEdge, SymbolKind, SymbolNode } from "../../core/types.js";
import { sha256, stableId } from "../../utils/hash.js";
import { createFileSymbol } from "./fallback-analyzer.js";
import type { FileAnalysis } from "./types.js";

export interface TreeSitterNodePattern {
  type: string;
  kind: SymbolKind;
  nameField?: string;
  signatureField?: string;
  exportModifierCheck?: (node: Parser.SyntaxNode) => boolean;
}

export interface TreeSitterImportPattern {
  type: string;
  sourceField: string;
  bindingsExtractor?: (node: Parser.SyntaxNode) => Array<{ imported: string; local: string }>;
}

export interface TreeSitterCallPattern {
  type: string;
  nameExtractor: (node: Parser.SyntaxNode) => string | undefined;
}

export interface TreeSitterLanguageConfig {
  symbolPatterns: TreeSitterNodePattern[];
  importPatterns: TreeSitterImportPattern[];
  callPatterns: TreeSitterCallPattern[];
}

export function analyzeWithTreeSitter(
  parser: Parser,
  config: TreeSitterLanguageConfig,
  repoRoot: string,
  file: CodeFile,
  content: string
): FileAnalysis {
  const tree = parser.parse(content);
  const lines = content.split(/\r?\n/);
  const fileSymbol = createFileSymbol(repoRoot, file, lines.length);
  const symbols: SymbolNode[] = [fileSymbol];
  const chunks: CodeChunk[] = [];
  const edges: GraphEdge[] = [];

  // Extract imports
  extractImports(tree.rootNode, config.importPatterns, repoRoot, file, fileSymbol.id, edges);

  // Extract symbols and their relationships
  const symbolStack: SymbolNode[] = [fileSymbol];

  function visit(node: Parser.SyntaxNode): void {
    const symbol = extractSymbol(node, config.symbolPatterns, repoRoot, file, content);

    if (symbol) {
      symbols.push(symbol);
      chunks.push(createChunkFromSymbol(repoRoot, file, content, symbol, node));

      // Containment edge
      edges.push({
        projectId: file.projectId,
        sourceId: symbolStack[symbolStack.length - 1]?.id ?? fileSymbol.id,
        targetId: symbol.id,
        kind: "contains",
        metadata: { sourceFile: file.path }
      });

      // Export edge
      if (symbol.exported) {
        edges.push({
          projectId: file.projectId,
          sourceId: fileSymbol.id,
          targetId: symbol.id,
          kind: "exports",
          metadata: { sourceFile: file.path, name: symbol.name }
        });
      }

      symbolStack.push(symbol);

      // Extract calls within this symbol
      extractCalls(node, config.callPatterns, repoRoot, file, symbol.id, edges);

      for (const child of node.children) {
        visit(child);
      }

      symbolStack.pop();
    } else {
      for (const child of node.children) {
        visit(child);
      }
    }
  }

  visit(tree.rootNode);

  return { chunks, symbols, edges };
}

function extractSymbol(
  node: Parser.SyntaxNode,
  patterns: TreeSitterNodePattern[],
  repoRoot: string,
  file: CodeFile,
  content: string
): SymbolNode | undefined {
  for (const pattern of patterns) {
    if (node.type === pattern.type) {
      const nameNode = pattern.nameField ? node.childForFieldName(pattern.nameField) : null;
      const name = nameNode?.text;

      if (!name) continue;

      const startLine = node.startPosition.row + 1;
      const endLine = node.endPosition.row + 1;
      const signature = extractSignature(node, content);
      const exported = pattern.exportModifierCheck ? pattern.exportModifierCheck(node) : false;

      return {
        id: stableId([repoRoot, file.path, name, startLine, endLine, pattern.kind]),
        projectId: file.projectId,
        filePath: file.path,
        name,
        kind: pattern.kind,
        language: file.language,
        startLine,
        endLine,
        signature,
        exported
      };
    }
  }

  return undefined;
}

function extractImports(
  root: Parser.SyntaxNode,
  patterns: TreeSitterImportPattern[],
  repoRoot: string,
  file: CodeFile,
  fileSymbolId: string,
  edges: GraphEdge[]
): void {
  function visit(node: Parser.SyntaxNode): void {
    for (const pattern of patterns) {
      if (node.type === pattern.type) {
        const sourceNode = node.childForFieldName(pattern.sourceField);
        const source = sourceNode?.text.replace(/['"]/g, "");

        if (source) {
          const bindings = pattern.bindingsExtractor ? pattern.bindingsExtractor(node) : [];
          edges.push({
            projectId: file.projectId,
            sourceId: fileSymbolId,
            targetId: stableId([repoRoot, source, "module"]),
            kind: "imports",
            metadata: {
              source,
              sourceFile: file.path,
              line: node.startPosition.row + 1,
              bindings: bindings.length > 0 ? bindings : undefined
            }
          });
        }
      }
    }

    for (const child of node.children) {
      visit(child);
    }
  }

  visit(root);
}

function extractCalls(
  node: Parser.SyntaxNode,
  patterns: TreeSitterCallPattern[],
  repoRoot: string,
  file: CodeFile,
  symbolId: string,
  edges: GraphEdge[]
): void {
  function visit(node: Parser.SyntaxNode): void {
    for (const pattern of patterns) {
      if (node.type === pattern.type) {
        const targetName = pattern.nameExtractor(node);

        if (targetName) {
          edges.push({
            projectId: file.projectId,
            sourceId: symbolId,
            targetId: stableId([repoRoot, targetName, "symbol"]),
            kind: "calls",
            metadata: {
              targetName,
              sourceFile: file.path,
              line: node.startPosition.row + 1
            }
          });
        }
      }
    }

    for (const child of node.children) {
      visit(child);
    }
  }

  visit(node);
}

function createChunkFromSymbol(
  repoRoot: string,
  file: CodeFile,
  content: string,
  symbol: SymbolNode,
  node: Parser.SyntaxNode
): CodeChunk {
  const body = node.text;

  return {
    id: stableId([repoRoot, file.path, symbol.name, symbol.startLine, symbol.endLine, sha256(body)]),
    projectId: file.projectId,
    repoRoot,
    filePath: file.path,
    language: file.language,
    kind: symbol.kind === "unknown" ? "block" : symbol.kind,
    symbolName: symbol.name,
    startLine: symbol.startLine,
    endLine: symbol.endLine,
    content: body,
    contentHash: sha256(body)
  };
}

function extractSignature(node: Parser.SyntaxNode, content: string): string {
  const start = node.startIndex;
  const firstLineEnd = content.indexOf("\n", start);
  const end = firstLineEnd === -1 ? node.endIndex : Math.min(firstLineEnd, start + 200);
  return content.slice(start, end).trim();
}
