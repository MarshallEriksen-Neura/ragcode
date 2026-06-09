import type { GraphStore } from "../core/contracts.js";
import type { CodeChunk, SearchHit, SearchQuery } from "../core/types.js";
import { isExplicitTestQuery, isTestPath } from "./path-classification.js";
import { applyRankingSignals } from "./ranking-signals.js";
import type { ResolvedContextMode } from "./query-planner.js";
import { buildFileGraph, computeTopologyDistances, graphDegree } from "./topology-distance.js";

export interface GraphRerankerOptions {
  graphStore: GraphStore;
  maxHops?: number;
  maxSeeds?: number;
}

export async function rerankWithGraph(
  hits: SearchHit[],
  query: SearchQuery,
  mode: ResolvedContextMode,
  options: GraphRerankerOptions
): Promise<SearchHit[]> {
  if (hits.length <= 1 || !query.repoRoot) return hits;

  try {
    const [symbols, edges] = await Promise.all([
      options.graphStore.getSymbols(query.repoRoot),
      options.graphStore.getEdges(query.repoRoot)
    ]);
    const scopedSymbols = query.projectId ? symbols.filter((symbol) => symbol.projectId === query.projectId) : symbols;
    const scopedEdges = query.projectId ? edges.filter((edge) => edge.projectId === query.projectId) : edges;
    const graph = buildFileGraph(scopedSymbols, scopedEdges, query.projectId);
    const seedFiles = selectStructuralSeeds(hits, graph, query.query, mode, options.maxSeeds ?? 6);
    if (seedFiles.length === 0) return hits;

    const candidateFiles = hits.map((hit) => hit.chunk.filePath);
    const distances = computeTopologyDistances(graph, seedFiles, candidateFiles, {
      projectId: query.projectId,
      maxHops: options.maxHops ?? 3
    });

    return hits
      .map((hit) => {
        const distance = distances.get(hit.chunk.filePath) ?? inferRelatedTestDistance(hit.chunk.filePath, seedFiles, query.query, mode);
        const signal = applyRankingSignals({
          hit,
          mode,
          query: query.query,
          distance,
          hasStructuralSeeds: seedFiles.length > 0
        });
        return signal.reason
          ? {
            ...hit,
            score: signal.score,
            scoreBreakdown: {
              ...hit.scoreBreakdown,
              graphAdjustment: (hit.scoreBreakdown?.graphAdjustment ?? 0) + signal.adjustment,
              final: signal.score
            },
            reason: `${hit.reason}; ${signal.reason}`
          }
          : hit;
      })
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.chunk.filePath.localeCompare(b.chunk.filePath);
      });
  } catch {
    return hits;
  }
}

function inferRelatedTestDistance(filePath: string, seedFiles: string[], query: string, mode: ResolvedContextMode) {
  if (!isTestPath(filePath)) return undefined;
  if (mode !== "review" && mode !== "debug" && !isExplicitTestQuery(query)) return undefined;

  const testBase = testSubjectName(filePath);
  if (!testBase) return undefined;
  const matchingSeed = seedFiles.find((seedFile) => fileSubjectName(seedFile) === testBase);
  if (!matchingSeed) return undefined;

  return {
    hops: 1,
    edgeKinds: ["tested_by" as const],
    path: [matchingSeed, filePath]
  };
}

function selectStructuralSeeds(
  hits: SearchHit[],
  graph: ReturnType<typeof buildFileGraph>,
  query: string,
  mode: ResolvedContextMode,
  maxSeeds: number
): string[] {
  const explicitTestQuery = isExplicitTestQuery(query);
  const byFile = new Map<string, { chunk: CodeChunk; score: number }>();

  for (const hit of hits) {
    const existing = byFile.get(hit.chunk.filePath);
    if (!existing || hit.score > existing.score) {
      byFile.set(hit.chunk.filePath, { chunk: hit.chunk, score: hit.score });
    }
  }

  return [...byFile.values()]
    .filter(({ chunk }) => isCodeChunk(chunk))
    .filter(({ chunk }) => graphDegree(graph, chunk.filePath) > 0)
    .filter(({ chunk }) => {
      if (!isTestPath(chunk.filePath)) return true;
      return explicitTestQuery && (mode === "review" || mode === "debug");
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.chunk.filePath.localeCompare(b.chunk.filePath);
    })
    .slice(0, maxSeeds)
    .map(({ chunk }) => chunk.filePath);
}

function isCodeChunk(chunk: CodeChunk): boolean {
  return chunk.language !== "markdown" && chunk.language !== "json" && chunk.language !== "unknown";
}

function testSubjectName(filePath: string): string | undefined {
  const base = filePath.split("/").pop()?.replace(/\.[jt]sx?$/, "") ?? "";
  return base.replace(/\.(test|spec)$/i, "") || undefined;
}

function fileSubjectName(filePath: string): string | undefined {
  const base = filePath.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "";
  return base || undefined;
}
