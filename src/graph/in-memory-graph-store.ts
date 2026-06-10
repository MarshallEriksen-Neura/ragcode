import type { GraphStore } from "../core/contracts.js";
import type {
  CodeChunk,
  CodeFile,
  DirtyFile,
  DiffReview,
  EdgeKind,
  GraphEdge,
  ImpactAnalysis,
  OwnerCandidate,
  RelatedTests,
  RepoIndex,
  SearchHit,
  SearchQuery,
  SymbolNode,
  TraceFlow,
  WatcherEventOptions,
  WatcherState
} from "../core/types.js";
import { buildImpactAnalysis, impactReference } from "./impact-report.js";
import { isIncomingImpactEdge, isOutgoingImpactEdge, matchesImpactTarget, parseImpactTarget } from "./target-matcher.js";
import { normalizeUserPath } from "../utils/path.js";
import { coalesceFileEvents } from "../watch/file-event-coalescer.js";
import { buildQueryMatchProfile, scoreChunkText, scoreSymbolText } from "../retrieval/query-matching.js";
import { extractChangedFiles } from "./diff-files.js";

interface RepoGraphState {
  projectId?: string;
  indexGeneration: number;
  files: Map<string, CodeFile>;
  chunks: Map<string, CodeChunk>;
  symbols: Map<string, SymbolNode>;
  edges: GraphEdge[];
  skippedFiles: Array<{ filePath: string; reason: string }>;
  dirtyFiles: Map<string, DirtyFile>;
  burstMode: boolean;
  droppedEvents: number;
  lastEventAtMs?: number;
  watcherUpdatedAtMs?: number;
}

export class InMemoryGraphStore implements GraphStore {
  private readonly repos = new Map<string, RepoGraphState>();

  async resetRepo(repoRoot: string): Promise<void> {
    this.repos.set(repoRoot, {
      indexGeneration: 0,
      files: new Map(),
      chunks: new Map(),
      symbols: new Map(),
      edges: [],
      skippedFiles: [],
      dirtyFiles: new Map(),
      burstMode: false,
      droppedEvents: 0
    });
  }

  async upsertIndex(index: RepoIndex): Promise<void> {
    const state = index.fullReindex
      ? {
        projectId: index.projectId,
        indexGeneration: index.indexGeneration,
        files: new Map<string, CodeFile>(),
        chunks: new Map<string, CodeChunk>(),
        symbols: new Map<string, SymbolNode>(),
        edges: [] as GraphEdge[],
        skippedFiles: index.skippedFiles,
        dirtyFiles: new Map(),
        burstMode: false,
        droppedEvents: 0
      }
      : this.ensureRepo(index.repoRoot);

    state.projectId = index.projectId;
    state.indexGeneration = index.indexGeneration;
    state.skippedFiles = index.skippedFiles;
    const refreshedOrDeleted = refreshedOrDeletedFiles(index);
    for (const filePath of refreshedOrDeleted) this.deleteFileRows(state, filePath);
    const filesToWrite = index.fullReindex ? index.files : index.files.filter((file) => refreshedOrDeleted.has(file.path));
    const chunksToWrite = index.fullReindex ? index.chunks : index.chunks.filter((chunk) => refreshedOrDeleted.has(chunk.filePath));
    const symbolsToWrite = index.fullReindex ? index.symbols : index.symbols.filter((symbol) => refreshedOrDeleted.has(symbol.filePath));
    const edgesToWrite = index.fullReindex ? index.edges : index.edges.filter((edge) => edgeFilePath(edge) && refreshedOrDeleted.has(edgeFilePath(edge)!));

    for (const file of filesToWrite) state.files.set(file.path, file);
    for (const chunk of chunksToWrite) state.chunks.set(chunk.id, chunk);
    for (const symbol of symbolsToWrite) state.symbols.set(symbol.id, symbol);
    state.edges.push(...edgesToWrite);
    this.clearDirtyRows(state, index.affectedFiles);
    this.repos.set(index.repoRoot, state);
  }

