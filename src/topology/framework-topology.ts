import path from "node:path";
import type { CodeFile, GraphEdge, SymbolNode } from "../core/types.js";
import type { TypeScriptSourceFile } from "../lsp/typescript-language-service.js";

interface RouteInfo {
  routePath: string;
  filePath: string;
  symbol: SymbolNode;
  isWebhook: boolean;
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
    for (const call of staticFetchCalls(source.content)) {
      const route = routes.get(call.url);
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
          route: call.url,
          targetName: route.symbol.name,
          line: call.line,
          resolution: "framework_static"
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

function staticFetchCalls(content: string): Array<{ url: string; line: number }> {
  const calls: Array<{ url: string; line: number }> = [];
  const pattern = /\bfetch\s*\(\s*(['"`])([^'"`]+)\1/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content))) {
    const url = match[2];
    if (url?.startsWith("/api/")) calls.push({ url, line: lineAt(content, match.index) });
  }
  return calls;
}

function isWebhookRoute(routePath: string, filePath: string): boolean {
  return /webhook/i.test(routePath) || /webhook/i.test(path.posix.basename(filePath));
}

function lineAt(content: string, position: number): number {
  const safePosition = Math.max(0, Math.min(position, content.length));
  let line = 1;
  for (let index = 0; index < safePosition; index += 1) {
    if (content.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

function dedupeEdges(edges: GraphEdge[]): GraphEdge[] {
  const seen = new Set<string>();
  const deduped: GraphEdge[] = [];
  for (const edge of edges) {
    const key = [edge.kind, edge.sourceId, edge.targetId, edge.metadata?.route, edge.metadata?.sourceFile].join("::");
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(edge);
  }
  return deduped;
}
