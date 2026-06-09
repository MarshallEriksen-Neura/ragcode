import type {
  CodeChunk,
  CodeFile,
  ContextPack,
  ContextRequest,
  DiffReview,
  EdgeKind,
  GraphEdge,
  ImpactAnalysis,
  IndexStatus,
  OwnerCandidate,
  RelatedTests,
  ReuseCandidateReport,
  ReuseCandidateRequest,
  RepoIndex,
  SearchHit,
  SearchQuery,
  SymbolNode,
  TopologyMap,
  TopologyMapRequest,
  TraceFlow,
  VerifiedCodeSubgraph,
  VerifiedSubgraphRequest,
  ProjectIdentity,
  WatcherEventOptions,
  WatcherState
} from "./types.js";

export interface EmbeddingProvider {
  readonly dimensions?: number;
  embed(text: string): Promise<number[]>;
}

export interface GraphStore {
  close?(): void;
  getProjectByRoot?(repoRoot: string): Promise<ProjectIdentity | undefined>;
  listProjects?(): Promise<ProjectIdentity[]>;
  getIndexGeneration?(repoRoot: string): Promise<number>;
  recordFileEvents?(repoRoot: string, filePaths: string[], options?: WatcherEventOptions): Promise<WatcherState>;
  getWatcherState?(repoRoot: string): Promise<WatcherState>;
  markDirtyFilesIndexing?(repoRoot: string, filePaths: string[]): Promise<WatcherState>;
  clearDirtyFiles?(repoRoot: string, filePaths?: string[]): Promise<void>;
  resetRepo(repoRoot: string): Promise<void>;
  upsertIndex(index: RepoIndex): Promise<void>;
  getFiles(repoRoot: string): Promise<CodeFile[]>;
  getChunks(repoRoot: string): Promise<CodeChunk[]>;
  getSkippedFiles(repoRoot: string): Promise<Array<{ filePath: string; reason: string }>>;
  getSymbols(repoRoot: string): Promise<SymbolNode[]>;
  getEdges(repoRoot: string, kind?: EdgeKind): Promise<GraphEdge[]>;
  findSymbol(repoRoot: string, name: string): Promise<SymbolNode[]>;
  explainFile(repoRoot: string, filePath: string): Promise<{ file?: CodeFile; chunks: CodeChunk[]; symbols: SymbolNode[] }>;
  searchText(query: SearchQuery): Promise<SearchHit[]>;
  findOwner(repoRoot: string, query: string, limit?: number): Promise<OwnerCandidate[]>;
  impactAnalysis(repoRoot: string, target: string): Promise<ImpactAnalysis>;
  relatedTests(repoRoot: string, target: string): Promise<RelatedTests>;
  traceFlow(repoRoot: string, entry: string, maxSteps?: number): Promise<TraceFlow>;
  reviewDiff(repoRoot: string, diff?: string, changedFiles?: string[]): Promise<DiffReview>;
}

export interface SemanticStore {
  resetRepo(repoRoot: string): Promise<void>;
  deleteFile?(repoRoot: string, projectId: string, filePath: string): Promise<void>;
  upsertChunks(chunks: CodeChunk[], provider: EmbeddingProvider, generation?: number): Promise<void>;
  search(query: SearchQuery, provider: EmbeddingProvider): Promise<SearchHit[]>;
}

export interface Indexer {
  indexRepo(repoRoot: string, projectId: string, project?: ProjectIdentity): Promise<RepoIndex>;
}

export interface ContextEngine {
  indexRepo(repoRoot: string): Promise<RepoIndex>;
  refreshIndex(repoRoot: string | undefined): Promise<RepoIndex>;
  indexStatus(repoRoot: string | undefined): Promise<IndexStatus>;
  recordFileEvents(repoRoot: string | undefined, filePaths: string[], options?: WatcherEventOptions): Promise<WatcherState>;
  markDirtyFilesIndexing(repoRoot: string | undefined, filePaths: string[]): Promise<WatcherState>;
  searchCode(query: SearchQuery): Promise<SearchHit[]>;
  getContext(request: ContextRequest): Promise<ContextPack>;
  verifiedSubgraph(request: VerifiedSubgraphRequest): Promise<VerifiedCodeSubgraph>;
  topologyMap(request: TopologyMapRequest): Promise<TopologyMap>;
  findSymbol(repoRoot: string | undefined, name: string): Promise<SymbolNode[]>;
  explainFile(repoRoot: string | undefined, filePath: string): Promise<{ file?: CodeFile; chunks: CodeChunk[]; symbols: SymbolNode[] }>;
  findOwner(repoRoot: string | undefined, query: string, limit?: number): Promise<OwnerCandidate[]>;
  findReuseCandidates(request: ReuseCandidateRequest): Promise<ReuseCandidateReport>;
  impactAnalysis(repoRoot: string | undefined, target: string): Promise<ImpactAnalysis>;
  relatedTests(repoRoot: string | undefined, target: string): Promise<RelatedTests>;
  traceFlow(repoRoot: string | undefined, entry: string, maxSteps?: number): Promise<TraceFlow>;
  reviewDiff(repoRoot: string | undefined, diff?: string, changedFiles?: string[]): Promise<DiffReview>;
}
