import type { ContextPack, ContextRequest, ContextSnippet, DirtyFile, FreshnessReport, GraphEdge, OwnerNode, RelationshipEvidence, SearchHit, TopologyEdge } from "../core/types.js";
import { nextQueriesForMode, resolveContextMode } from "../retrieval/query-planner.js";
import { renderSnippet } from "./snippet-renderer.js";

const DEFAULT_BUDGET_CHARS = 18_000;

export interface ContextBuildMetadata {
  projectId: string;
  repoRoot: string;
  indexedAtMs: number;
  skippedFiles: Array<{ filePath: string; reason: string }>;
  indexGeneration?: number;
  staleFiles?: string[];
  pendingFiles?: string[];
  indexingFiles?: string[];
  dirtyFiles?: DirtyFile[];
  burstMode?: boolean;
  droppedEvents?: number;
}

export class ContextBuilder {
  build(request: ContextRequest, hits: SearchHit[], edges: GraphEdge[] = [], metadata: ContextBuildMetadata): ContextPack {
    const budgetChars = request.budgetChars ?? DEFAULT_BUDGET_CHARS;
    const mode = resolveContextMode(request.query, request.mode);
    const snippets: ContextSnippet[] = [];
    let usedChars = 0;

    for (const hit of hits) {
      const snippet = renderSnippet(hit, request.query, mode);
      const cost = estimateSnippetCost(snippet);
      if (usedChars + cost > budgetChars) continue;
      snippets.push(snippet);
      usedChars += cost;
    }
    const ownerChain = ownerNodes(snippets);
    const ownerPaths = ownerChain.map((owner) => owner.filePath);
    const relationships = relationshipEvidence(edges, ownerPaths);
    const topology = topologyEdges(edges, ownerPaths);
    const confidence = confidenceFor(snippets);

    return {
      query: request.query,
      repoRoot: metadata.repoRoot,
      projectId: metadata.projectId,
      mode,
      answerable: snippets.length > 0,
      confidence,
      brief: briefFor(request.query, mode, confidence, ownerChain),
      freshness: freshnessFor(metadata),
      ownerChain,
      topology,
      snippets,
      relationships,
      nextQueries: nextQueriesForMode(request.query, mode),
      missingEvidence: missingEvidenceFor(snippets, metadata),
      budgetChars,
      usedChars
    };
  }
}

function missingEvidenceFor(snippets: ContextSnippet[], metadata: ContextBuildMetadata): string[] {
  const missing: string[] = [];
  if (snippets.length === 0) missing.push("No indexed context matched the query.");
  if (metadata.staleFiles?.length) missing.push(`Stale indexed files excluded: ${metadata.staleFiles.slice(0, 8).join(", ")}.`);
  if (metadata.pendingFiles?.length) missing.push(`Pending files need indexing: ${metadata.pendingFiles.slice(0, 8).join(", ")}.`);
  if (metadata.burstMode) missing.push(`Watcher burst mode is active; ${metadata.droppedEvents ?? 0} event(s) were dropped or compressed.`);
  return missing;
}

function estimateSnippetCost(snippet: ContextSnippet): number {
  return snippet.filePath.length + snippet.reason.length + snippet.content.length + 80;
}

function confidenceFor(snippets: ContextSnippet[]): ContextPack["confidence"] {
  if (snippets.length >= 3 && (snippets[0]?.score ?? 0) > 1) return "high";
  if (snippets.length > 0) return "medium";
  return "low";
}

function relationshipEvidence(edges: GraphEdge[], ownerChain: string[]): RelationshipEvidence[] {
  if (ownerChain.length === 0) return [];
  const ownerSet = new Set(ownerChain);
  return edges
    .filter((edge) => typeof edge.metadata?.sourceFile === "string" && ownerSet.has(edge.metadata.sourceFile))
    .slice(0, 12)
    .map((edge) => ({
      source: String(edge.metadata?.sourceFile ?? edge.sourceId),
      target: String(edge.metadata?.targetName ?? edge.metadata?.source ?? edge.targetId),
      kind: edge.kind,
      reason: `Graph ${edge.kind} edge from indexed structure`
    }));
}

function ownerNodes(snippets: ContextSnippet[]): OwnerNode[] {
  const byFile = new Map<string, OwnerNode>();
  for (const snippet of snippets) {
    const current = byFile.get(snippet.filePath) ?? {
      filePath: snippet.filePath,
      role: snippet.role,
      reason: snippet.reason,
      score: 0,
      symbols: []
    };
    current.score += snippet.score;
    current.reason = current.reason.length <= snippet.reason.length ? current.reason : snippet.reason;
    addOwnerSymbol(current, snippet);
    byFile.set(snippet.filePath, current);
  }
  return [...byFile.values()].sort((a, b) => b.score - a.score);
}

function addOwnerSymbol(owner: OwnerNode, snippet: ContextSnippet): void {
  const symbol = symbolFromSnippet(snippet);
  if (!symbol) return;
  const key = `${symbol.kind}\0${symbol.name}\0${symbol.startLine}\0${symbol.endLine}`;
  const exists = owner.symbols.some((existing) => `${existing.kind}\0${existing.name}\0${existing.startLine}\0${existing.endLine}` === key);
  if (!exists) owner.symbols.push(symbol);
}

