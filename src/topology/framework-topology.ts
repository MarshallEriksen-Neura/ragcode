import path from "node:path";
import ts from "typescript";
import type { CodeFile, GraphEdge, SymbolNode } from "../core/types.js";
import type { TypeScriptSourceFile } from "../lsp/typescript-language-service.js";

interface RouteInfo {
  framework: string;
  routePath: string;
  routeFile: string;
  filePath: string;
  symbol: SymbolNode;
  isWebhook: boolean;
}

interface ApiCall {
  url: string;
  line: number;
  resolution: "framework_static" | "framework_wrapper" | "framework_template" | "framework_dataflow";
}

interface FrameworkResolverContext {
  files: CodeFile[];
  sources: TypeScriptSourceFile[];
  symbols: SymbolNode[];
  edges: GraphEdge[];
}

interface FrameworkResolver {
  name: string;
  routes(context: FrameworkResolverContext): RouteInfo[];
}

export function buildFrameworkTopologyEdges(files: CodeFile[], sources: TypeScriptSourceFile[], symbols: SymbolNode[], edges: GraphEdge[]): GraphEdge[] {
  const context: FrameworkResolverContext = { files, sources, symbols, edges };
  const routes = frameworkResolvers.flatMap((resolver) => resolver.routes(context));
  const frameworkEdges: GraphEdge[] = [];
  frameworkEdges.push(...clientApiEdges(sources, symbols, routes));
  frameworkEdges.push(...routeServiceEdges(edges, symbols, routes));
  frameworkEdges.push(...webhookEdges(routes));
  return dedupeEdges(frameworkEdges);
}

const nextJsResolver: FrameworkResolver = {
  name: "nextjs",
  routes: ({ files, symbols }) => {
    const routes: RouteInfo[] = [];
    for (const file of files) {
      const routePath = nextRoutePath(file.path);
      if (!routePath) continue;
      const routeSymbol = routeHandlerSymbol(symbols, file.path) ?? fileSymbol(symbols, file.path);
      if (!routeSymbol) continue;
      routes.push({
        framework: "nextjs",
        routePath,
        routeFile: file.path,
        filePath: file.path,
        symbol: routeSymbol,
        isWebhook: isWebhookRoute(routePath, file.path)
      });
    }
    return routes;
  }
};

const expressResolver: FrameworkResolver = {
  name: "express",
  routes: ({ sources, symbols }) => sources
    .filter((source) => importsPackage(source.content, "express"))
    .flatMap((source) => routeDefinitions(source, symbols, "express"))
};

const fastifyResolver: FrameworkResolver = {
  name: "fastify",
  routes: ({ sources, symbols }) => sources
    .filter((source) => importsPackage(source.content, "fastify"))
    .flatMap((source) => routeDefinitions(source, symbols, "fastify"))
};

const frameworkResolvers: FrameworkResolver[] = [
  nextJsResolver,
  expressResolver,
  fastifyResolver
];

function clientApiEdges(sources: TypeScriptSourceFile[], symbols: SymbolNode[], routes: RouteInfo[]): GraphEdge[] {
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
          framework: route.framework,
          sourceFile: source.filePath,
          targetFile: route.filePath,
          routeFile: route.routeFile,
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

function routeServiceEdges(edges: GraphEdge[], symbols: SymbolNode[], routes: RouteInfo[]): GraphEdge[] {
  const routeFiles = new Map(routes.map((route) => [route.routeFile, route]));
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
        framework: route?.framework,
        sourceFile: source?.filePath ?? edge.metadata?.sourceFile,
        targetFile: target?.filePath ?? edge.metadata?.targetFile,
        routeFile: route?.routeFile,
        route: route?.routePath,
        targetName: target?.name ?? edge.metadata?.targetName,
        line: edge.metadata?.line,
        resolution: "framework_call_graph"
      }
    }];
  });
}

function webhookEdges(routes: RouteInfo[]): GraphEdge[] {
  return routes
    .filter((route) => route.isWebhook)
    .map((route) => ({
      projectId: route.symbol.projectId,
      sourceId: route.symbol.id,
      targetId: route.symbol.id,
      kind: "handles_webhook" as const,
      metadata: {
        framework: route.framework,
        sourceFile: route.filePath,
        targetFile: route.filePath,
        routeFile: route.routeFile,
        route: route.routePath,
        targetName: route.symbol.name,
        resolution: "framework_static"
      }
    }));
}

function routeDefinitions(source: TypeScriptSourceFile, symbols: SymbolNode[], framework: string): RouteInfo[] {
  const sourceFile = parseSourceFile(source);
  const routes: RouteInfo[] = [];

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const definition = routeDefinitionFromCall(node, sourceFile, source, symbols, framework);
      if (definition) routes.push(definition);
    }
    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sourceFile, visit);
  return routes;
}

function routeDefinitionFromCall(
  node: ts.CallExpression,
  sourceFile: ts.SourceFile,
  source: TypeScriptSourceFile,
  symbols: SymbolNode[],
  framework: string
): RouteInfo | undefined {
  if (!ts.isPropertyAccessExpression(node.expression)) return undefined;
  const method = node.expression.name.text;
  if (!httpMethodNames.has(method)) return undefined;
  const routePath = stringLiteralValue(node.arguments[0]);
  const handler = node.arguments[1];
  if (!routePath?.startsWith("/") || !handler || !looksLikeRouteHandler(handler)) return undefined;
  const line = lineRange(sourceFile, node).startLine;
  const symbol = routeHandlerFromArgument(handler, symbols, source.filePath, line) ?? containingSymbol(symbols, source.filePath, line) ?? fileSymbol(symbols, source.filePath);
  if (!symbol) return undefined;
  return {
    framework,
    routePath,
    routeFile: source.filePath,
    filePath: symbol.filePath,
    symbol,
    isWebhook: isWebhookRoute(routePath, symbol.filePath)
  };
}