  async getIndexGeneration(repoRoot: string): Promise<number> {
    return this.ensureRepo(repoRoot).indexGeneration;
  }

  async recordFileEvents(repoRoot: string, filePaths: string[], options?: WatcherEventOptions): Promise<WatcherState> {
    const state = this.ensureRepo(repoRoot);
    const projectId = state.projectId ?? "__unindexed__";
    const coalesced = coalesceFileEvents(repoRoot, filePaths, options);
    for (const filePath of coalesced.dirtyFiles) {
      const existing = state.dirtyFiles.get(filePath);
      const now = coalesced.lastEventAtMs;
      state.dirtyFiles.set(filePath, {
        projectId,
        filePath,
        status: "pending",
        reason: coalesced.burstMode ? "watcher burst event" : "watcher file event",
        firstSeenAtMs: existing?.firstSeenAtMs ?? now,
        lastSeenAtMs: now,
        eventCount: (existing?.eventCount ?? 0) + (coalesced.eventCountByFile.get(filePath) ?? 1)
      });
    }
    state.burstMode = state.burstMode || coalesced.burstMode;
    state.droppedEvents += coalesced.droppedEvents;
    state.lastEventAtMs = coalesced.lastEventAtMs;
    state.watcherUpdatedAtMs = coalesced.lastEventAtMs;
    return watcherStateFromMemory(projectId, state);
  }

  async getWatcherState(repoRoot: string): Promise<WatcherState> {
    const state = this.ensureRepo(repoRoot);
    return watcherStateFromMemory(state.projectId ?? "__unindexed__", state);
  }

  async markDirtyFilesIndexing(repoRoot: string, filePaths: string[]): Promise<WatcherState> {
    const state = this.ensureRepo(repoRoot);
    const now = Date.now();
    for (const filePath of filePaths) {
      const existing = state.dirtyFiles.get(filePath);
      if (!existing) continue;
      state.dirtyFiles.set(filePath, {
        ...existing,
        status: "indexing",
        reason: "background batch indexing",
        lastSeenAtMs: now
      });
    }
    state.watcherUpdatedAtMs = now;
    return watcherStateFromMemory(state.projectId ?? "__unindexed__", state);
  }

  async markDirtyFilesDeadLetter(repoRoot: string, filePaths: string[], reason: string): Promise<WatcherState> {
    const state = this.ensureRepo(repoRoot);
    const now = Date.now();
    for (const filePath of filePaths) {
      const existing = state.dirtyFiles.get(filePath);
      if (!existing) continue;
      state.dirtyFiles.set(filePath, {
        ...existing,
        status: "dead_letter",
        reason,
        lastSeenAtMs: now
      });
    }
    state.watcherUpdatedAtMs = now;
    return watcherStateFromMemory(state.projectId ?? "__unindexed__", state);
  }

  async clearDirtyFiles(repoRoot: string, filePaths?: string[]): Promise<void> {
    this.clearDirtyRows(this.ensureRepo(repoRoot), filePaths);
  }

  async getFiles(repoRoot: string): Promise<CodeFile[]> {
    return [...this.ensureRepo(repoRoot).files.values()];
  }

  async getChunks(repoRoot: string): Promise<CodeChunk[]> {
    return [...this.ensureRepo(repoRoot).chunks.values()];
  }

  async getSkippedFiles(repoRoot: string): Promise<Array<{ filePath: string; reason: string }>> {
    return [...this.ensureRepo(repoRoot).skippedFiles];
  }

  async getSymbols(repoRoot: string): Promise<SymbolNode[]> {
    return [...this.ensureRepo(repoRoot).symbols.values()];
  }

  async getEdges(repoRoot: string, kind?: EdgeKind): Promise<GraphEdge[]> {
    const edges = this.ensureRepo(repoRoot).edges;
    return kind ? edges.filter((edge) => edge.kind === kind) : [...edges];
  }

