import type {
  CodeChunk,
  CoverageSignal,
  CoverageSummary,
  ContextSnippet,
  EditReadiness,
  EdgeKind,
  GraphEdge,
  SubgraphNode,
  SubgraphNodeRole,
  SymbolNode,
  VerifiedCodeSubgraph,
  VerifiedEdgeSource,
  VerifiedSubgraphEdge,
  VerifiedSubgraphMode,
  WhyThisFile
} from "../core/types.js";
import { renderSnippet } from "../context/snippet-renderer.js";

const DEFAULT_BUDGET_CHARS = 10_000;
const DEFAULT_MAX_HOPS = 4;
const MAX_NODES = 32;
const MAX_EDGES = 48;

export interface SubgraphBuildInput {
  query: string;
  repoRoot: string;
  projectId: string;
  mode: VerifiedSubgraphMode;
  seedSymbols: SymbolNode[];
  symbols: SymbolNode[];
  edges: GraphEdge[];
  chunks: CodeChunk[];
  budgetChars?: number;
  maxHops?: number;
  missingEvidence?: string[];
}

export class SubgraphBuilder {
  build(input: SubgraphBuildInput): VerifiedCodeSubgraph {
    const budgetChars = input.budgetChars ?? DEFAULT_BUDGET_CHARS;
    const maxHops = input.maxHops ?? DEFAULT_MAX_HOPS;
    const symbolsById = new Map(input.symbols.map((symbol) => [symbol.id, symbol]));
    const nodes = new Map<string, SubgraphNode>();
    const selectedEdges = new Map<string, VerifiedSubgraphEdge>();
    const pathsByNode = new Map<string, string[]>();
    const pathCostByNode = new Map<string, number>();
    const missingEvidence = [...(input.missingEvidence ?? [])];
    let truncated = false;

    const seedSymbols = uniqueSymbols(input.seedSymbols);
    for (const seed of seedSymbols) {
      const node = nodeFromSymbol(seed, "target", "Matched primary seed symbol.", "high");
      nodes.set(node.id, node);
      pathsByNode.set(node.id, [node.id]);
      pathCostByNode.set(node.id, 0);
    }

    const includeIncoming = input.mode !== "flow";
    const includeOutgoing = true;
    const adjacency = buildAdjacency(input.edges, includeIncoming, includeOutgoing);
    const queue: TraversalState[] = seedSymbols.map((symbol) => ({
      nodeId: symbol.id,
      path: [symbol.id],
      cost: 0,
      hops: 0
    }));

    while (queue.length > 0) {
      const state = popLowestCost(queue);
      if (!state || state.hops >= maxHops) continue;
      if (state.cost > (pathCostByNode.get(state.nodeId) ?? Number.POSITIVE_INFINITY)) continue;
      const candidates = adjacency.get(state.nodeId) ?? [];
      for (const candidate of candidates) {
        if (shouldSkipUnresolvedCall(candidate.edge, symbolsById)) continue;
        const nextNodeId = candidate.direction === "outgoing" ? candidate.edge.targetId : candidate.edge.sourceId;
        const hasSource = nodes.has(candidate.edge.sourceId);
        const hasTarget = nodes.has(candidate.edge.targetId);
        if (((!hasSource || !hasTarget) && nodes.size >= MAX_NODES) || selectedEdges.size >= MAX_EDGES) {
          truncated = true;
          break;
        }

        const edge = verifiedEdge(candidate.edge, symbolsById);
        const edgeKey = edgeKeyFor(edge);
        const sourceRole = nodes.get(candidate.edge.sourceId)?.role ?? roleForSource(candidate.edge, candidate.direction);
        const targetRole = nodes.get(candidate.edge.targetId)?.role ?? roleForTarget(candidate.edge, candidate.direction);
        const source = nodeForEndpoint(candidate.edge, "source", symbolsById, sourceRole);
        const target = nodeForEndpoint(candidate.edge, "target", symbolsById, targetRole);
        mergeNode(nodes, source);
        mergeNode(nodes, target);
        if (!selectedEdges.has(edgeKey)) selectedEdges.set(edgeKey, edge);

        const basePath = pathsByNode.get(state.nodeId) ?? state.path;
        const nextPath = candidate.direction === "outgoing"
          ? [...basePath, nextNodeId]
          : [nextNodeId, ...basePath];
        const nextCost = state.cost + edgeTraversalCost(candidate.edge, edge);
        const existingCost = pathCostByNode.get(nextNodeId) ?? Number.POSITIVE_INFINITY;
        if (nextCost < existingCost || (nextCost === existingCost && nextPath.length < (pathsByNode.get(nextNodeId)?.length ?? Number.POSITIVE_INFINITY))) {
          pathCostByNode.set(nextNodeId, nextCost);
          pathsByNode.set(nextNodeId, nextPath);
          queue.push({ nodeId: nextNodeId, path: nextPath, cost: nextCost, hops: state.hops + 1 });
        }
      }
      if (truncated) break;
    }

    if (seedSymbols.length === 0) {
      missingEvidence.push("No indexed primary owner matched the subgraph seed.");
    }

    const orderedNodes = orderNodes([...nodes.values()], pathsByNode);
    const orderedEdges = orderEdges([...selectedEdges.values()], pathsByNode);
    const paths = materializedPaths(orderedNodes, pathsByNode);
    const usedBeforeSnippets = estimateGraphCost(orderedNodes, orderedEdges, paths, missingEvidence);
    const snippetResult = buildSnippets({
      query: input.query,
      mode: input.mode,
      nodes: orderedNodes,
      chunks: input.chunks,
      budgetChars,
      usedChars: usedBeforeSnippets
    });
    truncated = truncated || snippetResult.truncated;

    const coverage = coverageSignals({
      mode: input.mode,
      seedCount: seedSymbols.length,
      edges: orderedEdges,
      truncated
    });
    missingEvidence.push(...missingFromCoverage(coverage, input.query));
    const answerable = orderedNodes.length > 0;
    const confidence = confidenceFor(answerable, orderedEdges, coverage);
    const coverageSummary = summarizeCoverage(coverage, answerable);
    const whyTheseFiles = summarizeWhyTheseFiles(orderedNodes, orderedEdges);

    return {
      query: input.query,
      repoRoot: input.repoRoot,
      projectId: input.projectId,
      mode: input.mode,
      answerable,
      confidence,
      coverageSummary,
      whyTheseFiles,
      nodes: orderedNodes,
      edges: orderedEdges,
      paths,
      snippets: snippetResult.snippets,
      coverage,
      missingEvidence: [...new Set(missingEvidence)],
      nextQueries: nextQueries(input.query, orderedNodes, coverage),
      budgetChars,
      usedChars: Math.min(budgetChars, usedBeforeSnippets + snippetResult.usedChars)
    };
  }
}

