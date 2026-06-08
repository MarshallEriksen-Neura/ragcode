import path from "node:path";
import type { GraphStore, Indexer, SemanticStore, EmbeddingProvider } from "../core/contracts.js";
import type { RepoIndex } from "../core/types.js";
import { chunkFiles } from "./chunker.js";
import { scanRepo } from "./scanner.js";

export interface RepoIndexerOptions {
  graphStore: GraphStore;
  semanticStore: SemanticStore;
  embeddingProvider: EmbeddingProvider;
}

export class RepoIndexer implements Indexer {
  constructor(private readonly options: RepoIndexerOptions) {}

  async indexRepo(repoRoot: string, projectId: string): Promise<RepoIndex> {
    const absoluteRoot = path.resolve(repoRoot);
    const { files, skippedFiles } = await scanRepo(absoluteRoot, projectId);
    const { chunks, symbols, edges } = await chunkFiles(absoluteRoot, files);
    const index: RepoIndex = {
      projectId,
      repoRoot: absoluteRoot,
      indexedAtMs: Date.now(),
      files,
      chunks,
      symbols,
      edges,
      skippedFiles
    };

    await this.options.graphStore.upsertIndex(index);
    await this.updateSemanticIndex(absoluteRoot, chunks);
    return index;
  }

  private async updateSemanticIndex(repoRoot: string, chunks: RepoIndex["chunks"]): Promise<void> {
    try {
      await this.options.semanticStore.resetRepo(repoRoot);
      await this.options.semanticStore.upsertChunks(chunks, this.options.embeddingProvider);
    } catch {
      // Semantic recall is optional cache acceleration. Graph rows remain the source of truth.
    }
  }
}
