export type LanguageId =
  | "typescript"
  | "javascript"
  | "python"
  | "rust"
  | "go"
  | "java"
  | "markdown"
  | "json"
  | "unknown";

export type ChunkKind = "file" | "function" | "class" | "method" | "type" | "variable" | "block";
export type ContextMode = "auto" | "debug" | "feature" | "refactor" | "review" | "explain";

export interface CodeFile {
  projectId: string;
  path: string;
  absolutePath: string;
  language: LanguageId;
  sizeBytes: number;
  contentHash: string;
  modifiedAtMs: number;
}

export interface CodeChunk {
  id: string;
  projectId: string;
  repoRoot: string;
  filePath: string;
  language: LanguageId;
  kind: ChunkKind;
  symbolName?: string;
  startLine: number;
  endLine: number;
  content: string;
  contentHash: string;
}

export type SymbolKind = "file" | "function" | "class" | "method" | "type" | "variable" | "unknown";

export interface SymbolNode {
  id: string;
  projectId: string;
  filePath: string;
  name: string;
  kind: SymbolKind;
  language: LanguageId;
  startLine: number;
  endLine: number;
  signature?: string;
  exported?: boolean;
}

export type EdgeKind =
  | "contains"
  | "imports"
  | "exports"
  | "calls"
  | "references"
  | "tested_by"
  | "related"
  | "handles_event"
  | "calls_api"
  | "routes_to"
  | "uses_middleware"
  | "handles_webhook"
  | "reads_from"
  | "writes_to";

export interface GraphEdge {
  projectId: string;
  sourceId: string;
  targetId: string;
  kind: EdgeKind;
  metadata?: Record<string, unknown>;
}

export interface RepoIndex {
  projectId: string;
  project?: ProjectIdentity;
  repoRoot: string;
  indexedAtMs: number;
  indexGeneration: number;
  changedFiles: string[];
  deletedFiles: string[];
  affectedFiles?: string[];
  scannedFiles?: string[];
  refreshedFiles?: string[];
  fullReindex: boolean;
  files: CodeFile[];
  chunks: CodeChunk[];
  symbols: SymbolNode[];
  edges: GraphEdge[];
  skippedFiles: Array<{ filePath: string; reason: string }>;
}

export interface IndexRefreshOptions {
  affectedFiles?: string[];
  reconcile?: boolean;
}

export type DirtyFileStatus = "pending" | "indexing" | "dead_letter";

export interface DirtyFile {
  projectId: string;
  filePath: string;
  status: DirtyFileStatus;
  reason: string;
  firstSeenAtMs: number;
  lastSeenAtMs: number;
  eventCount: number;
}

export interface WatcherState {
  projectId: string;
  dirtyFiles: DirtyFile[];
  pendingFiles: string[];
  indexingFiles: string[];
  burstMode: boolean;
  droppedEvents: number;
  lastEventAtMs?: number;
  updatedAtMs?: number;
}

export interface WatcherEventOptions {
  burstThreshold?: number;
  maxDirtyFiles?: number;
}

export interface SearchQuery {
  projectId?: string;
  repoRoot?: string;
  workspace?: WorkspaceHint;
  query: string;
  limit?: number;
  mode?: ContextMode;
}

export interface SearchHit {
  chunk: CodeChunk;
  score: number;
  scoreBreakdown?: SearchScoreBreakdown;
  source: "exact" | "graph" | "semantic" | "keyword";
  reason: string;
}

export interface SearchScoreBreakdown {
  keyword?: number;
  semantic?: number;
  sourceNormalized?: number;
  modeBoost?: number;
  graphAdjustment?: number;
  final: number;
}

export interface ContextRequest extends SearchQuery {
  budgetChars?: number;
  diff?: string;
  changedFiles?: string[];
}

export type VerifiedSubgraphMode = "impact" | "flow" | "review" | "debug";
export type SubgraphOutputPreset = "compact" | "agent_edit" | "debug_trace" | "review_risk";

export interface VerifiedSubgraphRequest {
  projectId?: string;
  repoRoot?: string;
  workspace?: WorkspaceHint;
  query: string;
  seed?: string;
  mode?: VerifiedSubgraphMode;
  budgetChars?: number;
  maxHops?: number;
  preset?: SubgraphOutputPreset;
}