interface CandidateEdge {
  edge: GraphEdge;
  direction: "incoming" | "outgoing";
}

interface TraversalState {
  nodeId: string;
  path: string[];
  cost: number;
  hops: number;
}

function buildAdjacency(edges: GraphEdge[], includeIncoming: boolean, includeOutgoing: boolean): Map<string, CandidateEdge[]> {
  const adjacency = new Map<string, CandidateEdge[]>();
  for (const edge of edges) {
    if (!isSubgraphEdge(edge.kind)) continue;
    if (includeOutgoing) addAdjacent(adjacency, edge.sourceId, { edge, direction: "outgoing" });
    if (includeIncoming) addAdjacent(adjacency, edge.targetId, { edge, direction: "incoming" });
  }
  for (const candidates of adjacency.values()) {
    candidates.sort((a, b) => edgeTraversalCost(a.edge) - edgeTraversalCost(b.edge) || edgeLabel(a.edge).localeCompare(edgeLabel(b.edge)));
  }
  return adjacency;
}

function addAdjacent(adjacency: Map<string, CandidateEdge[]>, nodeId: string, candidate: CandidateEdge): void {
  const candidates = adjacency.get(nodeId) ?? [];
  candidates.push(candidate);
  adjacency.set(nodeId, candidates);
}

function popLowestCost(queue: TraversalState[]): TraversalState | undefined {
  if (queue.length === 0) return undefined;
  let bestIndex = 0;
  for (let index = 1; index < queue.length; index += 1) {
    const best = queue[bestIndex]!;
    const next = queue[index]!;
    if (next.cost < best.cost || (next.cost === best.cost && next.hops < best.hops)) bestIndex = index;
  }
  return queue.splice(bestIndex, 1)[0];
}

