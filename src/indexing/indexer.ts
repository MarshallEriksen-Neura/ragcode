import path from "node:path";
import fs from "node:fs/promises";
import type { GraphStore, Indexer, SemanticStore, EmbeddingProvider } from "../core/contracts.js";
import type { CodeChunk, CodeFile, EdgeKind, GraphEdge, IndexProgressEvent, IndexRefreshOptions, ProjectIdentity, RepoIndex, SymbolNode } from "../core/types.js";
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
    emitProgress(options, { phase: "loading_existing_index", message: "Loading existing index" });
    const existingFiles = await this.options.graphStore.getFiles(absoluteRoot).catch(() => []);
    const requestedAffectedPaths = normalizedAffectedFiles(options.affectedFiles);
    const partialBootstrap = existingFiles.length === 0 && requestedAffectedPaths !== undefined;
    const fullReindex = existingFiles.length === 0 && !partialBootstrap;
    const affectedPaths = fullReindex ? undefined : requestedAffectedPaths;
    emitProgress(options, {
      phase: affectedPaths ? "scanning_batch" : "scanning_inventory",
      message: affectedPaths ? "Scanning affected file batch" : "Scanning repository inventory",
      partialBootstrap
    });
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
    const touchedFilePaths = [...changedFilePaths, ...deletedFiles].sort();
    const currentFilePathList = files.map((file) => file.path);
    const directSeedEdges = existingFiles.length === 0 || fullReindex
      ? []
      : await this.loadEdgesForFiles(absoluteRoot, touchedFilePaths);
    const refreshedFiles = existingFiles.length === 0 || fullReindex
      ? changedFilePaths
      : refreshedFilePaths(files, directSeedEdges, changedFilePaths, deletedFiles);
    const importTargetPaths = existingFiles.length === 0 || fullReindex
      ? []
      : await localImportTargetPaths(files, refreshedFiles);
    const routeCatalogEdges = existingFiles.length === 0 || fullReindex
      ? []
      : await this.loadFrameworkRouteEdges(absoluteRoot, files, [...new Set([...touchedFilePaths, ...refreshedFiles, ...importTargetPaths])]);
    const cacheSeedEdges = [...directSeedEdges, ...routeCatalogEdges];
    const cacheFilePaths = existingFiles.length === 0 || fullReindex
      ? []
      : cachePathsForIncremental(files, cacheSeedEdges, changedFilePaths, deletedFiles, refreshedFiles, importTargetPaths);
    const cached = existingFiles.length === 0 || fullReindex
      ? undefined
      : {
        chunks: await this.loadChunksForFiles(absoluteRoot, cacheFilePaths),
        symbols: await this.loadSymbolsForFiles(absoluteRoot, cacheFilePaths),
        edges: await this.loadEdgesForFiles(absoluteRoot, cacheFilePaths)
      };
    const filesToAnalyze = files.filter((file) => refreshedFiles.includes(file.path));
    assertMemoryWithinLimit(options, "before analysis");
    emitProgress(options, {
      phase: affectedPaths ? "analyzing_batch" : "analyzing",
      message: cached ? "Analyzing changed graph slice" : partialBootstrap ? "Analyzing bootstrap batch" : "Analyzing full repository",
      scannedFiles: scan.files.length,
      changedFiles: changedFilePaths.length,
      deletedFiles: deletedFiles.length,
      refreshedFiles: refreshedFiles.length,
      partialBootstrap
    });
    const chunking = cached
      ? await chunkFilesIncremental(absoluteRoot, files, filesToAnalyze, cached)
      : await chunkFiles(absoluteRoot, files);
    assertMemoryWithinLimit(options, "after analysis");
    const { chunks, symbols, edges } = chunking;
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
      partialBootstrap,
      partialGraphSnapshot: Boolean(cached),
      semanticDeferred: shouldDeferSemantic(indexOptionsForSemantic(options), partialBootstrap),
      scannedFiles: scan.files.map((file) => file.path).sort(),
      refreshedFiles,
      fullReindex,
      files,
      chunks,
      symbols,
      edges,
      skippedFiles,
      analysisWarnings: chunking.warnings
    };

    emitProgress(options, {
      phase: affectedPaths ? "writing_graph_batch" : "writing_graph",
      message: affectedPaths ? "Writing graph index batch" : "Writing graph index",
      scannedFiles: index.scannedFiles?.length,
      changedFiles: index.changedFiles.length,
      deletedFiles: index.deletedFiles.length,
      refreshedFiles: index.refreshedFiles?.length,
      skippedFiles: index.skippedFiles.length,
      chunks: index.chunks.length,
      symbols: index.symbols.length,
      edges: index.edges.length,
      warnings: index.analysisWarnings?.length,
      partialBootstrap,
      semanticDeferred: index.semanticDeferred
    });
    await this.options.graphStore.upsertIndex(index);
    if (index.semanticDeferred) {
      await this.options.graphStore.markSemanticIndexDeferred?.(
        absoluteRoot,
        projectId,
        "semantic indexing deferred during partial bootstrap",
        currentGeneration
      );
    }
    assertMemoryWithinLimit(options, "after graph write");
    emitProgress(options, {
      phase: affectedPaths ? "writing_semantic_batch" : "writing_semantic",
      message: index.semanticDeferred ? "Semantic index deferred for bootstrap batch" : affectedPaths ? "Writing semantic index batch" : "Writing semantic index",
      chunks: index.chunks.length,
      symbols: index.symbols.length,
      edges: index.edges.length,
      partialBootstrap,
      semanticDeferred: index.semanticDeferred
    });
    if (!index.semanticDeferred) await this.updateSemanticIndex(absoluteRoot, projectId, index);
    assertMemoryWithinLimit(options, "after semantic write");
    emitProgress(options, {
      phase: "complete",
      message: "Index complete",
      scannedFiles: index.scannedFiles?.length,
      changedFiles: index.changedFiles.length,
      deletedFiles: index.deletedFiles.length,
      refreshedFiles: index.refreshedFiles?.length,
      skippedFiles: index.skippedFiles.length,
      chunks: index.chunks.length,
      symbols: index.symbols.length,
      edges: index.edges.length,
      warnings: index.analysisWarnings?.length,
      partialBootstrap,
      semanticDeferred: index.semanticDeferred
    });
    return index;
  }

  private async updateSemanticIndex(repoRoot: string, projectId: string, index: RepoIndex): Promise<void> {
    try {
      const graphSemanticNeedsRebuild = await this.options.graphStore.getSemanticIndexStatus?.(repoRoot, projectId)
        .then((status) => status.semanticRebuildNeeded)
        .catch(() => false) ?? false;
      const semanticNeedsRebuild = await this.options.semanticStore.needsRebuild?.(repoRoot, projectId) ?? false;
      if ((index.fullReindex && !index.partialBootstrap) || graphSemanticNeedsRebuild || semanticNeedsRebuild || !this.options.semanticStore.deleteFile) {
        await this.options.semanticStore.resetRepo(repoRoot);
        const chunks = graphSemanticNeedsRebuild ? await this.options.graphStore.getChunks(repoRoot) : index.chunks;
        await this.options.semanticStore.upsertChunks(chunks, this.options.embeddingProvider, index.indexGeneration);
        await this.options.graphStore.markSemanticIndexFresh?.(repoRoot, projectId, index.indexGeneration);
        return;
      }

      const changedOrDeleted = new Set([...index.changedFiles, ...index.deletedFiles]);
      for (const filePath of changedOrDeleted) {
        await this.options.semanticStore.deleteFile(repoRoot, projectId, filePath);
      }

      const changedChunks = index.chunks.filter((chunk) => changedOrDeleted.has(chunk.filePath) && !index.deletedFiles.includes(chunk.filePath));
      await this.options.semanticStore.upsertChunks(changedChunks, this.options.embeddingProvider, index.indexGeneration);
      await this.options.graphStore.markSemanticIndexFresh?.(repoRoot, projectId, index.indexGeneration);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[ragcode] semantic index skipped: ${message}`);
      await this.options.graphStore.markSemanticIndexFailed?.(repoRoot, projectId, message, index.indexGeneration).catch(() => undefined);
      // Semantic recall is optional cache acceleration. Graph rows remain the source of truth.
    }
  }

  private async loadChunksForFiles(repoRoot: string, filePaths: string[]): Promise<CodeChunk[]> {
    return this.options.graphStore.getChunksForFiles(repoRoot, filePaths);
  }

  private async loadSymbolsForFiles(repoRoot: string, filePaths: string[]): Promise<SymbolNode[]> {
    return this.options.graphStore.getSymbolsForFiles(repoRoot, filePaths);
  }

  private async loadEdgesForFiles(repoRoot: string, filePaths: string[]): Promise<GraphEdge[]> {
    if (filePaths.length === 0) return [];
    const edges = await this.options.graphStore.getEdgesForFiles(repoRoot, filePaths);
    const paths = new Set(filePaths);
    return edges.filter((edge) => edgeTouchesAnyPath(edge, paths));
  }

  private async loadFrameworkRouteEdges(repoRoot: string, files: CodeFile[], scopedFilePaths: string[]): Promise<GraphEdge[]> {
    const current = new Set(files.map((file) => file.path));
    const routePaths = await apiRoutePathsForFiles(files, scopedFilePaths);
    const edges = await this.options.graphStore.getEdgesForScope(repoRoot, {
      filePaths: scopedFilePaths,
      routePaths,
      kinds: FRAMEWORK_ROUTE_EDGE_KINDS
    }).catch(() => []);
    return edges.filter((edge) => isFrameworkRouteEdge(edge) && edgeRouteFile(edge, current));
  }
}

const FRAMEWORK_ROUTE_EDGE_KINDS: EdgeKind[] = ["calls_api", "routes_to", "handles_webhook"];

function indexOptionsForSemantic(options: IndexRefreshOptions): Pick<IndexRefreshOptions, "disableSemanticOnBootstrap"> {
  return { disableSemanticOnBootstrap: options.disableSemanticOnBootstrap };
}

function shouldDeferSemantic(options: Pick<IndexRefreshOptions, "disableSemanticOnBootstrap">, partialBootstrap: boolean): boolean {
  return partialBootstrap && options.disableSemanticOnBootstrap === true;
}

function assertMemoryWithinLimit(options: IndexRefreshOptions, phase: string): void {
  if (options.maxAnalysisMemoryMb === undefined) return;
  const usedMb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
  if (usedMb > options.maxAnalysisMemoryMb) {
    throw new Error(`Index memory guard tripped ${phase}: heap ${usedMb} MB exceeds ${options.maxAnalysisMemoryMb} MB.`);
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

    // Any edge whose recorded target file was touched invalidates its source. This is uniform
    // across imports, resolved calls, and framework edges (calls_api/routes_to/uses_middleware):
    // they all carry targetFile metadata, so this single pass covers them — no per-kind reverse pass.
    const previousTargetFile = stringMetadata(edge, "targetFile");
    if (previousTargetFile && touchedPaths.has(previousTargetFile)) {
      refreshed.add(sourceFile);
      continue;
    }

    const importSource = edge.kind === "imports" ? stringMetadata(edge, "source") : undefined;
    const nextTargetFile = importSource ? resolveImportPath(sourceFile, importSource, files) : undefined;
    if (nextTargetFile && touchedPaths.has(nextTargetFile)) refreshed.add(sourceFile);
  }

  return [...refreshed].sort();
}

function cachePathsForIncremental(
  files: CodeFile[],
  edges: GraphEdge[],
  changedFiles: string[],
  deletedFiles: string[],
  refreshedFiles: string[],
  importTargetPaths: string[]
): string[] {
  const currentPaths = new Set(files.map((file) => file.path));
  const paths = new Set<string>();
  for (const filePath of [...changedFiles, ...deletedFiles, ...refreshedFiles, ...importTargetPaths]) {
    if (currentPaths.has(filePath)) paths.add(filePath);
  }
  for (const edge of edges) {
    for (const filePath of edgeRelatedPaths(edge)) {
      if (currentPaths.has(filePath)) paths.add(filePath);
    }
  }
  return [...paths].sort();
}

async function localImportTargetPaths(files: CodeFile[], sourceFilePaths: string[]): Promise<string[]> {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const targets = new Set<string>();
  for (const filePath of sourceFilePaths) {
    const file = byPath.get(filePath);
    if (!file || (file.language !== "typescript" && file.language !== "javascript")) continue;
    const content = await fs.readFile(file.absolutePath, "utf8").catch(() => undefined);
    if (!content) continue;
    for (const importSource of localImportSources(content)) {
      const target = resolveImportPath(file.path, importSource, files);
      if (target) targets.add(target);
    }
  }
  return [...targets].sort();
}

function localImportSources(content: string): string[] {
  const sources = new Set<string>();
  const patterns = [
    /import\s+(?:type\s+)?(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/g,
    /export\s+[^'";]+?\s+from\s+['"]([^'"]+)['"]/g,
    /require\(\s*['"]([^'"]+)['"]\s*\)/g
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const source = match[1];
      if (source?.startsWith(".")) sources.add(source);
    }
  }
  return [...sources];
}

async function apiRoutePathsForFiles(files: CodeFile[], sourceFilePaths: string[]): Promise<string[]> {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const routes = new Set<string>();
  for (const filePath of sourceFilePaths) {
    const file = byPath.get(filePath);
    if (!file || (file.language !== "typescript" && file.language !== "javascript")) continue;
    const content = await fs.readFile(file.absolutePath, "utf8").catch(() => undefined);
    if (!content) continue;
    for (const routePath of apiRoutePaths(content)) routes.add(routePath);
  }
  return [...routes].sort();
}

function apiRoutePaths(content: string): string[] {
  const routes = new Set<string>();
  const pattern = /["'`]((?:\/api\/)[A-Za-z0-9_./:[\]\-()*]+)["'`]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const routePath = match[1];
    if (routePath && !routePath.includes("*")) routes.add(routePath);
  }
  const resourceCallPattern = /\b(?:api|apiClient)\.([A-Za-z0-9_-]+)\b/g;
  while ((match = resourceCallPattern.exec(content)) !== null) {
    const resource = match[1];
    if (resource) routes.add(`/api/${resource}`);
  }
  const clientCallPattern = /\b([A-Za-z][A-Za-z0-9_-]*)Api\./g;
  while ((match = clientCallPattern.exec(content)) !== null) {
    const resource = match[1];
    if (resource) routes.add(`/api/${resource}`);
  }
  return [...routes];
}