export interface TopologyMapRequest extends SearchQuery {
  budgetChars?: number;
  maxEdges?: number;
}

export interface ContextSnippet {
  filePath: string;
  startLine: number;
  endLine: number;
  content: string;
  score: number;
  reason: string;
  role: string;
  expansionLevel: ExpansionLevel;
  originalLineCount: number;
  returnedLineCount: number;
  elidedLineCount: number;
}

export interface ContextPack {
  query: string;
  repoRoot: string;
  projectId: string;
  mode: Exclude<ContextMode, "auto">;
  answerable: boolean;
  confidence: "low" | "medium" | "high";
  brief: string;
  freshness: FreshnessReport;
  ownerChain: OwnerNode[];
  topology: TopologyEdge[];
  snippets: ContextSnippet[];
  relationships: RelationshipEvidence[];
  nextQueries: string[];
  missingEvidence: string[];
  budgetChars: number;
  usedChars: number;
}

export type ExpansionLevel = "file_card" | "skeleton" | "focused_body" | "full_body";

export interface WorkspaceHint {
  root?: string;
  filePath?: string;
}

export interface ProjectIdentity {
  projectId: string;
  repoRoot: string;
  canonicalRoot: string;
  displayName: string;
  gitRemote?: string;
  gitHead?: string;
  createdAtMs: number;
  lastIndexedAtMs?: number;
}

export interface WorkspaceSession {
  activeProjectId: string;
  activeRepoRoot: string;
  knownProjects: ProjectIdentity[];
  resolvedFrom: "filePath" | "root" | "repoRoot" | "mcp_roots" | "cwd" | "single_project" | "active_session";
}

export interface FreshnessReport {
  projectId: string;
  indexGeneration: number;
  indexedAtMs: number;
  staleFiles: string[];
  pendingFiles: string[];
  indexingFiles: string[];
  skippedFiles: Array<{ filePath: string; reason: string }>;
  dirtyFiles: DirtyFile[];
  burstMode: boolean;
  droppedEvents: number;
}

export interface OwnerNode {
  filePath: string;
  role: string;
  reason: string;
  score: number;
  symbols: Array<{
    name: string;
    kind: string;
    startLine: number;
    endLine: number;
  }>;
}

export interface TopologyEdge {
  from: string;
  to: string;
  edge: EdgeKind;
  confidence: "low" | "medium" | "high";
  reason: string;
  sourceFile?: string;
  targetFile?: string;
}

export interface TopologyMap {
  query: string;
  repoRoot: string;
  projectId: string;
  freshness: FreshnessReport;
  owners: OwnerNode[];
  edges: TopologyEdge[];
  missingEvidence: string[];
  nextQueries: string[];
}

export interface IndexStatus {
  repoRoot: string;
  projectId: string;
  indexedAtMs: number;
  fileCount: number;
  chunkCount: number;
  symbolCount: number;
  edgeCount: number;
  freshFileCount: number;
  staleFileCount: number;
  pendingFileCount: number;
  indexingFileCount: number;
  skippedFileCount: number;
  burstMode: boolean;
  droppedEventCount: number;
  freshness: FreshnessReport;
}

export interface RelationshipEvidence {
  source: string;
  target: string;
  kind: EdgeKind;
  reason: string;
}

export type SubgraphNodeRole =
  | "target"
  | "caller"
  | "callee"
  | "route"
  | "test"
  | "middleware"
  | "resource"
  | "event"
  | "external";

export interface SubgraphCitation {
  filePath?: string;
  line?: number;
  symbol?: string;
  source: VerifiedEdgeSource;
}

export interface SubgraphNode {
  id: string;
  filePath: string;
  symbolName?: string;
  kind: SymbolKind | "external";
  role: SubgraphNodeRole;
  startLine?: number;
  endLine?: number;
  exported?: boolean;
  confidence: "low" | "medium" | "high";
  reason: string;
  citation?: SubgraphCitation;
}

export type VerifiedEdgeSource =
  | "ast"
  | "lsp"
  | "framework_rule"
  | "test_import"
  | "resource_rule"
  | "event_rule"
  | "heuristic";

export interface VerifiedSubgraphEdge {
  fromNodeId: string;
  toNodeId: string;
  kind: EdgeKind;
  confidence: "low" | "medium" | "high";
  source: VerifiedEdgeSource;
  reason: string;
  sourceFile?: string;
  targetFile?: string;
  line?: number;
  targetName?: string;
}