function isSubgraphEdge(kind: EdgeKind): boolean {
  return kind === "calls"
    || kind === "calls_api"
    || kind === "routes_to"
    || kind === "tested_by"
    || kind === "uses_middleware"
    || kind === "handles_webhook"
    || kind === "handles_event"
    || kind === "reads_from"
    || kind === "writes_to"
    || kind === "references"
    || kind === "imports"
    || kind === "exports"
    || kind === "contains";
}

function edgePriority(edge: GraphEdge): number {
  if (edge.kind === "calls_api") return 100;
  if (edge.kind === "routes_to") return 95;
  if (edge.kind === "tested_by") return 90;
  if (edge.kind === "handles_webhook") return 88;
  if (edge.kind === "uses_middleware") return 84;
  if (edge.kind === "writes_to") return 78;
  if (edge.kind === "reads_from") return 76;
  if (edge.kind === "handles_event") return 74;
  if (edge.metadata?.resolution === "resolved_lsp") return 72;
  if (edge.metadata?.resolution === "resolved") return 70;
  if (edge.kind === "calls") return 60;
  if (edge.kind === "contains") return 55;
  return 20;
}

function edgeTraversalCost(edge: GraphEdge, verified?: VerifiedSubgraphEdge): number {
  const confidence = verified?.confidence ?? confidenceForEdge(edge, edgeSource(edge), false);
  const confidenceDiscount = confidence === "high" ? 25 : confidence === "medium" ? 12 : 0;
  return Math.max(1, 120 - edgePriority(edge) - confidenceDiscount);
}

function verifiedEdge(edge: GraphEdge, symbolsById: Map<string, SymbolNode>): VerifiedSubgraphEdge {
  const source = symbolsById.get(edge.sourceId);
  const target = symbolsById.get(edge.targetId);
  const sourceFile = source?.filePath ?? stringMetadata(edge, "sourceFile");
  const targetFile = target?.filePath ?? stringMetadata(edge, "targetFile");
  const sourceKind = edgeSource(edge);
  return {
    fromNodeId: edge.sourceId,
    toNodeId: edge.targetId,
    kind: edge.kind,
    confidence: confidenceForEdge(edge, sourceKind, Boolean(target)),
    source: sourceKind,
    reason: reasonForEdge(edge, sourceKind),
    sourceFile,
    targetFile,
    line: numberMetadata(edge, "line"),
    targetName: target?.name ?? stringMetadata(edge, "targetName")
  };
}

function nodeForEndpoint(
  edge: GraphEdge,
  endpoint: "source" | "target",
  symbolsById: Map<string, SymbolNode>,
  role: SubgraphNodeRole
): SubgraphNode {
  const id = endpoint === "source" ? edge.sourceId : edge.targetId;
  const symbol = symbolsById.get(id);
  if (symbol) return nodeFromSymbol(symbol, role, reasonForNodeRole(role, endpoint), confidenceForEdge(edge, edgeSource(edge), true));

  const source = edgeSource(edge);
  const sourceFile = stringMetadata(edge, "sourceFile");
  const targetFile = stringMetadata(edge, "targetFile");
  const targetName = stringMetadata(edge, "targetName");
  const filePath = endpoint === "source"
    ? sourceFile ?? targetFile ?? "external"
    : targetFile ?? sourceFile ?? "external";
  return {
    id,
    filePath,
    symbolName: endpoint === "target" ? targetName : undefined,
    kind: "external",
    role,
    confidence: confidenceForEdge(edge, source, false),
    reason: reasonForNodeRole(role, endpoint),
    citation: {
      filePath,
      line: numberMetadata(edge, "line"),
      symbol: endpoint === "target" ? targetName : undefined,
      source
    }
  };
}

function nodeFromSymbol(symbol: SymbolNode, role: SubgraphNodeRole, reason: string, confidence: SubgraphNode["confidence"]): SubgraphNode {
  return {
    id: symbol.id,
    filePath: symbol.filePath,
    symbolName: symbol.kind === "file" ? undefined : symbol.name,
    kind: symbol.kind,
    role,
    startLine: symbol.startLine,
    endLine: symbol.endLine,
    exported: symbol.exported,
    confidence,
    reason,
    citation: {
      filePath: symbol.filePath,
      line: symbol.startLine,
      symbol: symbol.name,
      source: "ast"
    }
  };
}

