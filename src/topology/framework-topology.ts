import path from "node:path";
import ts from "typescript";
import type { CodeFile, GraphEdge, SymbolNode } from "../core/types.js";
import type { TypeScriptSourceFile } from "../lsp/typescript-language-service.js";

interface RouteInfo {
  routePath: string;
  filePath: string;
  symbol: SymbolNode;
  isWebhook: boolean;
}

interface ApiCall {
  url: string;
  line: number;
  resolution: "framework_static" | "framework_wrapper" | "framework_template";
}

export function buildFrameworkTopologyEdges(files: CodeFile[], sources: TypeScriptSourceFile[], symbols: SymbolNode[], edges: GraphEdge[]): GraphEdge[] {
  const routeByPath = new Map<string, RouteInfo>();
  for (const file of files) {
    const routePath = nextRoutePath(file.path);
    if (!routePath) continue;
    const routeSymbol = routeHandlerSymbol(symbols, file.path) ?? fileSymbol(symbols, file.path);
    if (!routeSymbol) continue;
    routeByPath.set(routePath, {
      routePath,
      filePath: file.path,
      symbol: routeSymbol,
      isWebhook: isWebhookRoute(routePath, file.path)
    });
  }

  const frameworkEdges: GraphEdge[] = [];
  frameworkEdges.push(...clientApiEdges(sources, symbols, routeByPath));
  frameworkEdges.push(...routeServiceEdges(edges, symbols, routeByPath));
  frameworkEdges.push(...webhookEdges(routeByPath));
  return dedupeEdges(frameworkEdges);
}

function clientApiEdges(sources: TypeScriptSourceFile[], symbols: SymbolNode[], routes: Map<string, RouteInfo>): GraphEdge[] {
  const edges: GraphEdge[] = [];
  for (const source of sources) {
    if (!isClientSource(source)) continue;
    for (const call of apiCalls(source)) {
      const route = findRoute(routes, call.url);
      if (!route) continue;
      const sourceSymbol = containingSymbol(symbols, source.filePath, call.line) ?? fileSymbol(symbols, source.filePath);
      if (!sourceSymbol) continue;
      edges.push({
        projectId: sourceSymbol.projectId,
        sourceId: sourceSymbol.id,
        targetId: route.symbol.id,
        kind: "calls_api",
        metadata: {
          framework: "nextjs",
          sourceFile: source.filePath,
          targetFile: route.filePath,
          route: route.routePath,
          requestPath: call.url,
          targetName: route.symbol.name,
          line: call.line,
          resolution: call.resolution
        }
      });
    }
  }
  return edges;
}

function routeServiceEdges(edges: GraphEdge[], symbols: SymbolNode[], routes: Map<string, RouteInfo>): GraphEdge[] {
  const routeFiles = new Map([...routes.values()].map((route) => [route.filePath, route]));
  return edges.flatMap((edge) => {
      const sourceFile = typeof edge.metadata?.sourceFile === "string" ? edge.metadata.sourceFile : undefined;
      if (edge.kind !== "calls" || !isResolvedCall(edge) || !sourceFile || !routeFiles.has(sourceFile)) return [];
      const source = symbols.find((symbol) => symbol.id === edge.sourceId);
      const target = symbols.find((symbol) => symbol.id === edge.targetId);
      const route = routeFiles.get(sourceFile);
      return [{
        projectId: edge.projectId,
        sourceId: edge.sourceId,
        targetId: edge.targetId,
        kind: "routes_to" as const,
        metadata: {
          framework: "nextjs",
          sourceFile: source?.filePath ?? edge.metadata?.sourceFile,
          targetFile: target?.filePath ?? edge.metadata?.targetFile,
          route: route?.routePath,
          targetName: target?.name ?? edge.metadata?.targetName,
          line: edge.metadata?.line,
          resolution: "framework_call_graph"
        }
      }];
    });
}

function isResolvedCall(edge: GraphEdge): boolean {
  return edge.metadata?.resolution === "resolved" || edge.metadata?.resolution === "resolved_lsp";
}

function webhookEdges(routes: Map<string, RouteInfo>): GraphEdge[] {
  return [...routes.values()]
    .filter((route) => route.isWebhook)
    .map((route) => ({
      projectId: route.symbol.projectId,
      sourceId: route.symbol.id,
      targetId: route.symbol.id,
      kind: "handles_webhook" as const,
      metadata: {
        framework: "nextjs",
        sourceFile: route.filePath,
        targetFile: route.filePath,
        route: route.routePath,
        targetName: route.symbol.name,
        resolution: "framework_static"
      }
    }));
}

function nextRoutePath(filePath: string): string | undefined {
  const normalized = filePath.replaceAll("\\", "/");
  const match = /(?:^|\/)(?:app|pages)\/api\/(.+)\/route\.[jt]sx?$/.exec(normalized);
  if (match?.[1]) return `/api/${trimRouteSegments(match[1])}`;
  const pagesMatch = /(?:^|\/)pages\/api\/(.+)\.[jt]sx?$/.exec(normalized);
  if (pagesMatch?.[1]) return `/api/${trimRouteSegments(pagesMatch[1])}`;
  return undefined;
}

