import type { EmbeddingProvider, GraphStore, SemanticStore } from "../core/contracts.js";
import type { SearchHit, SearchQuery } from "../core/types.js";
import { rerankWithGraph } from "./graph-reranker.js";
import { applyModeBoost, resolveContextMode } from "./query-planner.js";

export interface HybridRetrieverOptions {
  graphStore: GraphStore;
  semanticStore: SemanticStore;
  embeddingProvider: EmbeddingProvider;
}

export class HybridRetriever {
  constructor(private readonly options: HybridRetrieverOptions) {}

  async search(query: SearchQuery): Promise<SearchHit[]> {
    const limit = query.limit ?? 20;
    const keywordHits = await this.options.graphStore.searchText({ ...query, limit: limit * 2 });
    const semanticHits = await this.searchSemantic({ ...query, limit: limit * 2 });

    const mode = resolveContextMode(query.query, query.mode);
    const fused = fuseHits([...keywordHits, ...semanticHits].map((hit) => applyModeBoost(hit, mode, query.query)));
    const reranked = await rerankWithGraph(fused, query, mode, { graphStore: this.options.graphStore });
    return reranked.slice(0, limit);
  }

  private async searchSemantic(query: SearchQuery): Promise<SearchHit[]> {
    try {
      return await this.options.semanticStore.search(query, this.options.embeddingProvider);
    } catch {
      return [];
    }
  }
}

export function fuseHits(hits: SearchHit[]): SearchHit[] {
  const byChunk = new Map<string, SearchHit>();
  for (const hit of hits) {
    const existing = byChunk.get(hit.chunk.id);
    if (!existing) {
      byChunk.set(hit.chunk.id, hit);
      continue;
    }

    byChunk.set(hit.chunk.id, {
      ...existing,
      score: existing.score + hit.score,
      source: existing.source === hit.source ? existing.source : "graph",
      reason: `${existing.reason}; ${hit.reason}`
    });
  }

  return [...byChunk.values()].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.chunk.filePath.localeCompare(b.chunk.filePath);
  });
}
