import axios from 'axios'

const api = axios.create({
  baseURL: '/api',
  timeout: 120000,
})

// ===== Shared enums =====
export type ContextMode = 'auto' | 'debug' | 'feature' | 'refactor' | 'review' | 'explain'
export type Confidence = 'low' | 'medium' | 'high'
export type RiskLevel = 'low' | 'medium' | 'high'
export type ExpansionLevel = 'file_card' | 'skeleton' | 'focused_body' | 'full_body'
export type VerifiedSubgraphMode = 'impact' | 'flow' | 'review' | 'debug'
export type EdgeKind =
  | 'contains' | 'imports' | 'exports' | 'calls' | 'references' | 'tested_by'
  | 'related' | 'handles_event' | 'calls_api' | 'routes_to' | 'uses_middleware'
  | 'handles_webhook' | 'reads_from' | 'writes_to'

// ===== Config =====
export interface Config {
  graphStore: string
  semanticStore: string
  embeddingProvider: string
  sqlitePath?: string
  lancedbUri?: string
  embeddingBaseUrl?: string
  embeddingModel?: string
  repoRoot?: string
  configPath?: string
}

// ===== Index status / freshness =====
export interface DirtyFile {
  filePath: string
  status: 'pending' | 'indexing'
  reason: string
  eventCount: number
  lastSeenAtMs: number
}

export interface FreshnessReport {
  indexGeneration: number
  indexedAtMs: number
  staleFiles: string[]
  pendingFiles: string[]
  indexingFiles: string[]
  skippedFiles: Array<{ filePath: string; reason: string }>
  dirtyFiles: DirtyFile[]
  burstMode: boolean
  droppedEvents: number
}

export interface IndexStatus {
  repoRoot: string
  projectId: string
  indexedAtMs: number
  fileCount: number
  chunkCount: number
  symbolCount: number
  edgeCount: number
  freshFileCount: number
  staleFileCount: number
  pendingFileCount: number
  indexingFileCount: number
  skippedFileCount: number
  burstMode: boolean
  droppedEventCount: number
  freshness: FreshnessReport
}

// ===== Context pack =====
export interface ContextSnippet {
  filePath: string
  startLine: number
  endLine: number
  content: string
  score: number
  reason: string
  role: string
  expansionLevel: ExpansionLevel
  originalLineCount: number
  returnedLineCount: number
  elidedLineCount: number
}

export interface OwnerNode {
  filePath: string
  role: string
  reason: string
  score: number
  symbols: Array<{ name: string; kind: string; startLine: number; endLine: number }>
}

export interface TopologyEdge {
  from: string
  to: string
  edge: EdgeKind
  confidence: Confidence
  reason: string
  sourceFile?: string
  targetFile?: string
}

export interface RelationshipEvidence {
  source: string
  target: string
  kind: EdgeKind
  reason: string
}

export interface ContextPack {
  query: string
  repoRoot: string
  projectId: string
  mode: Exclude<ContextMode, 'auto'>
  answerable: boolean
  confidence: Confidence
  brief: string
  freshness: FreshnessReport
  ownerChain: OwnerNode[]
  topology: TopologyEdge[]
  snippets: ContextSnippet[]
  relationships: RelationshipEvidence[]
  nextQueries: string[]
  missingEvidence: string[]
  budgetChars: number
  usedChars: number
}

// ===== Search =====
export interface CodeChunk {
  id: string
  filePath: string
  language: string
  kind: string
  symbolName?: string
  startLine: number
  endLine: number
  content: string
}

export interface SearchHit {
  chunk: CodeChunk
  score: number
  source: 'exact' | 'graph' | 'semantic' | 'keyword'
  reason: string
}

// ===== Graph =====
export interface GraphNode {
  id: string
  label: string
  kind: string
  language: string
  filePath: string
  startLine: number
  endLine: number
  exported: boolean
  signature?: string
}

export interface GraphEdge {
  sourceId: string
  targetId: string
  kind: EdgeKind
  metadata?: Record<string, unknown>
}

export interface GraphResponse {
  nodes: GraphNode[]
  edges: GraphEdge[]
  total: number
  shown: number
  totalEdges: number
}

export interface SymbolNode {
  id: string
  filePath: string
  name: string
  kind: string
  language: string
  startLine: number
  endLine: number
  signature?: string
  exported?: boolean
}

// ===== Impact / trace / tests / reuse =====
export interface ImpactReference {
  edge: EdgeKind
  sourceFile?: string
  targetFile?: string
  sourceSymbol?: string
  targetSymbol?: string
  targetName?: string
  reason: string
  confidence: Confidence
}

export interface ImpactPackItem {
  filePath: string
  role: string
  reason: string
  symbols: Array<{ name: string; kind: string; startLine: number; endLine: number }>
}

