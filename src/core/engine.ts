import path from "node:path";
import type { ContextEngine, EmbeddingProvider, GraphStore, SemanticStore } from "./contracts.js";
import type { ContextPack, ContextRequest, DiffReview, FreshnessReport, GraphEdge, ImpactAnalysis, IndexStatus, OwnerCandidate, RelatedTests, RepoIndex, SearchHit, SearchQuery, SymbolNode, TopologyMap, TopologyMapRequest, TraceFlow, WorkspaceSession } from "./types.js";
import { ContextBuilder } from "../context/context-builder.js";
import { createGraphRuntimeFromEnv } from "../config/graph-runtime.js";
import { createSemanticRuntimeFromEnv } from "../config/semantic-runtime.js";
import { InMemoryGraphStore } from "../graph/in-memory-graph-store.js";
import { RepoIndexer } from "../indexing/indexer.js";
import { scanRepo } from "../indexing/scanner.js";
import { ProjectRegistry } from "../project/project-registry.js";
import { WorkspaceResolver } from "../project/workspace-resolver.js";
import { HybridRetriever } from "../retrieval/hybrid-retriever.js";
import { DeterministicEmbeddingProvider } from "../semantic/deterministic-embedding.js";
import { InMemorySemanticStore } from "../semantic/in-memory-semantic-store.js";
import type { CodeFile, CodeChunk } from "./types.js";

export interface RagCodeEngineOptions {
  graphStore?: GraphStore;
  semanticStore?: SemanticStore;
  embeddingProvider?: EmbeddingProvider;
  workspaceRoots?: string[];
  cwd?: string;
}

export class RagCodeEngine implements ContextEngine {
  private readonly graphStore: GraphStore;
  private readonly semanticStore: SemanticStore;
  private readonly embeddingProvider: EmbeddingProvider;
  private readonly projectRegistry = new ProjectRegistry();
  private readonly workspaceResolver: WorkspaceResolver;
  private readonly contextBuilder = new ContextBuilder();
  private readonly indexedAtByRepo = new Map<string, number>();

  constructor(options: RagCodeEngineOptions = {}) {
    const graphRuntime = options.graphStore ? undefined : createGraphRuntimeFromEnv(process.env, options.cwd ?? process.cwd());
    this.graphStore = options.graphStore ?? graphRuntime?.graphStore ?? new InMemoryGraphStore();
    const semanticRuntime = (options.semanticStore && options.embeddingProvider)
      ? undefined
      : createSemanticRuntimeFromEnv(process.env, options.cwd ?? process.cwd());
    this.semanticStore = options.semanticStore ?? semanticRuntime?.semanticStore ?? new InMemorySemanticStore();
    this.embeddingProvider = options.embeddingProvider ?? semanticRuntime?.embeddingProvider ?? new DeterministicEmbeddingProvider();
    this.workspaceResolver = new WorkspaceResolver(this.projectRegistry, {
      cwd: options.cwd ?? process.cwd(),
      roots: options.workspaceRoots
    });
  }

  close(): void {
    this.graphStore.close?.();
  }

  async indexRepo(repoRoot: string): Promise<RepoIndex> {
    const project = await this.projectRegistry.register(repoRoot);
    this.workspaceResolver.setActive(project, "repoRoot");
    const absoluteRoot = path.resolve(repoRoot);
    this.indexedAtByRepo.set(absoluteRoot, Date.now());
    return new RepoIndexer({
      graphStore: this.graphStore,
      semanticStore: this.semanticStore,
      embeddingProvider: this.embeddingProvider
    }).indexRepo(absoluteRoot, project.projectId);
  }

  async refreshIndex(repoRoot: string | undefined): Promise<RepoIndex> {
    const scope = this.workspaceResolver.resolve({ repoRoot });
    return this.indexRepo(scope.activeRepoRoot);
  }

  async indexStatus(repoRoot: string | undefined): Promise<IndexStatus> {
    const scope = this.workspaceResolver.resolve({ repoRoot });
    const [files, chunks, symbols, edges, freshness] = await Promise.all([
      this.graphStore.getFiles(scope.activeRepoRoot),
      this.graphStore.getChunks(scope.activeRepoRoot),
      this.graphStore.getSymbols(scope.activeRepoRoot),
      this.graphStore.getEdges(scope.activeRepoRoot),
      this.computeFreshness(scope)
    ]);
    const stale = new Set(freshness.staleFiles);
    return {
      repoRoot: scope.activeRepoRoot,
      projectId: scope.activeProjectId,
      indexedAtMs: freshness.indexedAtMs,
      fileCount: files.length,
      chunkCount: chunks.length,
      symbolCount: symbols.length,
      edgeCount: edges.length,
      freshFileCount: files.filter((file) => !stale.has(file.path)).length,
      staleFileCount: freshness.staleFiles.length,
      pendingFileCount: freshness.pendingFiles.length,
      skippedFileCount: freshness.skippedFiles.length,
      freshness
    };
  }

  async searchCode(query: SearchQuery): Promise<SearchHit[]> {
    const scope = this.workspaceResolver.resolve(query);
    const { hits } = await this.searchWithFreshness({ ...query, repoRoot: scope.activeRepoRoot, projectId: scope.activeProjectId }, scope);
    return hits;
  }

