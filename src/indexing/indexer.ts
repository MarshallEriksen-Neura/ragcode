import path from "node:path";
import type { GraphStore, Indexer, SemanticStore, EmbeddingProvider } from "../core/contracts.js";
import type { ProjectIdentity, RepoIndex } from "../core/types.js";
import { chunkFiles } from "./chunker.js";
import { scanRepo } from "./scanner.js";

export interface RepoIndexerOptions {
  graphStore: GraphStore;
  semanticStore: SemanticStore;
  embeddingProvider: EmbeddingProvider;
}

export class RepoIndexer implements Indexer {
  constructor(private readonly options: RepoIndexerOptions) {}

  async indexRepo(repoRoot: string, projectId: string, project?: ProjectIdentity): Promise<RepoIndex> {
    const absoluteRoot = path.resolve(repoRoot);
    const existingFiles = await this.options.graphStore.getFiles(absoluteRoot).catch(() => []);
    const { files, skippedFiles } = await scanRepo(absoluteRoot, projectId);
    const existingByPath = new Map(existingFiles.map((file) => [file.path, file]));
    const currentPaths = new Set(files.map((file) => file.path));
    const changedFiles = files.filter((file) => existingByPath.get(file.path)?.contentHash !== file.contentHash);
    const deletedFiles = existingFiles.filter((file) => !currentPaths.has(file.path)).map((file) => file.path).sort();
    const fullReindex = existingFiles.length === 0;
    const currentGeneration = this.options.graphStore.getIndexGeneration
      ? await this.options.graphStore.getIndexGeneration(absoluteRoot).catch(() => 0)
      : 0;
    const indexGeneration = currentGeneration + 1;
    const { chunks, symbols, edges } = await chunkFiles(absoluteRoot, files);
    const indexedAtMs = Date.now();
    const index: RepoIndex = {
      projectId,
      project: project ? { ...project, lastIndexedAtMs: indexedAtMs } : undefined,
      repoRoot: absoluteRoot,
      indexedAtMs,
      indexGeneration,
      changedFiles: changedFiles.map((file) => file.path),
      deletedFiles,
      fullReindex,
      files,
      chunks,
      symbols,
      edges,
      skippedFiles
    };

    await this.options.graphStore.upsertIndex(index);
    await this.updateSemanticIndex(absoluteRoot, projectId, index);
    return index;
  }

  private async updateSemanticIndex(repoRoot: string, projectId: string, index: RepoIndex): Promise<void> {
    try {
      if (index.fullReindex || !this.options.semanticStore.deleteFile) {
        await this.options.semanticStore.resetRepo(repoRoot);
        await this.options.semanticStore.upsertChunks(index.chunks, this.options.embeddingProvider, index.indexGeneration);
        return;
      }

      const changedOrDeleted = new Set([...index.changedFiles, ...index.deletedFiles]);
      for (const filePath of changedOrDeleted) {
        await this.options.semanticStore.deleteFile(repoRoot, projectId, filePath);
      }

      const changedChunks = index.chunks.filter((chunk) => changedOrDeleted.has(chunk.filePath) && !index.deletedFiles.includes(chunk.filePath));
      await this.options.semanticStore.upsertChunks(changedChunks, this.options.embeddingProvider, index.indexGeneration);
    } catch {
      // Semantic recall is optional cache acceleration. Graph rows remain the source of truth.
    }
  }
}