export interface ImpactAnalysis {
  target: string
  minimalPack: ImpactPackItem[]
  references: ImpactReference[]
  nextQueries: string[]
  matchedSymbols: SymbolNode[]
  impactedFiles: string[]
  incomingEdges: GraphEdge[]
  outgoingEdges: GraphEdge[]
  riskLevel: RiskLevel
}

export interface TraceStep {
  filePath: string
  symbolName: string
  kind: EdgeKind
  targetName?: string
  targetFile?: string
  line?: number
}

export interface TraceFlow {
  entry: string
  steps: TraceStep[]
  truncated: boolean
}

export interface RelatedTests {
  target: string
  tests: Array<{ path: string; language: string }>
  references: ImpactReference[]
  missingLikelyTests: string[]
}

export interface ReuseCandidate {
  filePath: string
  symbolName?: string
  kind: string
  score: number
  confidence: Confidence
  exported: boolean
  callerCount: number
  relatedTestCount: number
  reasons: string[]
  whyReuse: string[]
  snippet?: ContextSnippet
}

export interface ReuseCandidateReport {
  query: string
  decision: 'reuse' | 'extend' | 'wrap' | 'implement_new' | 'uncertain'
  confidence: Confidence
  candidates: ReuseCandidate[]
  duplicateRisk: RiskLevel
  missingEvidence: string[]
  nextQueries: string[]
}

// ===== Verified subgraph =====
export interface SubgraphNode {
  id: string
  filePath: string
  symbolName?: string
  kind: string
  role: string
  startLine?: number
  endLine?: number
  exported?: boolean
  confidence: Confidence
  reason: string
}

export interface VerifiedSubgraphEdge {
  fromNodeId: string
  toNodeId: string
  kind: EdgeKind
  confidence: Confidence
  source: string
  reason: string
}

export interface CoverageSignal {
  name: string
  status: 'pass' | 'partial' | 'fail'
  detail: string
}

export interface VerifiedCodeSubgraph {
  query: string
  mode: VerifiedSubgraphMode
  answerable: boolean
  confidence: Confidence
  nodes: SubgraphNode[]
  edges: VerifiedSubgraphEdge[]
  paths: string[][]
  snippets: ContextSnippet[]
  coverage: CoverageSignal[]
  missingEvidence: string[]
  nextQueries: string[]
}

// ===== Watch =====
export interface WatchSchedulerStatus {
  running: boolean
  scheduled: boolean
  indexing: boolean
  pendingFiles: number
  indexingFiles: number
  lastIndexedAtMs?: number
  lastError?: string
}

export interface WatchDaemonStatus {
  repoRoot: string
  running: boolean
  ready: boolean
  bufferedEvents: number
  scheduler: WatchSchedulerStatus
}

// ===== API surface =====
export const configApi = {
  get: () => api.get<Config>('/config'),
  update: (config: Partial<Config>) => api.post('/config', config),
}

export const indexApi = {
  status: () => api.get<IndexStatus>('/status'),
  trigger: (repoPath: string) => api.post<{ success: boolean; status: IndexStatus }>('/index', { repoPath }),
  refresh: () => api.post<{ success: boolean; status: IndexStatus }>('/refresh'),
  languages: () => api.get<{ languages: Array<{ language: string; count: number }> }>('/languages'),
}

export const contextApi = {
  get: (params: { query: string; mode?: ContextMode; budgetChars?: number }) =>
    api.post<ContextPack>('/context', params),
  search: (params: { query: string; mode?: ContextMode; limit?: number }) =>
    api.post<{ hits: SearchHit[] }>('/search', params),
}

export const graphApi = {
  get: (params?: { language?: string; kind?: string; limit?: number }) =>
    api.get<GraphResponse>('/graph', { params }),
  symbol: (name: string) => api.get<{ symbols: SymbolNode[] }>(`/symbol/${encodeURIComponent(name)}`),
  file: (filePath: string) => api.get('/file', { params: { path: filePath } }),
}

export const analysisApi = {
  impact: (target: string) => api.post<ImpactAnalysis>('/impact', { target }),
  trace: (entry: string, maxSteps?: number) => api.post<TraceFlow>('/trace', { entry, maxSteps }),
  relatedTests: (target: string) => api.post<RelatedTests>('/related-tests', { target }),
  reuse: (query: string, limit?: number) => api.post<ReuseCandidateReport>('/reuse', { query, limit }),
  subgraph: (params: { query: string; mode?: VerifiedSubgraphMode; maxHops?: number; budgetChars?: number }) =>
    api.post<VerifiedCodeSubgraph>('/subgraph', params),
}

export const watchApi = {
  status: () => api.get<{ running: boolean; status: WatchDaemonStatus | null }>('/watch/status'),
  start: () => api.post('/watch/start'),
  stop: () => api.post('/watch/stop'),
}

export default api