export type CoverageSignalName =
  | "primary_owner_found"
  | "inbound_callers_checked"
  | "outbound_flow_checked"
  | "tests_checked"
  | "unresolved_edges_present"
  | "budget_truncated";

export interface CoverageSignal {
  name: CoverageSignalName;
  status: "pass" | "partial" | "fail";
  detail: string;
}

export interface VerifiedCodeSubgraph {
  query: string;
  repoRoot: string;
  projectId: string;
  mode: VerifiedSubgraphMode;
  answerable: boolean;
  confidence: "low" | "medium" | "high";
  nodes: SubgraphNode[];
  edges: VerifiedSubgraphEdge[];
  paths: string[][];
  snippets: ContextSnippet[];
  coverage: CoverageSignal[];
  missingEvidence: string[];
  nextQueries: string[];
  budgetChars: number;
  usedChars: number;
}

export interface ExplainImpactReport {
  target: string;
  riskLevel: "low" | "medium" | "high";
  riskScore: number;
  riskReasons: string[];
  editReadiness: "safe_to_edit_after_reading" | "investigate_only" | "not_enough_context";
  subgraph: VerifiedCodeSubgraph;
}

export interface ExpandNodeResult {
  nodeRef: string;
  filePath: string;
  symbolName?: string;
  expansionLevel: ExpansionLevel;
  snippets: ContextSnippet[];
  missingEvidence: string[];
  budgetChars: number;
  usedChars: number;
}

export interface ReuseCandidateRequest {
  projectId?: string;
  repoRoot?: string;
  workspace?: WorkspaceHint;
  query: string;
  limit?: number;
}

export type ReuseDecision = "reuse" | "extend" | "wrap" | "implement_new" | "uncertain";

export type ReuseCandidateKind =
  | "helper"
  | "service_method"
  | "react_hook"
  | "component"
  | "api_wrapper"
  | "type_or_schema"
  | "test_fixture"
  | "config_constant"
  | "unknown";

export interface ReuseCandidate {
  filePath: string;
  symbolName?: string;
  kind: ReuseCandidateKind;
  score: number;
  confidence: "low" | "medium" | "high";
  exported: boolean;
  callerCount: number;
  relatedTestCount: number;
  reasons: string[];
  whyReuse: string[];
  snippet?: ContextSnippet;
}

export interface ReuseCandidateReport {
  query: string;
  decision: ReuseDecision;
  confidence: "low" | "medium" | "high";
  candidates: ReuseCandidate[];
  duplicateRisk: "low" | "medium" | "high";
  missingEvidence: string[];
  nextQueries: string[];
}

export interface OwnerCandidate {
  filePath: string;
  score: number;
  reasons: string[];
  symbols: SymbolNode[];
}

export interface ImpactAnalysis {
  target: string;
  minimalPack: ImpactPackItem[];
  references: ImpactReference[];
  nextQueries: string[];
  matchedSymbols: SymbolNode[];
  impactedFiles: string[];
  incomingEdges: GraphEdge[];
  outgoingEdges: GraphEdge[];
  riskLevel: "low" | "medium" | "high";
}

export interface ImpactPackItem {
  filePath: string;
  role: "target" | "caller" | "callee" | "test" | "route" | "middleware" | "resource_owner" | "event_owner";
  reason: string;
  symbols: Array<{
    name: string;
    kind: SymbolKind;
    startLine: number;
    endLine: number;
  }>;
}

export interface ImpactReference {
  edge: EdgeKind;
  sourceFile?: string;
  targetFile?: string;
  sourceSymbol?: string;
  targetSymbol?: string;
  targetName?: string;
  reason: string;
  confidence: "low" | "medium" | "high";
}

export interface RelatedTests {
  target: string;
  tests: CodeFile[];
  references: ImpactReference[];
  missingLikelyTests: string[];
}

export interface TraceStep {
  filePath: string;
  symbolName: string;
  kind: EdgeKind;
  targetName?: string;
  targetFile?: string;
  line?: number;
}

export interface TraceFlow {
  entry: string;
  steps: TraceStep[];
  truncated: boolean;
}

export interface DiffReview {
  changedFiles: string[];
  relatedTests: string[];
  riskLevel: "low" | "medium" | "high";
  findings: string[];
}