function routeHandlerFromArgument(node: ts.Expression, symbols: SymbolNode[], filePath: string, line: number): SymbolNode | undefined {
  if (ts.isIdentifier(node)) {
    return symbols.find((symbol) => symbol.name === node.text && symbol.kind !== "file")
      ?? containingSymbol(symbols, filePath, line);
  }
  if (ts.isPropertyAccessExpression(node)) {
    return symbols.find((symbol) => symbol.name === node.name.text && symbol.kind !== "file")
      ?? containingSymbol(symbols, filePath, line);
  }
  return containingSymbol(symbols, filePath, line);
}

function looksLikeRouteHandler(node: ts.Expression): boolean {
  return ts.isIdentifier(node)
    || ts.isPropertyAccessExpression(node)
    || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node);
}

function importsPackage(content: string, packageName: string): boolean {
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`from ['\"]${escaped}['\"]|require\\(['\"]${escaped}['\"]\\)`).test(content);
}

function isResolvedCall(edge: GraphEdge): boolean {
  return edge.metadata?.resolution === "resolved" || edge.metadata?.resolution === "resolved_lsp";
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
  const sourceFile = parseSourceFile(source);
  const stringConstants = collectStringConstants(sourceFile);
  const calls: ApiCall[] = [];

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const url = apiUrlForCall(node, stringConstants);
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

function apiUrlForCall(node: ts.CallExpression, stringConstants: Map<string, string>): Omit<ApiCall, "line"> | undefined {
  const directUrl = node.arguments[0] ? urlFromExpression(node.arguments[0], stringConstants) : undefined;
  const expression = node.expression;

  if (ts.isIdentifier(expression) && expression.text === "fetch" && directUrl) return directUrl;

  const chain = propertyChain(expression);
  if (chain.length >= 2 && chain[0] === "axios" && httpMethodNames.has(chain[chain.length - 1] ?? "") && directUrl) {
    return {
      ...directUrl,
      resolution: directUrl.resolution === "framework_template"
        ? "framework_template"
        : directUrl.resolution === "framework_dataflow"
          ? "framework_dataflow"
          : "framework_wrapper"
    };
  }

  const clientUrl = urlFromClientCall(chain);
  if (clientUrl) return clientUrl;

  return undefined;
}

function urlFromExpression(expression: ts.Expression, stringConstants: Map<string, string>): Omit<ApiCall, "line"> | undefined {
  if (ts.isStringLiteralLike(expression)) return { url: expression.text, resolution: "framework_static" };
  if (ts.isIdentifier(expression)) {
    const value = stringConstants.get(expression.text);
    return value ? { url: value, resolution: "framework_dataflow" } : undefined;
  }
  if (ts.isTemplateExpression(expression)) {
    const result = templateStringValue(expression, stringConstants);
    return {
      url: result.value,
      resolution: result.resolved ? "framework_dataflow" : "framework_template"
    };
  }
  return undefined;
}

function collectStringConstants(sourceFile: ts.SourceFile): Map<string, string> {
  const constants = new Map<string, string>();

  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const value = stringValueFromExpression(node.initializer, constants);
      if (value !== undefined) constants.set(node.name.text, value);
    }
    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sourceFile, visit);
  return constants;
}

function stringValueFromExpression(expression: ts.Expression, constants: Map<string, string>): string | undefined {
  if (ts.isStringLiteralLike(expression)) return expression.text;
  if (ts.isIdentifier(expression)) return constants.get(expression.text);
  if (ts.isTemplateExpression(expression)) {
    const result = templateStringValue(expression, constants);
    return result.resolved ? result.value : undefined;
  }
  if (ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text;
  return undefined;
}

function templateStringValue(expression: ts.TemplateExpression, constants: Map<string, string>): { value: string; resolved: boolean } {
  let resolved = true;
  let value = expression.head.text;
  for (const span of expression.templateSpans) {
    const part = stringValueFromExpression(span.expression, constants);
    if (part === undefined) {
      resolved = false;
      value += "*";
    } else {
      value += part;
    }
    value += span.literal.text;
  }
  return { value, resolved };
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

function findRoute(routes: RouteInfo[], requestPath: string): RouteInfo | undefined {
  const exact = routes.find((route) => route.routePath === requestPath);
  if (exact) return exact;
  return routes.find((route) => routePathMatches(route.routePath, requestPath));
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

function stringLiteralValue(node: ts.Node | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

function parseSourceFile(source: TypeScriptSourceFile): ts.SourceFile {
  return ts.createSourceFile(source.filePath, source.content, ts.ScriptTarget.Latest, true, scriptKindForPath(source.filePath));
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
    const key = [edge.kind, edge.sourceId, edge.targetId, edge.metadata?.framework, edge.metadata?.route, edge.metadata?.requestPath, edge.metadata?.sourceFile, edge.metadata?.line].join("::");
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(edge);
  }
  return deduped;
}
