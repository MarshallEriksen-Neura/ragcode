import type { GraphStore } from "../core/contracts.js";
import type {
  CodeChunk,
  CodeFile,
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
  TraceFlow
} from "../core/types.js";
import { normalizeUserPath } from "../utils/path.js";

interface RepoGraphState {
  projectId?: string;
  files: Map<string, CodeFile>;
  chunks: Map<string, CodeChunk>;
  symbols: Map<string, SymbolNode>;
  edges: GraphEdge[];
  skippedFiles: Array<{ filePath: string; reason: string }>;
}

export class InMemoryGraphStore implements GraphStore {
  private readonly repos = new Map<string, RepoGraphState>();

  async resetRepo(repoRoot: string): Promise<void> {
    this.repos.set(repoRoot, {
      files: new Map(),
      chunks: new Map(),
      symbols: new Map(),
      edges: [],
      skippedFiles: []
    });
  }

  async upsertIndex(index: RepoIndex): Promise<void> {
    const state = {
      projectId: index.projectId,
      files: new Map<string, CodeFile>(),
      chunks: new Map<string, CodeChunk>(),
      symbols: new Map<string, SymbolNode>(),
      edges: [] as GraphEdge[],
      skippedFiles: index.skippedFiles
    };
    for (const file of index.files) state.files.set(file.path, file);
    for (const chunk of index.chunks) state.chunks.set(chunk.id, chunk);
    for (const symbol of index.symbols) state.symbols.set(symbol.id, symbol);
    state.edges.push(...index.edges);
    this.repos.set(index.repoRoot, state);
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
    const terms = tokenize(query.query);
    if (terms.length === 0) return [];

    const limit = query.limit ?? 20;
    const hits: SearchHit[] = [];
    for (const chunk of this.ensureRepo(repoRoot).chunks.values()) {
      if (query.projectId && chunk.projectId !== query.projectId) continue;
      const haystack = `${chunk.filePath}\n${chunk.symbolName ?? ""}\n${chunk.content}`.toLowerCase();
      let matched = 0;
      for (const term of terms) {
        if (haystack.includes(term)) matched += 1;
      }
      if (matched === 0) continue;
      hits.push({
        chunk,
        score: matched / terms.length,
        source: "keyword",
        reason: `Matched ${matched}/${terms.length} query term(s)`
      });
    }

    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  async findOwner(repoRoot: string, query: string, limit = 5): Promise<OwnerCandidate[]> {
    const state = this.ensureRepo(repoRoot);
    const terms = tokenize(query);
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
      const haystack = `${symbol.name} ${symbol.filePath} ${symbol.signature ?? ""}`.toLowerCase();
      const matched = terms.filter((term) => haystack.includes(term)).length;
      if (matched === 0) continue;
      const existing = candidates.get(symbol.filePath) ?? {
        filePath: symbol.filePath,
        score: 0,
        reasons: [],
        symbols: []
      };
      existing.score += 1 + matched / Math.max(1, terms.length);
      existing.reasons.push(`Symbol match: ${symbol.name}`);
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
    const normalized = normalizeUserPath(target);
    const state = this.ensureRepo(repoRoot);
    const matchedSymbols = [...state.symbols.values()].filter(
      (symbol) => symbol.name.toLowerCase().includes(target.toLowerCase()) || symbol.filePath === normalized || symbol.filePath.includes(normalized)
    );
    const matchedIds = new Set(matchedSymbols.map((symbol) => symbol.id));
    const incomingEdges = state.edges.filter((edge) => matchedIds.has(edge.targetId) || String(edge.metadata?.targetName ?? "").toLowerCase().includes(target.toLowerCase()));
    const outgoingEdges = state.edges.filter((edge) => matchedIds.has(edge.sourceId) || String(edge.metadata?.sourceFile ?? "") === normalized);
    const impactedFiles = new Set<string>();
    for (const edge of [...incomingEdges, ...outgoingEdges]) {
      const source = state.symbols.get(edge.sourceId);
      const targetNode = state.symbols.get(edge.targetId);
      if (source) impactedFiles.add(source.filePath);
      if (targetNode) impactedFiles.add(targetNode.filePath);
      if (typeof edge.metadata?.sourceFile === "string") impactedFiles.add(edge.metadata.sourceFile);
    }
    for (const symbol of matchedSymbols) impactedFiles.add(symbol.filePath);

    const impactCount = impactedFiles.size + incomingEdges.length;
    return {
      target,
      matchedSymbols,
      impactedFiles: [...impactedFiles].sort(),
      incomingEdges,
      outgoingEdges,
      riskLevel: impactCount > 12 ? "high" : impactCount > 4 ? "medium" : "low"
    };
  }

  async relatedTests(repoRoot: string, target: string): Promise<RelatedTests> {
    const state = this.ensureRepo(repoRoot);
    const normalized = normalizeUserPath(target);
    const basename = normalized.split("/").pop()?.replace(/\.[^.]+$/, "") ?? normalized;
    const tests = [...state.files.values()].filter((file) => isTestFile(file.path) && (file.path.toLowerCase().includes(basename.toLowerCase()) || normalized === target));
    return {
      target,
      tests,
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
      state = { files: new Map(), chunks: new Map(), symbols: new Map(), edges: [], skippedFiles: [] };
      this.repos.set(repoRoot, state);
    }
    return state;
  }
}

function requireRepoRoot(repoRoot: string | undefined): string {
  if (!repoRoot) throw new Error("Internal error: graph search requires a resolved repoRoot.");
  return repoRoot;
}

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_./:-]+/i)
    .map((part) => part.trim())
    .filter(Boolean);
}

function uniqueSymbols(symbols: SymbolNode[]): SymbolNode[] {
  return [...new Map(symbols.map((symbol) => [symbol.id, symbol])).values()];
}

function isTestFile(filePath: string): boolean {
  return /(^|\/)(__tests__|tests?)(\/|$)|\.(test|spec)\.[jt]sx?$/.test(filePath);
}

function extractChangedFiles(diff: string): string[] {
  const files = new Set<string>();
  for (const line of diff.split(/\r?\n/)) {
    const match = /^\+\+\+ b\/(.+)$/.exec(line) ?? /^diff --git a\/.+ b\/(.+)$/.exec(line);
    if (match?.[1] && match[1] !== "/dev/null") files.add(normalizeUserPath(match[1]));
  }
  return [...files].sort();
}

function isTraceEdge(kind: EdgeKind): boolean {
  return kind === "calls" || kind === "calls_api" || kind === "routes_to" || kind === "handles_webhook";
}