function mergeNode(nodes: Map<string, SubgraphNode>, next: SubgraphNode): void {
  const existing = nodes.get(next.id);
  if (!existing) {
    nodes.set(next.id, next);
    return;
  }
  if (rolePriority(next.role) < rolePriority(existing.role)) existing.role = next.role;
  if (confidencePriority(next.confidence) > confidencePriority(existing.confidence)) existing.confidence = next.confidence;
  if (!existing.reason.includes(next.reason)) existing.reason = `${existing.reason} ${next.reason}`;
}

function roleForSource(edge: GraphEdge, direction: CandidateEdge["direction"]): SubgraphNodeRole {
  if (direction === "incoming") return "caller";
  if (edge.kind === "tested_by") return "target";
  return "target";
}

function roleForTarget(edge: GraphEdge, direction: CandidateEdge["direction"]): SubgraphNodeRole {
  if (direction === "incoming") return "target";
  if (edge.kind === "contains") return "callee";
  if (edge.kind === "tested_by") return "test";
  if (edge.kind === "calls_api" || edge.kind === "routes_to" || edge.kind === "handles_webhook") return "route";
  if (edge.kind === "uses_middleware") return "middleware";
  if (edge.kind === "reads_from" || edge.kind === "writes_to") return "resource";
  if (edge.kind === "handles_event") return "event";
  return "callee";
}

function shouldSkipUnresolvedCall(edge: GraphEdge, symbolsById: Map<string, SymbolNode>): boolean {
  if (edge.kind !== "calls") return false;
  if (symbolsById.has(edge.targetId)) return false;
  if (edge.metadata?.resolution === "resolved" || edge.metadata?.resolution === "resolved_lsp") return false;
  return typeof edge.metadata?.targetFile !== "string";
}

function reasonForNodeRole(role: SubgraphNodeRole, endpoint: "source" | "target"): string {
  if (role === "target") return "Primary target or target-side graph endpoint.";
  if (role === "caller") return "Incoming caller discovered through graph traversal.";
  if (role === "test") return "Related test discovered through tested_by edge.";
  if (role === "route") return "Route/API endpoint discovered through framework topology.";
  if (role === "middleware") return "Middleware discovered through framework topology.";
  if (role === "resource") return "Data resource discovered through static resource topology.";
  if (role === "event") return "Event owner discovered through static event topology.";
  return endpoint === "target" ? "Outgoing dependency discovered through graph traversal." : "Graph source endpoint.";
}

function edgeSource(edge: GraphEdge): VerifiedEdgeSource {
  const resolution = stringMetadata(edge, "resolution");
  if (resolution === "resolved_lsp") return "lsp";
  if (resolution === "resolved") return "ast";
  if (resolution === "test_import") return "test_import";
  if (resolution === "resource_static") return "resource_rule";
  if (resolution === "event_static") return "event_rule";
  if (resolution === "framework_static" || resolution === "framework_call_graph" || typeof edge.metadata?.framework === "string") return "framework_rule";
  if (edge.kind === "imports" || edge.kind === "exports" || edge.kind === "contains") return "ast";
  return "heuristic";
}

function confidenceForEdge(edge: GraphEdge, source: VerifiedEdgeSource, resolvedTarget: boolean): VerifiedSubgraphEdge["confidence"] {
  if (source === "lsp" || source === "test_import" || source === "framework_rule") return "high";
  if (source === "ast" && (resolvedTarget || edge.metadata?.resolution === "resolved")) return "high";
  if ((source === "resource_rule" || source === "event_rule") && numberMetadata(edge, "line") !== undefined) return "medium";
  if (stringMetadata(edge, "targetName") || stringMetadata(edge, "targetFile")) return "medium";
  return "low";
}

function reasonForEdge(edge: GraphEdge, source: VerifiedEdgeSource): string {
  if (source === "lsp") return "Resolved TypeScript Language Service edge with line evidence where available.";
  if (source === "test_import") return "Test coverage edge derived from a resolved test import.";
  if (source === "framework_rule") return "Framework topology rule produced this edge.";
  if (source === "resource_rule") return "Static resource access rule produced this edge.";
  if (source === "event_rule") return "Static event subscription rule produced this edge.";
  if (source === "ast") return `AST ${edge.kind} edge from indexed structure.`;
  return "Heuristic or unresolved graph edge; verify before editing.";
}