function symbolFromSnippet(snippet: ContextSnippet): OwnerNode["symbols"][number] | undefined {
  const match = /^(function|class|method|type|variable|file):\s+(.+)$/.exec(snippet.role);
  if (!match) return undefined;
  const [, kind, name] = match;
  return {
    name,
    kind,
    startLine: snippet.startLine,
    endLine: snippet.endLine
  };
}

function topologyEdges(edges: GraphEdge[], ownerPaths: string[]): TopologyEdge[] {
  const ownerSet = new Set(ownerPaths);
  const seen = new Set<string>();
  const output: TopologyEdge[] = [];
  const candidates = edges
    .filter((edge) => isTopologyEdge(edge.kind) && typeof edge.metadata?.sourceFile === "string" && ownerSet.has(edge.metadata.sourceFile))
    .sort((a, b) => topologyEdgePriority(b) - topologyEdgePriority(a));

  for (const edge of candidates) {
    const topologyEdge = toTopologyEdge(edge);
    const key = topologyEdgeKey(topologyEdge);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(topologyEdge);
    if (output.length >= 12) break;
  }
  return output;
}

function toTopologyEdge(edge: GraphEdge): TopologyEdge {
  return {
    from: String(edge.metadata?.sourceFile ?? edge.sourceId),
    to: String(edge.metadata?.route ?? edge.metadata?.targetName ?? edge.targetId),
    edge: edge.kind,
    confidence: confidenceForEdge(edge),
    reason: reasonForEdge(edge),
    sourceFile: typeof edge.metadata?.sourceFile === "string" ? edge.metadata.sourceFile : undefined,
    targetFile: typeof edge.metadata?.targetFile === "string" ? edge.metadata.targetFile : undefined
  };
}

function topologyEdgeKey(edge: TopologyEdge): string {
  return [edge.from, edge.to, edge.edge, edge.sourceFile ?? "", edge.targetFile ?? ""].join("\0");
}

function isTopologyEdge(kind: GraphEdge["kind"]): boolean {
  return kind === "calls"
    || kind === "calls_api"
    || kind === "routes_to"
    || kind === "handles_webhook"
    || kind === "handles_event"
    || kind === "tested_by"
    || kind === "uses_middleware"
    || kind === "reads_from"
    || kind === "writes_to";
}

function topologyEdgePriority(edge: GraphEdge): number {
  if (edge.kind === "handles_webhook") return 100;
  if (edge.kind === "calls_api") return 90;
  if (edge.kind === "routes_to") return 85;
  if (edge.kind === "uses_middleware") return 84;
  if (edge.kind === "tested_by") return 82;
  if (edge.kind === "writes_to") return 78;
  if (edge.kind === "reads_from") return 76;
  if (edge.kind === "handles_event") return 74;
  if (edge.metadata?.resolution === "resolved_lsp") return 80;
  if (edge.metadata?.resolution === "resolved") return 75;
  if (edge.kind === "calls") return 20;
  return 10;
}

function confidenceForEdge(edge: GraphEdge): TopologyEdge["confidence"] {
  if (typeof edge.metadata?.framework === "string") return "high";
  if (edge.metadata?.resolution === "test_import") return "high";
  if (edge.metadata?.resolution === "resource_static" || edge.metadata?.resolution === "event_static") return "high";
  if (edge.metadata?.resolution === "resolved" || edge.metadata?.resolution === "resolved_lsp") return "high";
  if (edge.metadata?.targetName) return "medium";
  return "low";
}

function reasonForEdge(edge: GraphEdge): string {
  if (edge.kind === "calls_api") return "Static framework topology edge from client API call to route handler.";
  if (edge.kind === "routes_to") return "Framework route-to-service edge derived from resolved call graph.";
  if (edge.kind === "handles_webhook") return "Framework webhook route recognized from route path.";
  if (edge.kind === "tested_by") return "Test coverage edge derived from a resolved test import.";
  if (edge.kind === "uses_middleware") return "Framework middleware usage edge derived from route and middleware files.";
  if (edge.kind === "reads_from") return "Resource read edge derived from a static data-access call.";
  if (edge.kind === "writes_to") return "Resource write edge derived from a static data-access call.";
  if (edge.kind === "handles_event") return "Event handler edge derived from a static event subscription.";
  if (edge.metadata?.resolution === "resolved") return "Resolved AST import/export call edge.";
  if (edge.metadata?.resolution === "resolved_lsp") return "Resolved TypeScript Language Service definition edge.";
  return "AST call edge; may be unresolved until import/LSP resolution lands.";
}

function freshnessFor(metadata: ContextBuildMetadata): FreshnessReport {
  return {
    projectId: metadata.projectId,
    indexGeneration: metadata.indexGeneration ?? 1,
    indexedAtMs: metadata.indexedAtMs,
    staleFiles: metadata.staleFiles ?? [],
    pendingFiles: metadata.pendingFiles ?? [],
    indexingFiles: metadata.indexingFiles ?? [],
    skippedFiles: metadata.skippedFiles,
    dirtyFiles: metadata.dirtyFiles ?? [],
    burstMode: metadata.burstMode ?? false,
    droppedEvents: metadata.droppedEvents ?? 0
  };
}

function briefFor(query: string, mode: ContextPack["mode"], confidence: ContextPack["confidence"], owners: OwnerNode[]): string {
  const ownerText = owners.length > 0 ? owners.slice(0, 3).map((owner) => owner.filePath).join(", ") : "no indexed owner";
  return `${mode} context for "${query}" (${confidence} confidence). Primary owner evidence: ${ownerText}.`;
}

