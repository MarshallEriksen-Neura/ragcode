import path from "node:path";
import type { GraphStore, Indexer, SemanticStore, EmbeddingProvider } from "../core/contracts.js";
import type { CodeFile, GraphEdge, ProjectIdentity, RepoIndex } from "../core/types.js";
import { resolveImportPath } from "../topology/import-resolver.js";
import { chunkFiles, chunkFilesIncremental } from "./chunker.js";
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
    const changedFilePaths = changedFiles.map((file) => file.path);
    const cached = fullReindex
      ? undefined
      : {
        chunks: await this.options.graphStore.getChunks(absoluteRoot),
        symbols: await this.options.graphStore.getSymbols(absoluteRoot),
        edges: await this.options.graphStore.getEdges(absoluteRoot)
      };
    const refreshedFiles = cached
      ? refreshedFilePaths(files, cached.edges, changedFilePaths, deletedFiles)
      : changedFilePaths;
    const filesToAnalyze = files.filter((file) => refreshedFiles.includes(file.path));
    const { chunks, symbols, edges } = cached
      ? await chunkFilesIncremental(absoluteRoot, files, filesToAnalyze, cached)
      : await chunkFiles(absoluteRoot, files);
    const indexedAtMs = Date.now();
    const index: RepoIndex = {
      projectId,
      project: project ? { ...project, lastIndexedAtMs: indexedAtMs } : undefined,
      repoRoot: absoluteRoot,
      indexedAtMs,
      indexGeneration,
      changedFiles: changedFilePaths,
      deletedFiles,
      refreshedFiles,
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
      const semanticNeedsRebuild = await this.options.semanticStore.needsRebuild?.(repoRoot, projectId) ?? false;
      if (index.fullReindex || semanticNeedsRebuild || !this.options.semanticStore.deleteFile) {
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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[ragcode] semantic index skipped: ${message}`);
      // Semantic recall is optional cache acceleration. Graph rows remain the source of truth.
    }
  }
}

function refreshedFilePaths(files: CodeFile[], previousEdges: GraphEdge[], changedFiles: string[], deletedFiles: string[]): string[] {
  const currentPaths = new Set(files.map((file) => file.path));
  const touchedPaths = new Set([...changedFiles, ...deletedFiles]);
  const refreshed = new Set(changedFiles.filter((filePath) => currentPaths.has(filePath)));

  for (const edge of previousEdges) {
    const sourceFile = stringMetadata(edge, "sourceFile");
    if (!sourceFile || !currentPaths.has(sourceFile)) continue;

    const previousTargetFile = stringMetadata(edge, "targetFile");
    if (previousTargetFile && touchedPaths.has(previousTargetFile)) {
      refreshed.add(sourceFile);
      continue;
    }

    const importSource = edge.kind === "imports" ? stringMetadata(edge, "source") : undefined;
    const nextTargetFile = importSource ? resolveImportPath(sourceFile, importSource, files) : undefined;
    if (nextTargetFile && touchedPaths.has(nextTargetFile)) refreshed.add(sourceFile);
  }

  if ([...touchedPaths].some(isMiddlewareFile)) {
    for (const file of files) {
      if (isRouteFile(file.path)) refreshed.add(file.path);
    }
  }

  if ([...touchedPaths].some(isRouteFile)) {
    for (const file of files) {
      if (isTypeScriptLike(file)) refreshed.add(file.path);
    }
  }

  return [...refreshed].sort();
}

function stringMetadata(edge: GraphEdge, key: string): string | undefined {
  const value = edge.metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

function isMiddlewareFile(filePath: string): boolean {
  return /^(src\/)?middleware\.[jt]s$/.test(filePath);
}

function isRouteFile(filePath: string): boolean {
  return /(^|\/)(app\/.+\/route|pages\/api\/.+)\.[jt]sx?$/.test(filePath);
}

function isTypeScriptLike(file: CodeFile): boolean {
  return file.language === "typescript" || file.language === "javascript";
}

