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
    const hits = reranked.filter((hit) => hit.score > 0).slice(0, limit);
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
  for (const hit of rankFusionHits(keywordHits, "keyword")) {
    mergeHit(byChunk, hit);
  }
  for (const hit of rankFusionHits(semanticHits, "semantic")) {
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

// Reciprocal Rank Fusion (Cormack et al. 2009). Fusion depends only on each
// hit's rank within its own source list, not on raw score magnitude — this is
// what lets us combine keyword (bm25, ~thousands) and semantic (cosine, 0..1)
// scores that live on incompatible scales.
//
// Textbook RRF is 1/(k+rank), which tops out around 1/k (~0.016 at k=60) —
// two orders of magnitude below the downstream modeBoost (~0.2-0.65) and
// graphAdjustment (~0.15-2.5) that get *added* to the fused score later. To
// keep the fused score on the same ~0..1 scale those boosts were tuned
// against, we use the order-preserving variant k/(k+rank), which tops out near
// 1.0. Scaling by a constant is monotonic, so it does not change RRF ranking.
const RRF_K = 60;

function rankFusionHits(hits: SearchHit[], label: "keyword" | "semantic"): SearchHit[] {
  return hits.map((hit, index) => {
    const rank = index + 1;
    const score = RRF_K / (RRF_K + rank);
    return {
      ...hit,
      score,
      scoreBreakdown: {
        ...hit.scoreBreakdown,
        [label]: hit.score,
        sourceNormalized: score,
        final: score
      },
      reason: `${hit.reason}; rank fusion ${label} rank ${rank} rrf=${score.toFixed(3)}`
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
