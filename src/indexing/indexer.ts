import path from "node:path";
import type { GraphStore, Indexer, SemanticStore, EmbeddingProvider } from "../core/contracts.js";
import type { CodeFile, GraphEdge, IndexRefreshOptions, ProjectIdentity, RepoIndex } from "../core/types.js";
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

  async indexRepo(repoRoot: string, projectId: string, project?: ProjectIdentity, options: IndexRefreshOptions = {}): Promise<RepoIndex> {
    const absoluteRoot = path.resolve(repoRoot);
    const existingFiles = await this.options.graphStore.getFiles(absoluteRoot).catch(() => []);
    const fullReindex = existingFiles.length === 0;
    const affectedPaths = fullReindex ? undefined : normalizedAffectedFiles(options.affectedFiles);
    const scan = await scanRepo(absoluteRoot, projectId, affectedPaths ? { filePaths: [...affectedPaths] } : {});
    const files = affectedPaths ? mergeAffectedScan(existingFiles, scan.files, affectedPaths) : scan.files;
    const skippedFiles = affectedPaths
      ? mergeSkippedFiles(await this.options.graphStore.getSkippedFiles(absoluteRoot).catch(() => []), scan.skippedFiles, affectedPaths)
      : scan.skippedFiles;
    const existingByPath = new Map(existingFiles.map((file) => [file.path, file]));
    const currentPaths = new Set(files.map((file) => file.path));
    const changedFiles = files.filter((file) => {
      if (affectedPaths && !affectedPaths.has(file.path)) return false;
      return existingByPath.get(file.path)?.contentHash !== file.contentHash;
    });
    const deletedFiles = existingFiles
      .filter((file) => (!affectedPaths || affectedPaths.has(file.path)) && !currentPaths.has(file.path))
      .map((file) => file.path)
      .sort();
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
      affectedFiles: affectedPaths ? [...affectedPaths].sort() : undefined,
      scannedFiles: scan.files.map((file) => file.path).sort(),
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

function normalizedAffectedFiles(filePaths: string[] | undefined): Set<string> | undefined {
  if (!filePaths?.length) return undefined;
  return new Set(filePaths.map((filePath) => filePath.replaceAll("\\", "/")).filter(Boolean));
}

function mergeAffectedScan(existingFiles: CodeFile[], scannedFiles: CodeFile[], affectedPaths: Set<string>): CodeFile[] {
  const merged = new Map<string, CodeFile>();
  for (const file of existingFiles) {
    if (!affectedPaths.has(file.path)) merged.set(file.path, file);
  }
  for (const file of scannedFiles) merged.set(file.path, file);
  return [...merged.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function mergeSkippedFiles(
  existingSkippedFiles: Array<{ filePath: string; reason: string }>,
  scannedSkippedFiles: Array<{ filePath: string; reason: string }>,
  affectedPaths: Set<string>
): Array<{ filePath: string; reason: string }> {
  const merged = new Map<string, { filePath: string; reason: string }>();
  for (const skipped of existingSkippedFiles) {
    if (!affectedPaths.has(skipped.filePath)) merged.set(skipped.filePath, skipped);
  }
  for (const skipped of scannedSkippedFiles) merged.set(skipped.filePath, skipped);
  return [...merged.values()].sort((a, b) => a.filePath.localeCompare(b.filePath));
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

  refreshFrameworkReverseRelations(previousEdges, touchedPaths, currentPaths, refreshed);

  return [...refreshed].sort();
}

function refreshFrameworkReverseRelations(previousEdges: GraphEdge[], touchedPaths: Set<string>, currentPaths: Set<string>, refreshed: Set<string>): void {
  for (const edge of previousEdges) {
    const sourceFile = stringMetadata(edge, "sourceFile");
    if (!sourceFile || !currentPaths.has(sourceFile)) continue;

    const targetFile = stringMetadata(edge, "targetFile");
    if (!targetFile || !touchedPaths.has(targetFile)) continue;

    if (edge.kind === "calls_api" || edge.kind === "routes_to" || edge.kind === "uses_middleware") {
      refreshed.add(sourceFile);
    }
  }
}

function stringMetadata(edge: GraphEdge, key: string): string | undefined {
  const value = edge.metadata?.[key];
  return typeof value === "string" ? value : undefined;
}
