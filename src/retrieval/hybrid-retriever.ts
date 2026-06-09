import type { EmbeddingProvider, GraphStore, SemanticStore } from "../core/contracts.js";
import type { SearchHit, SearchQuery } from "../core/types.js";
import { rerankWithGraph } from "./graph-reranker.js";
import { applyModeBoost, resolveContextMode } from "./query-planner.js";

export interface HybridRetrieverOptions {
  graphStore: GraphStore;
  semanticStore: SemanticStore;
  embeddingProvider: EmbeddingProvider;
}

export interface HybridSearchDiagnostics {
  keywordHitCount: number;
  semantic: {
    status: "ok" | "failed";
    hitCount: number;
    error?: string;
  };
  fusion: {
    semanticTopNParticipation: number;
  };
}

export interface HybridSearchResult {
  hits: SearchHit[];
  diagnostics: HybridSearchDiagnostics;
}

export class HybridRetriever {
  constructor(private readonly options: HybridRetrieverOptions) {}

  async search(query: SearchQuery): Promise<SearchHit[]> {
    return (await this.searchWithDiagnostics(query)).hits;
  }

  async searchWithDiagnostics(query: SearchQuery): Promise<HybridSearchResult> {
    const limit = query.limit ?? 20;
    const keywordHits = await this.options.graphStore.searchText({ ...query, limit: limit * 2 });
    const semanticResult = await this.searchSemantic({ ...query, limit: limit * 2 });

    const mode = resolveContextMode(query.query, query.mode);
    const fused = fuseHits(keywordHits, semanticResult.hits).map((hit) => applyModeBoost(hit, mode, query.query));
    const reranked = await rerankWithGraph(fused, query, mode, { graphStore: this.options.graphStore });
    const hits = reranked.slice(0, limit);
    return {
      hits,
      diagnostics: {
        keywordHitCount: keywordHits.length,
        semantic: {
          status: semanticResult.error ? "failed" : "ok",
          hitCount: semanticResult.hits.length,
          error: semanticResult.error
        },
        fusion: {
          semanticTopNParticipation: hits.filter(hasSemanticParticipation).length
        }
      }
    };
  }

  private async searchSemantic(query: SearchQuery): Promise<{ hits: SearchHit[]; error?: string }> {
    try {
      return { hits: await this.options.semanticStore.search(query, this.options.embeddingProvider) };
    } catch (error) {
      return { hits: [], error: error instanceof Error ? error.message : String(error) };
    }
  }
}

export function fuseHits(keywordHits: SearchHit[], semanticHits: SearchHit[]): SearchHit[] {
  const byChunk = new Map<string, SearchHit>();
  for (const hit of sourceNormalizedHits(keywordHits, "keyword")) {
    mergeHit(byChunk, hit);
  }
  for (const hit of sourceNormalizedHits(semanticHits, "semantic")) {
    mergeHit(byChunk, hit);
  }

  return [...byChunk.values()].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.chunk.filePath.localeCompare(b.chunk.filePath);
  });
}

export function hasSemanticParticipation(hit: SearchHit): boolean {
  return hit.source === "semantic" || /\bsemantic\b|vector similarity/i.test(hit.reason);
}

function sourceNormalizedHits(hits: SearchHit[], label: "keyword" | "semantic"): SearchHit[] {
  const maxScore = Math.max(0, ...hits.map((hit) => hit.score));
  return hits.map((hit, index) => {
    const rank = index + 1;
    const normalizedScore = maxScore > 0 ? hit.score / maxScore : 0;
    const reciprocalRank = 1 / rank;
    const score = (normalizedScore * 0.75) + (reciprocalRank * 0.75);
    return {
      ...hit,
      score,
      scoreBreakdown: {
        ...hit.scoreBreakdown,
        [label]: hit.score,
        sourceNormalized: score,
        final: score
      },
      reason: `${hit.reason}; rank fusion ${label} rank ${rank} normalized=${normalizedScore.toFixed(3)}`
    };
  });
}

function mergeHit(byChunk: Map<string, SearchHit>, hit: SearchHit): void {
  const existing = byChunk.get(hit.chunk.id);
  if (!existing) {
    byChunk.set(hit.chunk.id, hit);
    return;
  }

  byChunk.set(hit.chunk.id, {
    ...existing,
    score: existing.score + hit.score,
    scoreBreakdown: {
      ...existing.scoreBreakdown,
      ...hit.scoreBreakdown,
      keyword: existing.scoreBreakdown?.keyword ?? hit.scoreBreakdown?.keyword,
      semantic: existing.scoreBreakdown?.semantic ?? hit.scoreBreakdown?.semantic,
      sourceNormalized: (existing.scoreBreakdown?.sourceNormalized ?? existing.score) + (hit.scoreBreakdown?.sourceNormalized ?? hit.score),
      modeBoost: (existing.scoreBreakdown?.modeBoost ?? 0) + (hit.scoreBreakdown?.modeBoost ?? 0),
      graphAdjustment: (existing.scoreBreakdown?.graphAdjustment ?? 0) + (hit.scoreBreakdown?.graphAdjustment ?? 0),
      final: existing.score + hit.score
    },
    source: existing.source === hit.source ? existing.source : "graph",
    reason: `${existing.reason}; ${hit.reason}`
  });
}
