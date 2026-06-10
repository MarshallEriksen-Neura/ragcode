import ts from "typescript";
import type { CodeFile, EdgeKind, GraphEdge, SymbolNode } from "../core/types.js";
import type { TypeScriptSourceFile } from "../lsp/typescript-language-service.js";
import { stableId } from "../utils/hash.js";

const PRISMA_READ_OPERATIONS = new Set(["aggregate", "count", "findFirst", "findMany", "findUnique"]);
const PRISMA_WRITE_OPERATIONS = new Set(["create", "createMany", "delete", "deleteMany", "update", "updateMany", "upsert"]);
const DRIZZLE_READ_OPERATIONS = new Set(["from", "select"]);
const DRIZZLE_WRITE_OPERATIONS = new Set(["delete", "insert", "update"]);

interface OrmAccess {
  orm: "prisma" | "drizzle";
  kind: Extract<EdgeKind, "reads_from" | "writes_to">;
  operation: string;
  model: string;
  resource: string;
  dataflowSource?: string;
  dataflowKind?: "request_payload";
}

// Bounded ORM resolver: recognizes the conventional client identifiers `prisma.<model>.<op>()`
// and `db.<op>(<model>)` / `db.select().from(<model>)` only. Renamed clients (e.g. `database`,
// `drizzleDb`) are intentionally out of scope — broadening detection needs a resolver that
// tracks the import binding rather than the literal name, which is deferred (see todo.md D/L4).
export function buildOrmTopologyEdges(repoRoot: string, _files: CodeFile[], sources: TypeScriptSourceFile[], symbols: SymbolNode[]): GraphEdge[] {
  const edges: GraphEdge[] = [];
  for (const source of sources) {
    const sourceFile = parseSourceFile(source);
    const requestPayloadBindings = collectRequestPayloadBindings(sourceFile);

    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node)) {
        const access = annotateDataflow(prismaAccessFromCall(node) ?? drizzleAccessFromCall(node), node, sourceFile, requestPayloadBindings);
        if (access) {
          const line = lineAt(sourceFile, node);
          const sourceSymbol = containingSymbol(symbols, source.filePath, line) ?? fileSymbol(symbols, source.filePath);
          if (sourceSymbol) edges.push(ormEdge(repoRoot, source.filePath, sourceSymbol, access, line));
        }
      }
      ts.forEachChild(node, visit);
    }

    ts.forEachChild(sourceFile, visit);
  }
  return dedupeEdges(edges);
}

function prismaAccessFromCall(node: ts.CallExpression): OrmAccess | undefined {
  if (!ts.isPropertyAccessExpression(node.expression)) return undefined;
  const operation = node.expression.name.text;
  const kind = PRISMA_READ_OPERATIONS.has(operation)
    ? "reads_from"
    : PRISMA_WRITE_OPERATIONS.has(operation)
      ? "writes_to"
      : undefined;
  if (!kind || !ts.isPropertyAccessExpression(node.expression.expression)) return undefined;
  const modelExpression = node.expression.expression;
  if (!ts.isIdentifier(modelExpression.expression) || modelExpression.expression.text !== "prisma") return undefined;
  const model = modelExpression.name.text;
  return { orm: "prisma", kind, operation, model, resource: `prisma.${model}` };
}

function drizzleAccessFromCall(node: ts.CallExpression): OrmAccess | undefined {
  if (!ts.isPropertyAccessExpression(node.expression)) return undefined;
  const operation = node.expression.name.text;

  if (operation === "values" || operation === "set") {
    const writeCall = ts.isCallExpression(node.expression.expression) ? node.expression.expression : undefined;
    const writeAccess = writeCall ? drizzleAccessFromCall(writeCall) : undefined;
    if (writeAccess?.kind === "writes_to") return writeAccess;
  }

  if (DRIZZLE_WRITE_OPERATIONS.has(operation) && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "db") {
    const model = identifierText(node.arguments[0]);
    if (model) return { orm: "drizzle", kind: "writes_to", operation, model, resource: `drizzle.${model}` };
  }

  if (operation === "from") {
    const model = identifierText(node.arguments[0]);
    const selectCall = ts.isCallExpression(node.expression.expression) ? node.expression.expression : undefined;
    if (model && selectCall && isDbSelectCall(selectCall)) {
      return { orm: "drizzle", kind: "reads_from", operation: "select", model, resource: `drizzle.${model}` };
    }
  }

  if (DRIZZLE_READ_OPERATIONS.has(operation) && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "db") {
    return { orm: "drizzle", kind: "reads_from", operation, model: "unknown", resource: "drizzle.unknown" };
  }

  return undefined;
}

