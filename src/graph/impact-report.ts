import type { EdgeKind, GraphEdge, ImpactAnalysis, ImpactPackItem, ImpactReference, SymbolNode } from "../core/types.js";

export interface ImpactReportInput {
  target: string;
  matchedSymbols: SymbolNode[];
  incomingEdges: GraphEdge[];
  outgoingEdges: GraphEdge[];
  symbols: SymbolNode[];
}

export function buildImpactAnalysis(input: ImpactReportInput): ImpactAnalysis {
  const symbolsById = new Map(input.symbols.map((symbol) => [symbol.id, symbol]));
  const minimalPackByFile = new Map<string, ImpactPackItem>();
  const allEdges = [...input.incomingEdges, ...input.outgoingEdges];

  for (const symbol of input.matchedSymbols) {
    addPackItem(minimalPackByFile, symbol.filePath, "target", `Matched target symbol ${symbol.name}.`, [symbol]);
  }

  for (const edge of input.incomingEdges) {
    const source = symbolsById.get(edge.sourceId);
    const target = symbolsById.get(edge.targetId);
    if (source) addPackItem(minimalPackByFile, source.filePath, roleForIncoming(edge.kind), `Incoming ${edge.kind} reference to target.`, [source]);
    if (target) addPackItem(minimalPackByFile, target.filePath, "target", `Target side of incoming ${edge.kind} reference.`, [target]);
    addMetadataFiles(minimalPackByFile, edge, roleForIncoming(edge.kind), `Incoming ${edge.kind} metadata reference.`);
  }

  for (const edge of input.outgoingEdges) {
    const source = symbolsById.get(edge.sourceId);
    const target = symbolsById.get(edge.targetId);
    if (source) addPackItem(minimalPackByFile, source.filePath, "target", `Source side of outgoing ${edge.kind} reference.`, [source]);
    if (target) addPackItem(minimalPackByFile, target.filePath, roleForOutgoing(edge.kind), `Outgoing ${edge.kind} reference from target.`, [target]);
    addMetadataFiles(minimalPackByFile, edge, roleForOutgoing(edge.kind), `Outgoing ${edge.kind} metadata reference.`);
  }

  const minimalPack = [...minimalPackByFile.values()].sort((a, b) => rolePriority(a.role) - rolePriority(b.role) || a.filePath.localeCompare(b.filePath));
  const references = uniqueReferences(allEdges.map((edge) => impactReference(edge, symbolsById)));
  const impactedFiles = minimalPack.map((item) => item.filePath);
  const riskLevel = riskFor(minimalPack.length, references.length);

  return {
    target: input.target,
    minimalPack,
    references,
    nextQueries: nextQueriesFor(input.target, references),
    matchedSymbols: input.matchedSymbols,
    impactedFiles,
    incomingEdges: input.incomingEdges,
    outgoingEdges: input.outgoingEdges,
    riskLevel
  };
}

export function impactReference(edge: GraphEdge, symbolsById: Map<string, SymbolNode>): ImpactReference {
  const source = symbolsById.get(edge.sourceId);
  const target = symbolsById.get(edge.targetId);
  return {
    edge: edge.kind,
    sourceFile: source?.filePath ?? stringMetadata(edge, "sourceFile"),
    targetFile: target?.filePath ?? stringMetadata(edge, "targetFile"),
    sourceSymbol: source?.name,
    targetSymbol: target?.name,
    targetName: stringMetadata(edge, "targetName"),
    reason: reasonForEdge(edge.kind),
    confidence: confidenceForEdge(edge)
  };
}

function addMetadataFiles(items: Map<string, ImpactPackItem>, edge: GraphEdge, role: ImpactPackItem["role"], reason: string): void {
  const sourceFile = stringMetadata(edge, "sourceFile");
  const targetFile = stringMetadata(edge, "targetFile");
  if (sourceFile) addPackItem(items, sourceFile, role === "test" ? "target" : role, reason, []);
  if (targetFile) addPackItem(items, targetFile, role, reason, []);
}