function buildSnippets(input: {
  query: string;
  mode: VerifiedSubgraphMode;
  nodes: SubgraphNode[];
  chunks: CodeChunk[];
  budgetChars: number;
  usedChars: number;
}): { snippets: ContextSnippet[]; usedChars: number; truncated: boolean } {
  const snippets: ContextSnippet[] = [];
  const usedChunkIds = new Set<string>();
  let usedChars = 0;
  let totalUsed = input.usedChars;
  let truncated = false;
  const contextMode = input.mode === "flow" ? "feature" : input.mode === "debug" ? "debug" : "review";
  const safeQuery = input.query.replace(/\b(full body|full source|entire file|完整|全部源码)\b/gi, "");

  for (const node of input.nodes) {
    const chunk = bestChunkForNode(node, input.chunks);
    if (!chunk || usedChunkIds.has(chunk.id)) continue;
    const snippet = renderSnippet({
      chunk,
      score: scoreForRole(node.role),
      source: "graph",
      reason: `${node.role} node selected by verified subgraph`
    }, safeQuery, contextMode);
    const cost = estimateSnippetCost(snippet);
    if (totalUsed + cost > input.budgetChars) {
      truncated = true;
      continue;
    }
    snippets.push(snippet);
    usedChunkIds.add(chunk.id);
    usedChars += cost;
    totalUsed += cost;
  }
  return { snippets, usedChars, truncated };
}

function bestChunkForNode(node: SubgraphNode, chunks: CodeChunk[]): CodeChunk | undefined {
  const sameFile = chunks.filter((chunk) => chunk.filePath === node.filePath);
  if (sameFile.length === 0) return undefined;
  if (node.symbolName) {
    const exact = sameFile.find((chunk) => chunk.symbolName === node.symbolName);
    if (exact) return exact;
  }
  if (node.startLine !== undefined) {
    const containing = sameFile.find((chunk) => chunk.startLine <= node.startLine! && chunk.endLine >= node.startLine!);
    if (containing) return containing;
  }
  return sameFile[0];
}

function coverageSignals(input: {
  mode: VerifiedSubgraphMode;
  seedCount: number;
  edges: VerifiedSubgraphEdge[];
  truncated: boolean;
}) {
  const inbound = input.edges.filter((edge) => edge.kind === "calls" || edge.kind === "calls_api" || edge.kind === "routes_to");
  const outbound = input.edges.filter((edge) => isFlowKind(edge.kind));
  const tests = input.edges.filter((edge) => edge.kind === "tested_by");
  const unresolved = input.edges.filter((edge) => edge.confidence === "low" || edge.source === "heuristic");
  return [
    {
      name: "primary_owner_found" as const,
      status: input.seedCount > 0 ? "pass" as const : "fail" as const,
      detail: input.seedCount > 0 ? `${input.seedCount} primary seed symbol(s) selected.` : "No primary seed symbol was selected."
    },
    {
      name: "inbound_callers_checked" as const,
      status: input.mode === "flow" || inbound.length > 0 ? "pass" as const : "partial" as const,
      detail: input.mode === "flow" ? "Flow mode does not require inbound caller expansion." : `${inbound.length} inbound/call-chain edge(s) included.`
    },
    {
      name: "outbound_flow_checked" as const,
      status: outbound.length > 0 ? "pass" as const : "partial" as const,
      detail: outbound.length > 0 ? `${outbound.length} outbound flow edge(s) included.` : "No outbound flow edge was found in the selected graph."
    },
    {
      name: "tests_checked" as const,
      status: tests.length > 0 ? "pass" as const : "partial" as const,
      detail: tests.length > 0 ? `${tests.length} tested_by edge(s) included.` : "No tested_by edge was found for selected nodes."
    },
    {
      name: "unresolved_edges_present" as const,
      status: unresolved.length > 0 ? "fail" as const : "pass" as const,
      detail: unresolved.length > 0 ? `${unresolved.length} unresolved or heuristic edge(s) require verification.` : "No low-confidence graph edges were selected."
    },
    {
      name: "budget_truncated" as const,
      status: input.truncated ? "fail" as const : "pass" as const,
      detail: input.truncated ? "The subgraph or snippets were truncated by budget." : "The selected subgraph fit within budget."
    }
  ];
}

function missingFromCoverage(coverage: ReturnType<typeof coverageSignals>, query: string): string[] {
  const missing: string[] = [];
  for (const signal of coverage) {
    if (signal.status === "fail") missing.push(signal.detail);
    if (signal.name === "tests_checked" && signal.status !== "pass") missing.push(`No explicit related test evidence found for "${query}".`);
  }
  return missing;
}