function isDbSelectCall(node: ts.CallExpression): boolean {
  return ts.isPropertyAccessExpression(node.expression)
    && ts.isIdentifier(node.expression.expression)
    && node.expression.expression.text === "db"
    && node.expression.name.text === "select";
}

function identifierText(node: ts.Expression | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  return undefined;
}

function ormEdge(repoRoot: string, sourceFile: string, sourceSymbol: SymbolNode, access: OrmAccess, line: number): GraphEdge {
  return {
    projectId: sourceSymbol.projectId,
    sourceId: sourceSymbol.id,
    targetId: stableId([repoRoot, "orm", access.orm, access.model]),
    kind: access.kind,
    metadata: {
      orm: access.orm,
      sourceFile,
      targetName: access.resource,
      resource: access.resource,
      model: access.model,
      operation: access.operation,
      line,
      dataflowSource: access.dataflowSource,
      dataflowKind: access.dataflowKind,
      resolution: access.dataflowSource ? "orm_dataflow" : "orm_static",
      producer: `${access.orm}_resolver`
    }
  };
}

function annotateDataflow(access: OrmAccess | undefined, node: ts.CallExpression, sourceFile: ts.SourceFile, bindings: Set<string>): OrmAccess | undefined {
  if (!access || access.kind !== "writes_to") return access;
  const source = dataflowSourceForCall(node, sourceFile, bindings);
  return source ? { ...access, dataflowSource: source, dataflowKind: "request_payload" } : access;
}

function collectRequestPayloadBindings(sourceFile: ts.SourceFile): Set<string> {
  const bindings = new Set<string>();

  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const initializer = node.initializer.getText(sourceFile);
      if (/\.(body|params|query)\b|\.json\s*\(/.test(initializer)) bindings.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sourceFile, visit);
  return bindings;
}

function dataflowSourceForCall(node: ts.CallExpression, sourceFile: ts.SourceFile, bindings: Set<string>): string | undefined {
  const direct = directRequestPayloadSource(node, sourceFile);
  if (direct) return direct;
  if (bindings.size === 0) return undefined;
  const text = node.getText(sourceFile);
  return [...bindings].find((binding) => new RegExp(`\\b${escapeRegExp(binding)}\\b`).test(text));
}

function directRequestPayloadSource(node: ts.CallExpression, sourceFile: ts.SourceFile): string | undefined {
  for (const argument of node.arguments) {
    const source = requestPayloadExpression(argument, sourceFile);
    if (source) return source;
  }
  return undefined;
}

function requestPayloadExpression(node: ts.Node, sourceFile: ts.SourceFile): string | undefined {
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && ["body", "params", "query"].includes(node.name.text)) {
    return `${node.expression.text}.${node.name.text}`;
  }
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && node.expression.name.text === "json") {
    return `${node.expression.expression.text}.json()`;
  }
  let found: string | undefined;
  node.forEachChild((child) => {
    if (found) return;
    found = requestPayloadExpression(child, sourceFile);
  });
  return found;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseSourceFile(source: TypeScriptSourceFile): ts.SourceFile {
  return ts.createSourceFile(source.filePath, source.content, ts.ScriptTarget.Latest, true, scriptKindForPath(source.filePath));
}

function containingSymbol(symbols: SymbolNode[], filePath: string, line: number): SymbolNode | undefined {
  return symbols
    .filter((symbol) => symbol.filePath === filePath && symbol.kind !== "file" && symbol.startLine <= line && symbol.endLine >= line)
    .sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine))[0];
}

function fileSymbol(symbols: SymbolNode[], filePath: string): SymbolNode | undefined {
  return symbols.find((symbol) => symbol.filePath === filePath && symbol.kind === "file");
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
    const key = [edge.kind, edge.sourceId, edge.targetId, edge.metadata?.operation, edge.metadata?.sourceFile, edge.metadata?.line].join("::");
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(edge);
  }
  return deduped;
}
