import type { EdgeKind, GraphEdge, SymbolNode } from "../core/types.js";

export interface FileNeighbor {
  filePath: string;
  kind: EdgeKind;
}

export interface FileGraph {
  adjacency: Map<string, FileNeighbor[]>;
  incidentKinds: Map<string, EdgeKind[]>;
}

export interface TopologyDistance {
  hops: number;
  edgeKinds: EdgeKind[];
  path: string[];
}

export interface TopologyDistanceOptions {
  projectId?: string;
  maxHops?: number;
}

export function buildFileGraph(symbols: SymbolNode[], edges: GraphEdge[], projectId?: string): FileGraph {
  const scopedSymbols = projectId ? symbols.filter((symbol) => symbol.projectId === projectId) : symbols;
  const symbolById = new Map(scopedSymbols.map((symbol) => [symbol.id, symbol]));
  const adjacency = new Map<string, FileNeighbor[]>();
  const incidentKinds = new Map<string, EdgeKind[]>();

  for (const edge of edges) {
    if (projectId && edge.projectId !== projectId) continue;

    const sourceFile = endpointFile(edge, symbolById, "source");
    const targetFile = endpointFile(edge, symbolById, "target");
    if (!sourceFile && !targetFile) continue;

    if (sourceFile) addIncidentKind(incidentKinds, sourceFile, edge.kind);
    if (targetFile) addIncidentKind(incidentKinds, targetFile, edge.kind);
    if (!sourceFile || !targetFile || sourceFile === targetFile) continue;

    addNeighbor(adjacency, sourceFile, { filePath: targetFile, kind: edge.kind });
    addNeighbor(adjacency, targetFile, { filePath: sourceFile, kind: edge.kind });
  }

  return { adjacency, incidentKinds };
}

export function computeTopologyDistances(
  graph: FileGraph,
  seedFiles: string[],
  candidateFiles: Iterable<string>,
  options: TopologyDistanceOptions = {}
): Map<string, TopologyDistance> {
  const maxHops = options.maxHops ?? 3;
  const candidates = new Set(candidateFiles);
  const distances = new Map<string, TopologyDistance>();
  const visited = new Map<string, TopologyDistance>();
  const queue: TopologyDistance[] = [];

  for (const filePath of unique(seedFiles)) {
    if (!graph.incidentKinds.has(filePath) && !graph.adjacency.has(filePath)) continue;
    const seedDistance: TopologyDistance = {
      hops: 0,
      edgeKinds: strongestKinds(graph.incidentKinds.get(filePath) ?? []),
      path: [filePath]
    };
    visited.set(filePath, seedDistance);
    queue.push(seedDistance);
    if (candidates.has(filePath)) distances.set(filePath, seedDistance);
  }

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];
    const currentFile = current.path[current.path.length - 1];
    if (!currentFile || current.hops >= maxHops) continue;

    for (const neighbor of graph.adjacency.get(currentFile) ?? []) {
      const nextDistance: TopologyDistance = {
        hops: current.hops + 1,
        edgeKinds: [...current.edgeKinds, neighbor.kind],
        path: [...current.path, neighbor.filePath]
      };
      const existing = visited.get(neighbor.filePath);
      if (existing && compareDistance(existing, nextDistance) <= 0) continue;

      visited.set(neighbor.filePath, nextDistance);
      queue.push(nextDistance);
      if (candidates.has(neighbor.filePath)) distances.set(neighbor.filePath, nextDistance);
    }
  }

  return distances;
}

export function graphDegree(graph: FileGraph, filePath: string): number {
  return (graph.adjacency.get(filePath)?.length ?? 0) + (graph.incidentKinds.get(filePath)?.length ?? 0);
}

function endpointFile(edge: GraphEdge, symbolById: Map<string, SymbolNode>, endpoint: "source" | "target"): string | undefined {
  const symbol = symbolById.get(endpoint === "source" ? edge.sourceId : edge.targetId);
  if (symbol) return symbol.filePath;
  const metadataKey = endpoint === "source" ? "sourceFile" : "targetFile";
  const metadataValue = edge.metadata?.[metadataKey];
  return typeof metadataValue === "string" ? metadataValue : undefined;
}

function addNeighbor(adjacency: Map<string, FileNeighbor[]>, from: string, neighbor: FileNeighbor): void {
  const neighbors = adjacency.get(from) ?? [];
  if (!neighbors.some((existing) => existing.filePath === neighbor.filePath && existing.kind === neighbor.kind)) {
    neighbors.push(neighbor);
    adjacency.set(from, neighbors);
  }
}

function addIncidentKind(incidentKinds: Map<string, EdgeKind[]>, filePath: string, kind: EdgeKind): void {
  const kinds = incidentKinds.get(filePath) ?? [];
  if (!kinds.includes(kind)) {
    kinds.push(kind);
    incidentKinds.set(filePath, kinds);
  }
}

function compareDistance(a: TopologyDistance, b: TopologyDistance): number {
  if (a.hops !== b.hops) return a.hops - b.hops;
  return maxEdgeWeight(b.edgeKinds) - maxEdgeWeight(a.edgeKinds);
}

function maxEdgeWeight(kinds: EdgeKind[]): number {
  return Math.max(0, ...kinds.map(edgeKindStrength));
}

function strongestKinds(kinds: EdgeKind[]): EdgeKind[] {
  return [...kinds].sort((a, b) => edgeKindStrength(b) - edgeKindStrength(a)).slice(0, 3);
}

function edgeKindStrength(kind: EdgeKind): number {
  if (kind === "calls" || kind === "calls_api" || kind === "routes_to" || kind === "handles_event" || kind === "handles_webhook") return 1;
  if (kind === "imports" || kind === "exports" || kind === "tested_by") return 0.8;
  if (kind === "reads_from" || kind === "writes_to" || kind === "references") return 0.6;
  if (kind === "contains") return 0.25;
  return 0.2;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
