import path from "node:path";
import type { ContextEngine, EmbeddingProvider, GraphStore, SemanticStore } from "./contracts.js";
import type { ContextPack, ContextRequest, DiffReview, FreshnessReport, GraphEdge, ImpactAnalysis, IndexStatus, OwnerCandidate, ProjectIdentity, RelatedTests, ReuseCandidateReport, ReuseCandidateRequest, RepoIndex, SearchHit, SearchQuery, SymbolNode, TopologyMap, TopologyMapRequest, TraceFlow, VerifiedCodeSubgraph, VerifiedSubgraphRequest, WatcherEventOptions, WatcherState, WorkspaceHint, WorkspaceSession } from "./types.js";
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
import { SubgraphBuilder } from "../subgraph/subgraph-builder.js";
import { normalizeUserPath } from "../utils/path.js";
import { buildReuseCandidateReport } from "../reuse/reuse-detector.js";

export interface RagCodeEngineOptions {
  graphStore?: GraphStore;
  semanticStore?: SemanticStore;
  embeddingProvider?: EmbeddingProvider;
  workspaceRoots?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export class RagCodeEngine implements ContextEngine {
  private readonly graphStore: GraphStore;
  private readonly semanticStore: SemanticStore;
  private readonly embeddingProvider: EmbeddingProvider;
  private readonly projectRegistry = new ProjectRegistry();
  private readonly workspaceResolver: WorkspaceResolver;
  private readonly contextBuilder = new ContextBuilder();
  private readonly indexedAtByRepo = new Map<string, number>();
  private readonly cwd: string;
  private readonly workspaceRoots: string[];
  private readonly hydratedRoots = new Set<string>();
  private hydratedAllProjects = false;

  constructor(options: RagCodeEngineOptions = {}) {
    const env = options.env ?? process.env;
    this.cwd = path.resolve(options.cwd ?? process.cwd());
    this.workspaceRoots = (options.workspaceRoots ?? []).map((root) => path.resolve(root));
    const graphRuntime = options.graphStore ? undefined : createGraphRuntimeFromEnv(env, this.cwd);
    this.graphStore = options.graphStore ?? graphRuntime?.graphStore ?? new InMemoryGraphStore();
    const semanticRuntime = (options.semanticStore && options.embeddingProvider)
      ? undefined
      : createSemanticRuntimeFromEnv(env, this.cwd);
    this.semanticStore = options.semanticStore ?? semanticRuntime?.semanticStore ?? new InMemorySemanticStore();
    this.embeddingProvider = options.embeddingProvider ?? semanticRuntime?.embeddingProvider ?? new DeterministicEmbeddingProvider();
    this.workspaceResolver = new WorkspaceResolver(this.projectRegistry, {
      cwd: this.cwd,
      roots: this.workspaceRoots
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
    const index = await new RepoIndexer({
      graphStore: this.graphStore,
      semanticStore: this.semanticStore,
      embeddingProvider: this.embeddingProvider
    }).indexRepo(absoluteRoot, project.projectId, project);
    const indexedProject = this.projectRegistry.upsert({
      ...project,
      lastIndexedAtMs: index.indexedAtMs
    });
    this.indexedAtByRepo.set(indexedProject.repoRoot, index.indexedAtMs);
    this.indexedAtByRepo.set(indexedProject.canonicalRoot, index.indexedAtMs);
    return {
      ...index,
      project: indexedProject
    };
  }

  async refreshIndex(repoRoot: string | undefined): Promise<RepoIndex> {
    const scope = await this.resolveWorkspace({ repoRoot });
    return this.indexRepo(scope.activeRepoRoot);
  }

  async indexStatus(repoRoot: string | undefined): Promise<IndexStatus> {
    const scope = await this.resolveWorkspace({ repoRoot });
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
      indexingFileCount: freshness.indexingFiles.length,
      skippedFileCount: freshness.skippedFiles.length,
      burstMode: freshness.burstMode,
      droppedEventCount: freshness.droppedEvents,
      freshness
    };
  }

  async recordFileEvents(repoRoot: string | undefined, filePaths: string[], options?: WatcherEventOptions): Promise<WatcherState> {
    const scope = await this.resolveWorkspace({ repoRoot });
    if (!this.graphStore.recordFileEvents) {
      throw new Error("Current graph store does not support watcher dirty-file state.");
    }
    return this.graphStore.recordFileEvents(scope.activeRepoRoot, filePaths, options);
  }

  async markDirtyFilesIndexing(repoRoot: string | undefined, filePaths: string[]): Promise<WatcherState> {
    const scope = await this.resolveWorkspace({ repoRoot });
    if (!this.graphStore.markDirtyFilesIndexing) {
      throw new Error("Current graph store does not support watcher indexing state.");
    }
    return this.graphStore.markDirtyFilesIndexing(scope.activeRepoRoot, filePaths);
  }

  async searchCode(query: SearchQuery): Promise<SearchHit[]> {
    const scope = await this.resolveWorkspace(query);
    const { hits } = await this.searchWithFreshness({ ...query, repoRoot: scope.activeRepoRoot, projectId: scope.activeProjectId }, scope);
    return hits;
  }

  async getContext(request: ContextRequest): Promise<ContextPack> {
    const scope = await this.resolveWorkspace(request);
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
      skippedFiles: freshness.skippedFiles,
      dirtyFiles: freshness.dirtyFiles,
      burstMode: freshness.burstMode,
      droppedEvents: freshness.droppedEvents
    });
  }

