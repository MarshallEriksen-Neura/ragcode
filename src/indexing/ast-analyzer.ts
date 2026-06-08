import ts from "typescript";
import type { CodeChunk, CodeFile, GraphEdge, SymbolKind, SymbolNode } from "../core/types.js";
import { sha256, stableId } from "../utils/hash.js";

export interface FileAnalysis {
  chunks: CodeChunk[];
  symbols: SymbolNode[];
  edges: GraphEdge[];
}

export function analyzeFile(repoRoot: string, file: CodeFile, content: string): FileAnalysis {
  if (file.language !== "typescript" && file.language !== "javascript") {
    return fallbackFileAnalysis(repoRoot, file, content);
  }

  const sourceFile = ts.createSourceFile(
    file.path,
    content,
    ts.ScriptTarget.Latest,
    true,
    scriptKindForPath(file.path)
  );
  const lines = content.split(/\r?\n/);
  const chunks: CodeChunk[] = [];
  const symbols: SymbolNode[] = [];
  const edges: GraphEdge[] = [];
  const fileSymbol = createFileSymbol(repoRoot, file, lines.length);
  symbols.push(fileSymbol);

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const importSource = statement.moduleSpecifier.text;
      edges.push({
        projectId: file.projectId,
        sourceId: fileSymbol.id,
        targetId: stableId([repoRoot, importSource, "module"]),
        kind: "imports",
        metadata: { source: importSource, sourceFile: file.path, line: lineRange(sourceFile, statement).startLine, bindings: importBindings(statement) }
      });
    }
  }

  const symbolStack: SymbolNode[] = [fileSymbol];

  function visit(node: ts.Node): void {
    const symbol = symbolFromNode(repoRoot, file, sourceFile, node);
    if (symbol) {
      if (symbol.kind === "variable" && symbolStack[symbolStack.length - 1]?.kind !== "file" && !symbol.exported) {
        ts.forEachChild(node, visit);
        return;
      }
      symbols.push(symbol);
      chunks.push(chunkFromSymbol(repoRoot, file, sourceFile, content, symbol, node));
      edges.push({
        projectId: file.projectId,
        sourceId: symbolStack[symbolStack.length - 1]?.id ?? fileSymbol.id,
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
          metadata: { sourceFile: file.path, name: symbol.name }
        });
      }
      symbolStack.push(symbol);
      ts.forEachChild(node, visit);
      symbolStack.pop();
      return;
    }

    if (ts.isCallExpression(node)) {
      const targetName = callTargetName(node.expression);
      if (targetName) {
        edges.push({
          projectId: file.projectId,
          sourceId: symbolStack[symbolStack.length - 1]?.id ?? fileSymbol.id,
          targetId: stableId([repoRoot, targetName, "symbol"]),
          kind: "calls",
          metadata: { targetName, sourceFile: file.path, line: lineRange(sourceFile, node).startLine, position: callTargetPosition(node.expression, sourceFile) }
        });
      }
    }

    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sourceFile, visit);

  if (chunks.length === 0) {
    return fallbackFileAnalysis(repoRoot, file, content, fileSymbol);
  }

  return { chunks, symbols, edges };
}

function fallbackFileAnalysis(repoRoot: string, file: CodeFile, content: string, existingFileSymbol?: SymbolNode): FileAnalysis {
  const lines = content.split(/\r?\n/);
  const fileSymbol = existingFileSymbol ?? createFileSymbol(repoRoot, file, lines.length);
  const chunks: CodeChunk[] = [];
  for (let start = 0; start < lines.length; start += 80) {
    const end = Math.min(lines.length, start + 80);
    const chunkContent = lines.slice(start, end).join("\n");
    if (!chunkContent.trim()) continue;
    chunks.push({
      id: stableId([repoRoot, file.path, start + 1, end, sha256(chunkContent)]),
      projectId: file.projectId,
      repoRoot,
      filePath: file.path,
      language: file.language,
      kind: "block",
      startLine: start + 1,
      endLine: end,
      content: chunkContent,
      contentHash: sha256(chunkContent)
    });
  }
  return { chunks, symbols: [fileSymbol], edges: [] };
}

function createFileSymbol(repoRoot: string, file: CodeFile, lineCount: number): SymbolNode {
  return {
    id: stableId([repoRoot, file.path, "file"]),
    projectId: file.projectId,
    filePath: file.path,
    name: file.path,
    kind: "file",
    language: file.language,
    startLine: 1,
    endLine: Math.max(1, lineCount)
  };
}

function symbolFromNode(repoRoot: string, file: CodeFile, sourceFile: ts.SourceFile, node: ts.Node): SymbolNode | undefined {
  const named = nodeName(node);
  if (!named) return undefined;
  const range = lineRange(sourceFile, node);
  const kind = symbolKind(node);
  if (!kind) return undefined;
  return {
    id: stableId([repoRoot, file.path, named, range.startLine, range.endLine, kind]),
    projectId: file.projectId,
    filePath: file.path,
    name: named,
    kind,
    language: file.language,
    startLine: range.startLine,
    endLine: range.endLine,
    signature: firstLine(sourceFile.text.slice(node.getStart(sourceFile), node.getEnd())),
    exported: hasExportModifier(node)
  };
}

function chunkFromSymbol(repoRoot: string, file: CodeFile, sourceFile: ts.SourceFile, content: string, symbol: SymbolNode, node: ts.Node): CodeChunk {
  const body = content.slice(node.getStart(sourceFile), node.getEnd());
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

function nodeName(node: ts.Node): string | undefined {
  if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) && node.name) {
    return node.name.text;
  }
  if (ts.isMethodDeclaration(node) && node.name) {
    return propertyName(node.name);
  }
  if (ts.isVariableStatement(node)) {
    const declaration = node.declarationList.declarations[0];
    if (declaration?.name && ts.isIdentifier(declaration.name)) return declaration.name.text;
  }
  return undefined;
}

function symbolKind(node: ts.Node): SymbolKind | undefined {
  if (ts.isFunctionDeclaration(node)) return "function";
  if (ts.isClassDeclaration(node)) return "class";
  if (ts.isMethodDeclaration(node)) return "method";
  if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return "type";
  if (ts.isVariableStatement(node)) return "variable";
  return undefined;
}

function propertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

function callTargetName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return undefined;
}

function callTargetPosition(expression: ts.Expression, sourceFile: ts.SourceFile): number {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.getStart(sourceFile);
  return expression.getStart(sourceFile);
}

function importBindings(node: ts.ImportDeclaration): Array<{ imported: string; local: string }> {
  const clause = node.importClause;
  if (!clause) return [];
  const bindings: Array<{ imported: string; local: string }> = [];
  if (clause.name) bindings.push({ imported: "default", local: clause.name.text });
  const namedBindings = clause.namedBindings;
  if (namedBindings && ts.isNamedImports(namedBindings)) {
    for (const element of namedBindings.elements) {
      bindings.push({ imported: element.propertyName?.text ?? element.name.text, local: element.name.text });
    }
  }
  return bindings;
}

function hasExportModifier(node: ts.Node): boolean {
  return Boolean(ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
}

function lineRange(sourceFile: ts.SourceFile, node: ts.Node): { startLine: number; endLine: number } {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  return { startLine: start.line + 1, endLine: end.line + 1 };
}

function firstLine(content: string): string {
  return content.split(/\r?\n/, 1)[0]?.trim() ?? "";
}

function scriptKindForPath(filePath: string): ts.ScriptKind {
  if (filePath.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (filePath.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (filePath.endsWith(".js") || filePath.endsWith(".mjs") || filePath.endsWith(".cjs")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}