function addPackItem(items: Map<string, ImpactPackItem>, filePath: string, role: ImpactPackItem["role"], reason: string, symbols: SymbolNode[]): void {
  const existing = items.get(filePath);
  if (!existing) {
    items.set(filePath, {
      filePath,
      role,
      reason,
      symbols: symbols.map(symbolSummary)
    });
    return;
  }
  if (rolePriority(role) < rolePriority(existing.role)) existing.role = role;
  if (existing.reason.length > reason.length) existing.reason = reason;
  const byName = new Map(existing.symbols.map((symbol) => [`${symbol.kind}:${symbol.name}:${symbol.startLine}`, symbol]));
  for (const symbol of symbols.map(symbolSummary)) byName.set(`${symbol.kind}:${symbol.name}:${symbol.startLine}`, symbol);
  existing.symbols = [...byName.values()];
}

function symbolSummary(symbol: SymbolNode): ImpactPackItem["symbols"][number] {
  return {
    name: symbol.name,
    kind: symbol.kind,
    startLine: symbol.startLine,
    endLine: symbol.endLine
  };
}

function roleForIncoming(kind: EdgeKind): ImpactPackItem["role"] {
  if (kind === "calls_api" || kind === "routes_to") return "route";
  if (kind === "tested_by") return "test";
  if (kind === "uses_middleware") return "middleware";
  return "caller";
}

function roleForOutgoing(kind: EdgeKind): ImpactPackItem["role"] {
  if (kind === "tested_by") return "test";
  if (kind === "uses_middleware") return "middleware";
  if (kind === "reads_from" || kind === "writes_to") return "resource_owner";
  if (kind === "handles_event") return "event_owner";
  if (kind === "calls_api" || kind === "routes_to") return "route";
  return "callee";
}

function rolePriority(role: ImpactPackItem["role"]): number {
  if (role === "target") return 0;
  if (role === "test") return 1;
  if (role === "caller" || role === "callee" || role === "route") return 2;
  return 3;
}

function reasonForEdge(kind: EdgeKind): string {
  if (kind === "tested_by") return "Test coverage edge from indexed graph.";
  if (kind === "routes_to") return "Route-to-service edge from indexed topology.";
  if (kind === "calls_api") return "Client-to-API edge from indexed topology.";
  if (kind === "uses_middleware") return "Middleware usage edge from indexed topology.";
  if (kind === "reads_from") return "Resource read edge from indexed topology.";
  if (kind === "writes_to") return "Resource write edge from indexed topology.";
  if (kind === "handles_event") return "Event handler edge from indexed topology.";
  return `Graph ${kind} edge from indexed structure.`;
}

function confidenceForEdge(edge: GraphEdge): ImpactReference["confidence"] {
  if (edge.kind === "tested_by") return "high";
  if (edge.metadata?.resolution === "resolved" || edge.metadata?.resolution === "resolved_lsp") return "high";
  if (edge.metadata?.resolution === "framework_static" || edge.metadata?.resolution === "resource_static" || edge.metadata?.resolution === "event_static") return "high";
  if (edge.metadata?.targetName) return "medium";
  return "low";
}

function nextQueriesFor(target: string, references: ImpactReference[]): string[] {
  const queries = [`get_context ${target}`, `trace_flow ${target}`];
  if (references.some((reference) => reference.edge === "tested_by")) queries.push(`related_tests ${target}`);
  if (references.some((reference) => reference.edge === "reads_from" || reference.edge === "writes_to")) queries.push(`topology_map ${target} data flow`);
  return [...new Set(queries)];
}

function riskFor(fileCount: number, referenceCount: number): ImpactAnalysis["riskLevel"] {
  const score = fileCount + referenceCount;
  return score > 12 ? "high" : score > 4 ? "medium" : "low";
}

function uniqueReferences(references: ImpactReference[]): ImpactReference[] {
  const byKey = new Map<string, ImpactReference>();
  for (const reference of references) {
    byKey.set([reference.edge, reference.sourceFile, reference.targetFile, reference.targetName].join("::"), reference);
  }
  return [...byKey.values()];
}

function stringMetadata(edge: GraphEdge, key: string): string | undefined {
  const value = edge.metadata?.[key];
  return typeof value === "string" ? value : undefined;
}