function confidenceFor(answerable: boolean, edges: VerifiedSubgraphEdge[], coverage: ReturnType<typeof coverageSignals>): VerifiedCodeSubgraph["confidence"] {
  if (!answerable) return "low";
  if (coverage.some((signal) => signal.status === "fail")) return "low";
  if (edges.length >= 2 && coverage.every((signal) => signal.status === "pass" || signal.name === "inbound_callers_checked")) return "high";
  return "medium";
}

function nextQueries(query: string, nodes: SubgraphNode[], coverage: ReturnType<typeof coverageSignals>): string[] {
  const queries = new Set<string>();
  for (const node of nodes.slice(0, 5)) {
    queries.add(`expand_node ${node.filePath}${node.symbolName ? `:${node.symbolName}` : ""}`);
  }
  if (coverage.some((signal) => signal.name === "tests_checked" && signal.status !== "pass")) {
    queries.add(`related_tests ${query}`);
  }
  if (coverage.some((signal) => signal.name === "outbound_flow_checked" && signal.status !== "pass")) {
    queries.add(`trace_request_flow ${query}`);
  }
  return [...queries].slice(0, 8);
}

function materializedPaths(nodes: SubgraphNode[], pathsByNode: Map<string, string[]>): string[][] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const paths = [...pathsByNode.values()]
    .filter((path) => path.length > 1)
    .sort((a, b) => b.length - a.length || pathLabel(a, byId).localeCompare(pathLabel(b, byId)))
    .slice(0, 12);
  return paths.map((path) => path.map((nodeId) => labelForNode(byId.get(nodeId), nodeId)));
}

function orderNodes(nodes: SubgraphNode[], pathsByNode: Map<string, string[]>): SubgraphNode[] {
  return nodes.sort((a, b) => rolePriority(a.role) - rolePriority(b.role)
    || (pathsByNode.get(a.id)?.length ?? 99) - (pathsByNode.get(b.id)?.length ?? 99)
    || a.filePath.localeCompare(b.filePath)
    || (a.symbolName ?? "").localeCompare(b.symbolName ?? ""));
}

function orderEdges(edges: VerifiedSubgraphEdge[], pathsByNode: Map<string, string[]>): VerifiedSubgraphEdge[] {
  return edges.sort((a, b) => (pathsByNode.get(a.toNodeId)?.length ?? 99) - (pathsByNode.get(b.toNodeId)?.length ?? 99)
    || edgeKindPriority(a.kind) - edgeKindPriority(b.kind)
    || edgeLabelFromVerified(a).localeCompare(edgeLabelFromVerified(b)));
}

function edgeKeyFor(edge: VerifiedSubgraphEdge): string {
  return [edge.kind, edge.fromNodeId, edge.toNodeId, edge.sourceFile, edge.targetFile, edge.targetName].join("::");
}

function edgeLabel(edge: GraphEdge): string {
  return [edge.kind, stringMetadata(edge, "sourceFile"), stringMetadata(edge, "targetFile"), stringMetadata(edge, "targetName")].join("::");
}

function edgeLabelFromVerified(edge: VerifiedSubgraphEdge): string {
  return [edge.kind, edge.sourceFile, edge.targetFile, edge.targetName].join("::");
}

function pathLabel(path: string[], nodesById: Map<string, SubgraphNode>): string {
  return path.map((nodeId) => labelForNode(nodesById.get(nodeId), nodeId)).join(" -> ");
}

function labelForNode(node: SubgraphNode | undefined, fallback: string): string {
  if (!node) return fallback;
  return `${node.filePath}${node.symbolName ? `:${node.symbolName}` : ""}`;
}

function estimateGraphCost(nodes: SubgraphNode[], edges: VerifiedSubgraphEdge[], paths: string[][], missingEvidence: string[]): number {
  return JSON.stringify({ nodes, edges, paths, missingEvidence }).length;
}

function estimateSnippetCost(snippet: ContextSnippet): number {
  return snippet.filePath.length + snippet.reason.length + snippet.content.length + 80;
}

function scoreForRole(role: SubgraphNodeRole): number {
  if (role === "target") return 3;
  if (role === "test") return 2.6;
  if (role === "caller" || role === "route") return 2.4;
  return 2;
}

function rolePriority(role: SubgraphNodeRole): number {
  if (role === "target") return 0;
  if (role === "caller") return 1;
  if (role === "route") return 2;
  if (role === "callee") return 3;
  if (role === "test") return 4;
  return 5;
}