function edgeTouchesAnyPath(edge: GraphEdge, paths: Set<string>): boolean {
  return edgeRelatedPaths(edge).some((filePath) => paths.has(filePath));
}

function edgeRelatedPaths(edge: GraphEdge): string[] {
  return [
    stringMetadata(edge, "sourceFile"),
    stringMetadata(edge, "targetFile"),
    stringMetadata(edge, "routeFile"),
    stringMetadata(edge, "testFile")
  ].filter((filePath): filePath is string => Boolean(filePath));
}

function isFrameworkRouteEdge(edge: GraphEdge): boolean {
  return edge.kind === "calls_api" || edge.kind === "routes_to" || edge.kind === "handles_webhook";
}

function edgeRouteFile(edge: GraphEdge, currentPaths: Set<string>): string | undefined {
  const routeFile = stringMetadata(edge, "routeFile") ?? stringMetadata(edge, "targetFile") ?? stringMetadata(edge, "sourceFile");
  return routeFile && currentPaths.has(routeFile) ? routeFile : undefined;
}

function stringMetadata(edge: GraphEdge, key: string): string | undefined {
  const value = edge.metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

function emitProgress(options: IndexRefreshOptions, event: IndexProgressEvent): void {
  options.onProgress?.({ ...event, ...memoryStats() });
}

function memoryStats(): Pick<IndexProgressEvent, "heapUsedMb" | "rssMb"> {
  const usage = process.memoryUsage();
  return {
    heapUsedMb: Math.round(usage.heapUsed / 1024 / 1024),
    rssMb: Math.round(usage.rss / 1024 / 1024)
  };
}