function trimRouteSegments(route: string): string {
  return route
    .split("/")
    .filter((segment) => segment && !segment.startsWith("("))
    .map((segment) => segment.replace(/^\[(.+)\]$/, ":$1"))
    .join("/");
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

function isClientSource(source: TypeScriptSourceFile): boolean {
  return /\.(tsx|jsx)$/.test(source.filePath) || /^["']use client["'];?/.test(source.content.trimStart()) || /from ['"]react['"]/.test(source.content);
}

function apiCalls(source: TypeScriptSourceFile): ApiCall[] {
  const sourceFile = ts.createSourceFile(source.filePath, source.content, ts.ScriptTarget.Latest, true, scriptKindForPath(source.filePath));
  const calls: ApiCall[] = [];

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const url = apiUrlForCall(node);
      if (url?.url.startsWith("/api/")) {
        calls.push({
          ...url,
          line: lineRange(sourceFile, node).startLine
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sourceFile, visit);
  return calls;
}

function apiUrlForCall(node: ts.CallExpression): Omit<ApiCall, "line"> | undefined {
  const directUrl = node.arguments[0] ? urlFromExpression(node.arguments[0]) : undefined;
  const expression = node.expression;

  if (ts.isIdentifier(expression) && expression.text === "fetch" && directUrl) return directUrl;

  const chain = propertyChain(expression);
  if (chain.length >= 2 && chain[0] === "axios" && httpMethodNames.has(chain[chain.length - 1] ?? "") && directUrl) {
    return { ...directUrl, resolution: directUrl.resolution === "framework_template" ? "framework_template" : "framework_wrapper" };
  }

  const clientUrl = urlFromClientCall(chain);
  if (clientUrl) return clientUrl;

  return undefined;
}

function urlFromExpression(expression: ts.Expression): Omit<ApiCall, "line"> | undefined {
  if (ts.isStringLiteralLike(expression)) return { url: expression.text, resolution: "framework_static" };
  if (ts.isTemplateExpression(expression)) {
    const url = [
      expression.head.text,
      ...expression.templateSpans.flatMap((span) => ["*", span.literal.text])
    ].join("");
    return { url, resolution: "framework_template" };
  }
  return undefined;
}

function urlFromClientCall(chain: string[]): Omit<ApiCall, "line"> | undefined {
  if (chain.length >= 3 && ["api", "apiClient"].includes(chain[0] ?? "")) {
    const resource = chain[1];
    if (resource) return { url: `/api/${resource}`, resolution: "framework_wrapper" };
  }

  const root = chain[0];
  if (chain.length >= 2 && root?.endsWith("Api")) {
    const resource = root.slice(0, -"Api".length);
    if (resource) return { url: `/api/${resource}`, resolution: "framework_wrapper" };
  }

  return undefined;
}

function propertyChain(expression: ts.Expression): string[] {
  if (ts.isIdentifier(expression)) return [expression.text];
  if (ts.isPropertyAccessExpression(expression)) return [...propertyChain(expression.expression), expression.name.text];
  return [];
}

function findRoute(routes: Map<string, RouteInfo>, requestPath: string): RouteInfo | undefined {
  const exact = routes.get(requestPath);
  if (exact) return exact;
  return [...routes.values()].find((route) => routePathMatches(route.routePath, requestPath));
}

function routePathMatches(routePath: string, requestPath: string): boolean {
  const routeSegments = routePath.split("/");
  const requestSegments = requestPath.split("/");
  if (routeSegments.length !== requestSegments.length) return false;
  return routeSegments.every((segment, index) => segment === requestSegments[index] || segment.startsWith(":") || requestSegments[index] === "*");
}

function isWebhookRoute(routePath: string, filePath: string): boolean {
  return /webhook/i.test(routePath) || /webhook/i.test(path.posix.basename(filePath));
}

function lineRange(sourceFile: ts.SourceFile, node: ts.Node): { startLine: number; endLine: number } {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  return { startLine: start.line + 1, endLine: end.line + 1 };
}

function scriptKindForPath(filePath: string): ts.ScriptKind {
  if (filePath.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (filePath.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (filePath.endsWith(".js") || filePath.endsWith(".mjs") || filePath.endsWith(".cjs")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

const httpMethodNames = new Set(["get", "post", "put", "patch", "delete"]);

function dedupeEdges(edges: GraphEdge[]): GraphEdge[] {
  const seen = new Set<string>();
  const deduped: GraphEdge[] = [];
  for (const edge of edges) {
    const key = [edge.kind, edge.sourceId, edge.targetId, edge.metadata?.route, edge.metadata?.requestPath, edge.metadata?.sourceFile, edge.metadata?.line].join("::");
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(edge);
  }
  return deduped;
}