function confidencePriority(confidence: SubgraphNode["confidence"]): number {
  if (confidence === "high") return 3;
  if (confidence === "medium") return 2;
  return 1;
}

function edgeKindPriority(kind: EdgeKind): number {
  if (kind === "calls_api") return 0;
  if (kind === "routes_to") return 1;
  if (kind === "calls") return 2;
  if (kind === "tested_by") return 3;
  return 4;
}

function isFlowKind(kind: EdgeKind): boolean {
  return kind === "calls"
    || kind === "calls_api"
    || kind === "routes_to"
    || kind === "handles_webhook"
    || kind === "handles_event"
    || kind === "uses_middleware"
    || kind === "reads_from"
    || kind === "writes_to";
}

function summarizeCoverage(coverage: CoverageSignal[], answerable: boolean): CoverageSummary {
  const passed = coverage.filter((signal) => signal.status === "pass").length;
  const partial = coverage.filter((signal) => signal.status === "partial").length;
  const failed = coverage.filter((signal) => signal.status === "fail").length;
  const verdict = editReadinessFor(answerable, failed, partial);
  const summary = summaryForVerdict(verdict, passed, partial, failed);
  return { verdict, summary, passed, partial, failed };
}

function editReadinessFor(answerable: boolean, failed: number, partial: number): EditReadiness {
  if (!answerable || failed > 0) return "not_enough_context";
  if (partial > 1) return "investigate_only";
  return "safe_to_edit_after_reading";
}

function summaryForVerdict(verdict: EditReadiness, passed: number, partial: number, failed: number): string {
  if (verdict === "safe_to_edit_after_reading") return `Edit-ready after reading selected snippets: ${passed} checks passed and no blocking evidence is missing.`;
  if (verdict === "investigate_only") return `Investigate before editing: ${partial} coverage check(s) are partial even though no blocking failure was found.`;
  return `Not enough verified context to edit safely: ${failed} coverage check(s) failed and ${partial} are partial.`;
}

function summarizeWhyTheseFiles(nodes: SubgraphNode[], edges: VerifiedSubgraphEdge[]): WhyThisFile[] {
  const byFile = new Map<string, WhyThisFile>();
  for (const node of nodes) {
    const entry = byFile.get(node.filePath) ?? {
      filePath: node.filePath,
      roles: [],
      confidence: node.confidence,
      reasons: [],
      evidence: []
    };
    if (!entry.roles.includes(node.role)) entry.roles.push(node.role);
    if (!entry.reasons.includes(node.reason)) entry.reasons.push(node.reason);
    if (confidencePriority(node.confidence) > confidencePriority(entry.confidence)) entry.confidence = node.confidence;
    byFile.set(node.filePath, entry);
  }

  for (const edge of edges) {
    for (const filePath of [edge.sourceFile, edge.targetFile]) {
      if (!filePath) continue;
      const entry = byFile.get(filePath);
      if (!entry) continue;
      if (!entry.reasons.includes(edge.reason)) entry.reasons.push(edge.reason);
      if (confidencePriority(edge.confidence) > confidencePriority(entry.confidence)) entry.confidence = edge.confidence;
      entry.evidence.push({
        kind: edge.kind,
        confidence: edge.confidence,
        source: edge.source,
        reason: edge.reason,
        sourceFile: edge.sourceFile,
        targetFile: edge.targetFile,
        line: edge.line,
        targetName: edge.targetName
      });
    }
  }

  return [...byFile.values()]
    .map((entry) => ({
      ...entry,
      roles: entry.roles.sort((a, b) => rolePriority(a) - rolePriority(b)),
      reasons: entry.reasons.slice(0, 6),
      evidence: entry.evidence.slice(0, 8)
    }))
    .sort((a, b) => rolePriority(a.roles[0] ?? "external") - rolePriority(b.roles[0] ?? "external") || a.filePath.localeCompare(b.filePath));
}

function uniqueSymbols(symbols: SymbolNode[]): SymbolNode[] {
  return [...new Map(symbols.map((symbol) => [symbol.id, symbol])).values()];
}

function stringMetadata(edge: GraphEdge, key: string): string | undefined {
  const value = edge.metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

function numberMetadata(edge: GraphEdge, key: string): number | undefined {
  const value = edge.metadata?.[key];
  return typeof value === "number" ? value : undefined;
}