  async getContext(request: ContextRequest): Promise<ContextPack> {
    const scope = this.workspaceResolver.resolve(request);
    const normalized = { ...request, repoRoot: scope.activeRepoRoot, projectId: scope.activeProjectId };
    const { hits, freshness } = await this.searchWithFreshness(normalized, scope);
    const edges = filterFreshEdges(await this.graphStore.getEdges(normalized.repoRoot), freshness);
    return this.contextBuilder.build(normalized, hits, edges, {
      projectId: scope.activeProjectId,
      repoRoot: scope.activeRepoRoot,
      indexedAtMs: this.indexedAtByRepo.get(scope.activeRepoRoot) ?? Date.now(),
      indexGeneration: freshness.indexGeneration,
      staleFiles: freshness.staleFiles,
      pendingFiles: freshness.pendingFiles,
      indexingFiles: freshness.indexingFiles,
      skippedFiles: freshness.skippedFiles
    });
  }

  async topologyMap(request: TopologyMapRequest): Promise<TopologyMap> {
    const pack = await this.getContext({
      ...request,
      mode: request.mode ?? "feature",
      budgetChars: request.budgetChars ?? 12_000
    });
    return {
      query: pack.query,
      repoRoot: pack.repoRoot,
      projectId: pack.projectId,
      freshness: pack.freshness,
      owners: pack.ownerChain,
      edges: pack.topology.slice(0, request.maxEdges ?? 24),
      missingEvidence: pack.missingEvidence,
      nextQueries: pack.nextQueries
    };
  }

  async findSymbol(repoRoot: string | undefined, name: string): Promise<SymbolNode[]> {
    const scope = this.workspaceResolver.resolve({ repoRoot });
    return this.graphStore.findSymbol(scope.activeRepoRoot, name);
  }

  async explainFile(repoRoot: string | undefined, filePath: string): Promise<{ file?: CodeFile; chunks: CodeChunk[]; symbols: SymbolNode[] }> {
    const scope = this.workspaceResolver.resolve({ repoRoot, workspace: path.isAbsolute(filePath) ? { filePath } : undefined });
    return this.graphStore.explainFile(scope.activeRepoRoot, filePath);
  }

  async findOwner(repoRoot: string | undefined, query: string, limit?: number): Promise<OwnerCandidate[]> {
    const scope = this.workspaceResolver.resolve({ repoRoot });
    return this.graphStore.findOwner(scope.activeRepoRoot, query, limit);
  }

  async impactAnalysis(repoRoot: string | undefined, target: string): Promise<ImpactAnalysis> {
    const scope = this.workspaceResolver.resolve({ repoRoot });
    return this.graphStore.impactAnalysis(scope.activeRepoRoot, target);
  }

  async relatedTests(repoRoot: string | undefined, target: string): Promise<RelatedTests> {
    const scope = this.workspaceResolver.resolve({ repoRoot });
    return this.graphStore.relatedTests(scope.activeRepoRoot, target);
  }

  async traceFlow(repoRoot: string | undefined, entry: string, maxSteps?: number): Promise<TraceFlow> {
    const scope = this.workspaceResolver.resolve({ repoRoot });
    return this.graphStore.traceFlow(scope.activeRepoRoot, entry, maxSteps);
  }

  async reviewDiff(repoRoot: string | undefined, diff?: string, changedFiles?: string[]): Promise<DiffReview> {
    const scope = this.workspaceResolver.resolve({ repoRoot });
    return this.graphStore.reviewDiff(scope.activeRepoRoot, diff, changedFiles);
  }

  private async searchWithFreshness(query: SearchQuery, scope: WorkspaceSession): Promise<{ hits: SearchHit[]; freshness: FreshnessReport }> {
    const freshness = await this.computeFreshness(scope);
    const hits = await new HybridRetriever({
      graphStore: this.graphStore,
      semanticStore: this.semanticStore,
      embeddingProvider: this.embeddingProvider
    }).search(query);
    return { hits: filterFreshHits(hits, freshness), freshness };
  }

  private async computeFreshness(scope: WorkspaceSession): Promise<FreshnessReport> {
    const [indexedFiles, scan] = await Promise.all([
      this.graphStore.getFiles(scope.activeRepoRoot),
      scanRepo(scope.activeRepoRoot, scope.activeProjectId)
    ]);
    const indexedByPath = new Map(indexedFiles.map((file) => [file.path, file]));
    const currentByPath = new Map(scan.files.map((file) => [file.path, file]));
    const staleFiles = new Set<string>();
    const pendingFiles = new Set<string>();

    for (const indexed of indexedFiles) {
      const current = currentByPath.get(indexed.path);
      if (!current) {
        staleFiles.add(indexed.path);
        continue;
      }
      if (current.contentHash !== indexed.contentHash) {
        staleFiles.add(indexed.path);
        pendingFiles.add(indexed.path);
      }
    }

    for (const current of scan.files) {
      const indexed = indexedByPath.get(current.path);
      if (!indexed || indexed.contentHash !== current.contentHash) pendingFiles.add(current.path);
    }

    return {
      projectId: scope.activeProjectId,
      indexGeneration: 1,
      indexedAtMs: this.indexedAtByRepo.get(scope.activeRepoRoot) ?? Date.now(),
      staleFiles: [...staleFiles].sort(),
      pendingFiles: [...pendingFiles].sort(),
      indexingFiles: [],
      skippedFiles: scan.skippedFiles
    };
  }
}

function filterFreshHits(hits: SearchHit[], freshness: FreshnessReport): SearchHit[] {
  if (freshness.staleFiles.length === 0) return hits;
  const stale = new Set(freshness.staleFiles);
  return hits.filter((hit) => !stale.has(hit.chunk.filePath));
}

function filterFreshEdges(edges: GraphEdge[], freshness: FreshnessReport): GraphEdge[] {
  if (freshness.staleFiles.length === 0) return edges;
  const stale = new Set(freshness.staleFiles);
  return edges.filter((edge) => {
    const sourceFile = edge.metadata?.sourceFile;
    return typeof sourceFile !== "string" || !stale.has(sourceFile);
  });
}