  async verifiedSubgraph(request: VerifiedSubgraphRequest): Promise<VerifiedCodeSubgraph> {
    const scope = await this.resolveWorkspace(request);
    const freshness = await this.computeFreshness(scope);
    const [symbols, edges, chunks] = await Promise.all([
      this.graphStore.getSymbols(scope.activeRepoRoot),
      this.graphStore.getEdges(scope.activeRepoRoot),
      this.graphStore.getChunks(scope.activeRepoRoot)
    ]);
    const freshSymbols = filterFreshSymbols(symbols, freshness);
    const freshChunks = filterFreshChunks(chunks, freshness);
    const freshEdges = filterFreshEdges(edges, freshness);
    const seed = request.seed ?? request.query;
    const seedSymbols = selectSeedSymbols(freshSymbols, seed);
    const missingEvidence = freshness.staleFiles.length > 0
      ? [`Stale indexed files excluded: ${freshness.staleFiles.slice(0, 8).join(", ")}.`]
      : [];

    return new SubgraphBuilder().build({
      query: request.query,
      repoRoot: scope.activeRepoRoot,
      projectId: scope.activeProjectId,
      mode: request.mode ?? "impact",
      seedSymbols,
      symbols: freshSymbols,
      edges: freshEdges,
      chunks: freshChunks,
      budgetChars: request.budgetChars,
      maxHops: request.maxHops,
      missingEvidence
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
    const scope = await this.resolveWorkspace({ repoRoot });
    return this.graphStore.findSymbol(scope.activeRepoRoot, name);
  }

  async explainFile(repoRoot: string | undefined, filePath: string): Promise<{ file?: CodeFile; chunks: CodeChunk[]; symbols: SymbolNode[] }> {
    const scope = await this.resolveWorkspace({ repoRoot, workspace: path.isAbsolute(filePath) ? { filePath } : undefined });
    return this.graphStore.explainFile(scope.activeRepoRoot, filePath);
  }

  async findOwner(repoRoot: string | undefined, query: string, limit?: number): Promise<OwnerCandidate[]> {
    const scope = await this.resolveWorkspace({ repoRoot });
    return this.graphStore.findOwner(scope.activeRepoRoot, query, limit);
  }

  async findReuseCandidates(request: ReuseCandidateRequest): Promise<ReuseCandidateReport> {
    const scope = await this.resolveWorkspace(request);
    const normalized = { ...request, repoRoot: scope.activeRepoRoot, projectId: scope.activeProjectId };
    const { hits, freshness } = await this.searchWithFreshness(normalized, scope);
    const [owners, symbols, edges, chunks] = await Promise.all([
      this.graphStore.findOwner(scope.activeRepoRoot, request.query, request.limit ?? 8),
      this.graphStore.getSymbols(scope.activeRepoRoot),
      this.graphStore.getEdges(scope.activeRepoRoot),
      this.graphStore.getChunks(scope.activeRepoRoot)
    ]);
    return buildReuseCandidateReport({
      query: request.query,
      hits,
      owners: owners.filter((owner) => !freshness.staleFiles.includes(owner.filePath)),
      symbols: filterFreshSymbols(symbols, freshness),
      edges: filterFreshEdges(edges, freshness),
      chunks: filterFreshChunks(chunks, freshness),
      limit: request.limit
    });
  }

  async impactAnalysis(repoRoot: string | undefined, target: string): Promise<ImpactAnalysis> {
    const scope = await this.resolveWorkspace({ repoRoot });
    return this.graphStore.impactAnalysis(scope.activeRepoRoot, target);
  }

  async relatedTests(repoRoot: string | undefined, target: string): Promise<RelatedTests> {
    const scope = await this.resolveWorkspace({ repoRoot });
    return this.graphStore.relatedTests(scope.activeRepoRoot, target);
  }

  async traceFlow(repoRoot: string | undefined, entry: string, maxSteps?: number): Promise<TraceFlow> {
    const scope = await this.resolveWorkspace({ repoRoot });
    return this.graphStore.traceFlow(scope.activeRepoRoot, entry, maxSteps);
  }

  async reviewDiff(repoRoot: string | undefined, diff?: string, changedFiles?: string[]): Promise<DiffReview> {
    const scope = await this.resolveWorkspace({ repoRoot });
    return this.graphStore.reviewDiff(scope.activeRepoRoot, diff, changedFiles);
  }

  private async resolveWorkspace(input: { repoRoot?: string; workspace?: WorkspaceHint } = {}): Promise<WorkspaceSession> {
    await this.hydrateForInput(input);
    return this.workspaceResolver.resolve(input);
  }

  private async hydrateForInput(input: { repoRoot?: string; workspace?: WorkspaceHint }): Promise<void> {
    if (input.repoRoot) await this.hydrateProjectByRoot(input.repoRoot);
    if (input.workspace?.root) await this.hydrateProjectByRoot(input.workspace.root);
    if (input.workspace?.filePath) await this.hydrateAllPersistedProjects();

    if (!input.repoRoot && !input.workspace?.root && !input.workspace?.filePath) {
      for (const root of this.workspaceRoots) await this.hydrateProjectByRoot(root);
      await this.hydrateProjectByRoot(this.cwd);
      await this.hydrateAllPersistedProjects();
    }
  }

  private async hydrateProjectByRoot(root: string): Promise<void> {
    if (this.projectRegistry.findByRoot(root)) return;
    const normalized = path.resolve(root).toLowerCase();
    if (this.hydratedRoots.has(normalized)) return;
    this.hydratedRoots.add(normalized);
    const project = await this.graphStore.getProjectByRoot?.(root);
    if (project) this.rememberHydratedProject(project);
  }

  private async hydrateAllPersistedProjects(): Promise<void> {
    if (this.hydratedAllProjects) return;
    this.hydratedAllProjects = true;
    const projects = await this.graphStore.listProjects?.();
    for (const project of projects ?? []) this.rememberHydratedProject(project);
  }

  private rememberHydratedProject(project: ProjectIdentity): void {
    const merged = this.projectRegistry.upsert(project);
    if (merged.lastIndexedAtMs) {
      this.indexedAtByRepo.set(merged.repoRoot, merged.lastIndexedAtMs);
      this.indexedAtByRepo.set(merged.canonicalRoot, merged.lastIndexedAtMs);
    }
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
    const watcherStatePromise = this.graphStore.getWatcherState
      ? this.graphStore.getWatcherState(scope.activeRepoRoot).catch(() => undefined)
      : Promise.resolve(undefined);
    const [indexedFiles, scan, watcherState] = await Promise.all([
      this.graphStore.getFiles(scope.activeRepoRoot),
      scanRepo(scope.activeRepoRoot, scope.activeProjectId),
      watcherStatePromise
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

    for (const filePath of watcherState?.pendingFiles ?? []) {
      pendingFiles.add(filePath);
      if (indexedByPath.has(filePath)) staleFiles.add(filePath);
    }
    for (const filePath of watcherState?.indexingFiles ?? []) {
      if (indexedByPath.has(filePath)) staleFiles.add(filePath);
    }

    const indexGeneration = this.graphStore.getIndexGeneration
      ? await this.graphStore.getIndexGeneration(scope.activeRepoRoot).catch(() => 1)
      : 1;
    return {
      projectId: scope.activeProjectId,
      indexGeneration,
      indexedAtMs: this.indexedAtByRepo.get(scope.activeRepoRoot) ?? Date.now(),
      staleFiles: [...staleFiles].sort(),
      pendingFiles: [...pendingFiles].sort(),
      indexingFiles: [...new Set(watcherState?.indexingFiles ?? [])].sort(),
      skippedFiles: scan.skippedFiles,
      dirtyFiles: watcherState?.dirtyFiles ?? [],
      burstMode: watcherState?.burstMode ?? false,
      droppedEvents: watcherState?.droppedEvents ?? 0
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
    const targetFile = edge.metadata?.targetFile;
    return (typeof sourceFile !== "string" || !stale.has(sourceFile))
      && (typeof targetFile !== "string" || !stale.has(targetFile));
  });
}

function filterFreshSymbols(symbols: SymbolNode[], freshness: FreshnessReport): SymbolNode[] {
  if (freshness.staleFiles.length === 0) return symbols;
  const stale = new Set(freshness.staleFiles);
  return symbols.filter((symbol) => !stale.has(symbol.filePath));
}

function filterFreshChunks(chunks: CodeChunk[], freshness: FreshnessReport): CodeChunk[] {
  if (freshness.staleFiles.length === 0) return chunks;
  const stale = new Set(freshness.staleFiles);
  return chunks.filter((chunk) => !stale.has(chunk.filePath));
}

function selectSeedSymbols(symbols: SymbolNode[], seed: string): SymbolNode[] {
  const normalized = normalizeUserPath(seed);
  const scoped = scopedSeed(seed);
  const loweredSeed = seed.toLowerCase();
  const exact = symbols.filter((symbol) => {
    if (scoped) {
      return symbol.filePath === scoped.filePath && symbol.name.toLowerCase() === scoped.symbolName.toLowerCase();
    }
    return symbol.name.toLowerCase() === loweredSeed || symbol.filePath === normalized;
  });
  if (exact.length > 0) return sortSeedSymbols(exact);

  const partial = symbols.filter((symbol) => {
    if (scoped) {
      return symbol.filePath.includes(scoped.filePath) && symbol.name.toLowerCase().includes(scoped.symbolName.toLowerCase());
    }
    return symbol.name.toLowerCase().includes(loweredSeed) || symbol.filePath.includes(normalized);
  });
  return sortSeedSymbols(partial).slice(0, 8);
}

function scopedSeed(seed: string): { filePath: string; symbolName: string } | undefined {
  const separator = seed.lastIndexOf(":");
  if (separator <= 0 || /^[a-zA-Z]:[\\/]/.test(seed)) return undefined;
  const filePath = normalizeUserPath(seed.slice(0, separator));
  const symbolName = seed.slice(separator + 1).trim();
  if (!filePath || !symbolName) return undefined;
  return { filePath, symbolName };
}

function sortSeedSymbols(symbols: SymbolNode[]): SymbolNode[] {
  return [...symbols].sort((a, b) => seedPriority(a) - seedPriority(b)
    || a.filePath.localeCompare(b.filePath)
    || a.startLine - b.startLine);
}

function seedPriority(symbol: SymbolNode): number {
  if (symbol.kind === "file") return 5;
  if (symbol.exported) return 0;
  return 1;
}