  async findSymbol(repoRoot: string, name: string): Promise<SymbolNode[]> {
    const needle = name.toLowerCase();
    return [...this.ensureRepo(repoRoot).symbols.values()]
      .filter((symbol) => symbol.name.toLowerCase().includes(needle))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async explainFile(repoRoot: string, filePath: string): Promise<{ file?: CodeFile; chunks: CodeChunk[]; symbols: SymbolNode[] }> {
    const normalized = normalizeUserPath(filePath);
    const state = this.ensureRepo(repoRoot);
    return {
      file: state.files.get(normalized),
      chunks: [...state.chunks.values()].filter((chunk) => chunk.filePath === normalized),
      symbols: [...state.symbols.values()].filter((symbol) => symbol.filePath === normalized)
    };
  }

  async searchText(query: SearchQuery): Promise<SearchHit[]> {
    const repoRoot = requireRepoRoot(query.repoRoot);
    const state = this.ensureRepo(repoRoot);
    const scopedSymbols = query.projectId ? [...state.symbols.values()].filter((symbol) => symbol.projectId === query.projectId) : [...state.symbols.values()];
    const profile = buildQueryMatchProfile(query.query, scopedSymbols);
    if (profile.queryTerms.length === 0) return [];

    const limit = query.limit ?? 20;
    const hits: SearchHit[] = [];
    for (const chunk of state.chunks.values()) {
      if (query.projectId && chunk.projectId !== query.projectId) continue;
      const match = scoreChunkText(chunk, profile);
      if (!match) continue;
      hits.push({
        chunk,
        score: match.score,
        source: "keyword",
        reason: match.reason
      });
    }

    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  async findOwner(repoRoot: string, query: string, limit = 5): Promise<OwnerCandidate[]> {
    const state = this.ensureRepo(repoRoot);
    const profile = buildQueryMatchProfile(query, [...state.symbols.values()]);
    const candidates = new Map<string, OwnerCandidate>();

    for (const hit of await this.searchText({ repoRoot, query, limit: limit * 4 })) {
      const existing = candidates.get(hit.chunk.filePath) ?? {
        filePath: hit.chunk.filePath,
        score: 0,
        reasons: [],
        symbols: []
      };
      existing.score += hit.score;
      existing.reasons.push(hit.reason);
      candidates.set(hit.chunk.filePath, existing);
    }

    for (const symbol of state.symbols.values()) {
      const match = scoreSymbolText(symbol, profile);
      if (!match) continue;
      const existing = candidates.get(symbol.filePath) ?? {
        filePath: symbol.filePath,
        score: 0,
        reasons: [],
        symbols: []
      };
      existing.score += 1 + match.score;
      existing.reasons.push(match.reason);
      existing.symbols.push(symbol);
      candidates.set(symbol.filePath, existing);
    }

    return [...candidates.values()]
      .map((candidate) => ({
        ...candidate,
        reasons: [...new Set(candidate.reasons)],
        symbols: uniqueSymbols(candidate.symbols)
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  async impactAnalysis(repoRoot: string, target: string): Promise<ImpactAnalysis> {
    const parsedTarget = parseImpactTarget(target);
    const state = this.ensureRepo(repoRoot);
    const matchedSymbols = [...state.symbols.values()].filter(
      (symbol) => matchesImpactTarget(symbol, parsedTarget)
    );
    const matchedIds = new Set(matchedSymbols.map((symbol) => symbol.id));
    const incomingEdges = state.edges.filter((edge) => isIncomingImpactEdge(edge, matchedIds, parsedTarget));
    const outgoingEdges = state.edges.filter((edge) => isOutgoingImpactEdge(edge, matchedIds, parsedTarget));
    return buildImpactAnalysis({
      target,
      matchedSymbols,
      incomingEdges,
      outgoingEdges,
      symbols: [...state.symbols.values()]
    });
  }

  async relatedTests(repoRoot: string, target: string): Promise<RelatedTests> {
    const state = this.ensureRepo(repoRoot);
    const normalized = normalizeUserPath(target);
    const basename = normalized.split("/").pop()?.replace(/\.[^.]+$/, "") ?? normalized;
    const matchedIds = new Set([...state.symbols.values()]
      .filter((symbol) => matchesTarget(symbol, normalized, target))
      .map((symbol) => symbol.id));
    const graphTestsByPath = new Map<string, CodeFile>();
    const references = [];
    for (const edge of state.edges) {
      if (edge.kind !== "tested_by") continue;
      const sourceFile = typeof edge.metadata?.sourceFile === "string" ? edge.metadata.sourceFile : undefined;
      if (!matchedIds.has(edge.sourceId) && sourceFile !== normalized) continue;
      const targetSymbol = state.symbols.get(edge.targetId);
      if (!targetSymbol || !isTestFile(targetSymbol.filePath)) continue;
      const file = state.files.get(targetSymbol.filePath);
      if (file) graphTestsByPath.set(file.path, file);
      references.push(impactReference(edge, state.symbols));
    }
    const testsByPath = graphTestsByPath.size > 0 ? graphTestsByPath : filenameTestMatches(state.files, basename, normalized, target);
    const tests = [...testsByPath.values()].sort((a, b) => a.path.localeCompare(b.path));
    return {
      target,
      tests,
      references,
      missingLikelyTests: tests.length === 0 ? [`No indexed test file matched ${basename}.`] : []
    };
  }

  async traceFlow(repoRoot: string, entry: string, maxSteps = 20): Promise<TraceFlow> {
    const state = this.ensureRepo(repoRoot);
    const starts = await this.findSymbol(repoRoot, entry);
    const startIds = new Set(starts.map((symbol) => symbol.id));
    const steps = state.edges
      .filter((edge) => isTraceEdge(edge.kind) && (startIds.has(edge.sourceId) || String(edge.metadata?.sourceFile ?? "").toLowerCase().includes(entry.toLowerCase())))
      .slice(0, maxSteps)
      .map((edge) => {
        const source = state.symbols.get(edge.sourceId);
        return {
          filePath: source?.filePath ?? String(edge.metadata?.sourceFile ?? "unknown"),
          symbolName: source?.name ?? "unknown",
          kind: edge.kind,
          targetName: typeof edge.metadata?.targetName === "string" ? edge.metadata.targetName : undefined,
          targetFile: typeof edge.metadata?.targetFile === "string" ? edge.metadata.targetFile : undefined,
          line: typeof edge.metadata?.line === "number" ? edge.metadata.line : undefined
        };
      });
    return { entry, steps, truncated: steps.length === maxSteps };
  }

  async reviewDiff(repoRoot: string, diff?: string, changedFiles: string[] = []): Promise<DiffReview> {
    const files = changedFiles.length > 0 ? changedFiles.map(normalizeUserPath) : extractChangedFiles(diff ?? "");
    const tests = new Set<string>();
    const findings: string[] = [];
    let riskScore = 0;
    for (const file of files) {
      const related = await this.relatedTests(repoRoot, file);
      for (const test of related.tests) tests.add(test.path);
      if (related.tests.length === 0 && !isTestFile(file)) findings.push(`No directly related test file found for ${file}.`);
      const impact = await this.impactAnalysis(repoRoot, file);
      riskScore += impact.impactedFiles.length;
    }
    return {
      changedFiles: files,
      relatedTests: [...tests].sort(),
      riskLevel: riskScore > 12 ? "high" : riskScore > 4 ? "medium" : "low",
      findings
    };
  }

  private ensureRepo(repoRoot: string): RepoGraphState {
    let state = this.repos.get(repoRoot);
    if (!state) {
      state = { indexGeneration: 0, files: new Map(), chunks: new Map(), symbols: new Map(), edges: [], skippedFiles: [], dirtyFiles: new Map(), burstMode: false, droppedEvents: 0 };
      this.repos.set(repoRoot, state);
    }
    return state;
  }

  private clearDirtyRows(state: RepoGraphState, filePaths?: string[]): void {
    if (!filePaths) {
      state.dirtyFiles.clear();
      state.burstMode = false;
      state.droppedEvents = 0;
      state.watcherUpdatedAtMs = Date.now();
      return;
    }
    for (const filePath of filePaths) state.dirtyFiles.delete(filePath);
    if (state.dirtyFiles.size === 0) state.burstMode = false;
    state.watcherUpdatedAtMs = Date.now();
  }

  private deleteFileRows(state: RepoGraphState, filePath: string): void {
    state.files.delete(filePath);
    for (const [chunkId, chunk] of state.chunks.entries()) {
      if (chunk.filePath === filePath) state.chunks.delete(chunkId);
    }
    for (const [symbolId, symbol] of state.symbols.entries()) {
      if (symbol.filePath === filePath) state.symbols.delete(symbolId);
    }
    state.edges = state.edges.filter((edge) => edgeFilePath(edge) !== filePath);
  }
}

function requireRepoRoot(repoRoot: string | undefined): string {
  if (!repoRoot) throw new Error("Internal error: graph search requires a resolved repoRoot.");
  return repoRoot;
}

function uniqueSymbols(symbols: SymbolNode[]): SymbolNode[] {
  return [...new Map(symbols.map((symbol) => [symbol.id, symbol])).values()];
}

function isTestFile(filePath: string): boolean {
  return /(^|\/)(__tests__|tests?)(\/|$)|\.(test|spec)\.[jt]sx?$/.test(filePath);
}

function filenameTestMatches(files: Map<string, CodeFile>, basename: string, normalized: string, target: string): Map<string, CodeFile> {
  const tests = new Map<string, CodeFile>();
  for (const file of files.values()) {
    if (isTestFile(file.path) && (file.path.toLowerCase().includes(basename.toLowerCase()) || normalized === target)) {
      tests.set(file.path, file);
    }
  }
  return tests;
}

function edgeFilePath(edge: GraphEdge): string | undefined {
  return typeof edge.metadata?.sourceFile === "string" ? edge.metadata.sourceFile : undefined;
}

function refreshedOrDeletedFiles(index: RepoIndex): Set<string> {
  return new Set(index.fullReindex ? index.files.map((file) => file.path) : [...(index.refreshedFiles ?? index.changedFiles), ...index.deletedFiles]);
}

function isTraceEdge(kind: EdgeKind): boolean {
  return kind === "calls"
    || kind === "calls_api"
    || kind === "routes_to"
    || kind === "handles_webhook"
    || kind === "handles_event"
    || kind === "tested_by"
    || kind === "uses_middleware"
    || kind === "reads_from"
    || kind === "writes_to";
}

function matchesTarget(symbol: SymbolNode, normalized: string, target: string): boolean {
  return matchesImpactTarget(symbol, parseImpactTarget(target || normalized));
}

function watcherStateFromMemory(projectId: string, state: RepoGraphState): WatcherState {
  const dirtyFiles = [...state.dirtyFiles.values()].sort((a, b) => a.filePath.localeCompare(b.filePath));
  return {
    projectId,
    dirtyFiles,
    pendingFiles: dirtyFiles.filter((file) => file.status === "pending").map((file) => file.filePath),
    indexingFiles: dirtyFiles.filter((file) => file.status === "indexing").map((file) => file.filePath),
    burstMode: state.burstMode,
    droppedEvents: state.droppedEvents,
    lastEventAtMs: state.lastEventAtMs,
    updatedAtMs: state.watcherUpdatedAtMs
  };
}
