import ts from "typescript";
import type { CodeFile, EdgeKind, GraphEdge, SymbolNode } from "../core/types.js";
import type { TypeScriptSourceFile } from "../lsp/typescript-language-service.js";
import { stableId } from "../utils/hash.js";

const READ_OPERATIONS = new Set(["aggregate", "count", "findFirst", "findMany", "findUnique", "get", "query", "read", "select"]);
const WRITE_OPERATIONS = new Set(["create", "createMany", "delete", "deleteMany", "insert", "save", "set", "update", "updateMany", "upsert", "write"]);
const EVENT_OPERATIONS = new Set(["addEventListener", "handle", "listen", "on", "once", "subscribe"]);
const RESOURCE_ROOTS = new Set(["client", "database", "db", "prisma"]);

export function buildRuntimeTopologyEdges(repoRoot: string, files: CodeFile[], sources: TypeScriptSourceFile[], symbols: SymbolNode[]): GraphEdge[] {
  return dedupeEdges([
    ...resourceAccessEdges(repoRoot, sources, symbols),
    ...eventHandlerEdges(repoRoot, sources, symbols),
    ...middlewareUsageEdges(files, symbols)
  ]);
}

function resourceAccessEdges(repoRoot: string, sources: TypeScriptSourceFile[], symbols: SymbolNode[]): GraphEdge[] {
  const edges: GraphEdge[] = [];
  for (const source of sources) {
    const sourceFile = parseSourceFile(source);

    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node)) {
        const access = resourceAccessFromCall(node);
        if (access) {
          const line = lineAt(sourceFile, node);
          const sourceSymbol = containingSymbol(symbols, source.filePath, line) ?? fileSymbol(symbols, source.filePath);
          if (sourceSymbol) {
            edges.push({
              projectId: sourceSymbol.projectId,
              sourceId: sourceSymbol.id,
              targetId: stableId([repoRoot, "resource", access.resource]),
              kind: access.kind,
              metadata: {
                sourceFile: source.filePath,
                targetName: access.resource,
                resource: access.resource,
                operation: access.operation,
                line,
                resolution: "resource_static",
                producer: "typescript_runtime_topology"
              }
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    }

    ts.forEachChild(sourceFile, visit);
  }
  return edges;
}

function eventHandlerEdges(repoRoot: string, sources: TypeScriptSourceFile[], symbols: SymbolNode[]): GraphEdge[] {
  const edges: GraphEdge[] = [];
  for (const source of sources) {
    const sourceFile = parseSourceFile(source);

    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node)) {
        const event = eventFromCall(node);
        if (event) {
          const line = lineAt(sourceFile, node);
          const sourceSymbol = containingSymbol(symbols, source.filePath, line) ?? fileSymbol(symbols, source.filePath);
          if (sourceSymbol) {
            edges.push({
              projectId: sourceSymbol.projectId,
              sourceId: sourceSymbol.id,
              targetId: stableId([repoRoot, "event", event.name]),
              kind: "handles_event",
              metadata: {
                sourceFile: source.filePath,
                targetName: event.name,
                event: event.name,
                operation: event.operation,
                line,
                resolution: "event_static",
                producer: "typescript_runtime_topology"
              }
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    }

    ts.forEachChild(sourceFile, visit);
  }
  return edges;
}

function middlewareUsageEdges(files: CodeFile[], symbols: SymbolNode[]): GraphEdge[] {
  const middlewareFile = files.find((file) => /^(src\/)?middleware\.[jt]s$/.test(file.path));
  if (!middlewareFile) return [];

  const targetSymbol = symbols.find((symbol) => symbol.filePath === middlewareFile.path && symbol.name === "middleware")
    ?? fileSymbol(symbols, middlewareFile.path);
  if (!targetSymbol) return [];

  const edges: GraphEdge[] = [];
  for (const file of files) {
    if (!isRouteFile(file.path)) continue;
    const sourceSymbol = routeHandlerSymbol(symbols, file.path) ?? fileSymbol(symbols, file.path);
    if (!sourceSymbol) continue;
    edges.push({
      projectId: sourceSymbol.projectId,
      sourceId: sourceSymbol.id,
      targetId: targetSymbol.id,
      kind: "uses_middleware",
      metadata: {
        framework: "nextjs",
        sourceFile: file.path,
        targetFile: middlewareFile.path,
        targetName: targetSymbol.name,
        resolution: "framework_static",
        producer: "typescript_runtime_topology"
      }
    });
  }
  return edges;
}

function resourceAccessFromCall(node: ts.CallExpression): { kind: Extract<EdgeKind, "reads_from" | "writes_to">; operation: string; resource: string } | undefined {
  if (!ts.isPropertyAccessExpression(node.expression)) return undefined;
  const operation = node.expression.name.text;
  const kind = READ_OPERATIONS.has(operation)
    ? "reads_from"
    : WRITE_OPERATIONS.has(operation)
      ? "writes_to"
      : undefined;
  if (!kind || !ts.isPropertyAccessExpression(node.expression.expression)) return undefined;

  const resourceExpression = node.expression.expression;
  if (!ts.isIdentifier(resourceExpression.expression)) return undefined;
  const root = resourceExpression.expression.text;
  if (!RESOURCE_ROOTS.has(root)) return undefined;

  return {
    kind,
    operation,
    resource: `${root}.${resourceExpression.name.text}`
  };
}

function eventFromCall(node: ts.CallExpression): { operation: string; name: string } | undefined {
  if (!ts.isPropertyAccessExpression(node.expression)) return undefined;
  const operation = node.expression.name.text;
  if (!EVENT_OPERATIONS.has(operation)) return undefined;

  const eventName = stringLiteralValue(node.arguments[0]);
  if (!eventName) return undefined;
  if (!looksLikeEventReceiver(node.expression.expression) && operation !== "addEventListener") return undefined;

  return { operation, name: eventName };
}

function looksLikeEventReceiver(expression: ts.Expression): boolean {
  const text = expression.getText();
  return /event|emitter|bus|queue|stream|socket|document|window/i.test(text);
}

function stringLiteralValue(node: ts.Node | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

function parseSourceFile(source: TypeScriptSourceFile): ts.SourceFile {
  return ts.createSourceFile(
    source.filePath,
    source.content,
    ts.ScriptTarget.Latest,
    true,
    scriptKindForPath(source.filePath)
  );
}

function routeHandlerSymbol(symbols: SymbolNode[], filePath: string): SymbolNode | undefined {
  return symbols.find((symbol) => symbol.filePath === filePath && ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(symbol.name))
    ?? symbols.find((symbol) => symbol.filePath === filePath && symbol.exported && symbol.kind !== "file");
}

function fileSymbol(symbols: SymbolNode[], filePath: string): SymbolNode | undefined {
  return symbols.find((symbol) => symbol.filePath === filePath && symbol.kind === "file");
}

function containingSymbol(symbols: SymbolNode[], filePath: string, line: number): SymbolNode | undefined {
  return symbols
    .filter((symbol) => symbol.filePath === filePath && symbol.kind !== "file" && symbol.startLine <= line && symbol.endLine >= line)
    .sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine))[0];
}

function isRouteFile(filePath: string): boolean {
  return /(?:^|\/)(?:app|pages)\/api\/.+(?:\/route)?\.[jt]sx?$/.test(filePath.replaceAll("\\", "/"));
}

function lineAt(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function scriptKindForPath(filePath: string): ts.ScriptKind {
  if (filePath.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (filePath.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (filePath.endsWith(".js") || filePath.endsWith(".mjs") || filePath.endsWith(".cjs")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function dedupeEdges(edges: GraphEdge[]): GraphEdge[] {
  const seen = new Set<string>();
  const deduped: GraphEdge[] = [];
  for (const edge of edges) {
    const key = [edge.kind, edge.sourceId, edge.targetId, edge.metadata?.targetName, edge.metadata?.sourceFile].join("::");
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(edge);
  }
  return deduped;
}
