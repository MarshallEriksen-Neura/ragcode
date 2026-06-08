import { DatabaseSync } from "node:sqlite";
import path from "node:path";
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

export class SQLiteGraphStore implements GraphStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  async resetRepo(repoRoot: string): Promise<void> {
    const projectId = this.projectIdForRoot(repoRoot);
    if (!projectId) return;
    this.transaction(() => this.deleteProjectRows(projectId));
  }

  async upsertIndex(index: RepoIndex): Promise<void> {
    const repoRoot = normalizeRepoRoot(index.repoRoot);
    const symbolsByFile = groupByPath(index.symbols);
    const edgesByFile = groupEdgesByPath(index.edges);
    const chunksByFile = groupByPath(index.chunks);

    this.transaction(() => {
      this.db.prepare(
        "INSERT OR REPLACE INTO projects(project_id, repo_root, indexed_at_ms) VALUES (?, ?, ?)"
      ).run(index.projectId, repoRoot, index.indexedAtMs);

      const nextFilePaths = new Set(index.files.map((file) => file.path));
      for (const stalePath of this.filePathsForProject(index.projectId)) {
        if (!nextFilePaths.has(stalePath)) this.deleteFileRows(index.projectId, stalePath);
      }
      for (const file of index.files) this.deleteFileRows(index.projectId, file.path);
      this.db.prepare("DELETE FROM skipped_files WHERE project_id = ?").run(index.projectId);

      const insertFile = this.db.prepare(
        "INSERT INTO files(project_id, path, absolute_path, language, size_bytes, content_hash, modified_at_ms, indexed_at_ms, status, generation) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      );
      const insertSymbol = this.db.prepare(
        "INSERT INTO symbols(project_id, id, file_path, name, kind, language, start_line, end_line, signature, exported, generation) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      );
      const insertEdge = this.db.prepare(
        "INSERT INTO edges(project_id, source_id, target_id, kind, metadata_json, file_path, generation) VALUES (?, ?, ?, ?, ?, ?, ?)"
      );
      const insertChunk = this.db.prepare(
        "INSERT INTO chunks(project_id, id, repo_root, file_path, language, kind, symbol_name, start_line, end_line, content, content_hash, generation) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      );
      const insertFts = this.db.prepare(
        "INSERT INTO chunks_fts(project_id, id, file_path, symbol_name, content) VALUES (?, ?, ?, ?, ?)"
      );

      for (const file of index.files) {
        insertFile.run(file.projectId, file.path, file.absolutePath, file.language, file.sizeBytes, file.contentHash, file.modifiedAtMs, index.indexedAtMs, "fresh", 1);

        for (const symbol of symbolsByFile.get(file.path) ?? []) {
          insertSymbol.run(symbol.projectId, symbol.id, symbol.filePath, symbol.name, symbol.kind, symbol.language, symbol.startLine, symbol.endLine, symbol.signature ?? null, symbol.exported ? 1 : 0, 1);
        }

        for (const edge of edgesByFile.get(file.path) ?? []) {
          insertEdge.run(edge.projectId, edge.sourceId, edge.targetId, edge.kind, JSON.stringify(edge.metadata ?? {}), edgeFilePath(edge), 1);
        }

        for (const chunk of chunksByFile.get(file.path) ?? []) {
          insertChunk.run(chunk.projectId, chunk.id, repoRoot, chunk.filePath, chunk.language, chunk.kind, chunk.symbolName ?? null, chunk.startLine, chunk.endLine, chunk.content, chunk.contentHash, 1);
          insertFts.run(chunk.projectId, chunk.id, chunk.filePath, chunk.symbolName ?? null, chunk.content);
        }
      }

      const insertSkipped = this.db.prepare(
        "INSERT INTO skipped_files(project_id, file_path, reason) VALUES (?, ?, ?)"
      );
      for (const skipped of index.skippedFiles) {
        insertSkipped.run(index.projectId, skipped.filePath, skipped.reason);
      }
    });
  }

  async getFiles(repoRoot: string): Promise<CodeFile[]> {
    const projectId = this.requireProjectId(repoRoot);
    return this.db.prepare("SELECT * FROM files WHERE project_id = ? ORDER BY path").all(projectId).map(fileFromRow);
  }

  async getChunks(repoRoot: string): Promise<CodeChunk[]> {
    const projectId = this.requireProjectId(repoRoot);
    return this.chunksForProject(projectId);
  }

  async getSkippedFiles(repoRoot: string): Promise<Array<{ filePath: string; reason: string }>> {
    const projectId = this.requireProjectId(repoRoot);
    return this.db.prepare("SELECT file_path, reason FROM skipped_files WHERE project_id = ? ORDER BY file_path").all(projectId).map((row) => ({
      filePath: String(row.file_path),
      reason: String(row.reason)
    }));
  }

  async getSymbols(repoRoot: string): Promise<SymbolNode[]> {
    const projectId = this.requireProjectId(repoRoot);
    return this.symbolsForProject(projectId);
  }

  async getEdges(repoRoot: string, kind?: EdgeKind): Promise<GraphEdge[]> {
    const projectId = this.requireProjectId(repoRoot);
    const rows = kind
      ? this.db.prepare("SELECT * FROM edges WHERE project_id = ? AND kind = ? ORDER BY id").all(projectId, kind)
      : this.db.prepare("SELECT * FROM edges WHERE project_id = ? ORDER BY id").all(projectId);
    return rows.map(edgeFromRow);
  }

  async findSymbol(repoRoot: string, name: string): Promise<SymbolNode[]> {
    const projectId = this.requireProjectId(repoRoot);
    const needle = `%${escapeLike(name.toLowerCase())}%`;
    return this.db.prepare(
      "SELECT * FROM symbols WHERE project_id = ? AND lower(name) LIKE ? ESCAPE '\\' ORDER BY name"
    ).all(projectId, needle).map(symbolFromRow);
  }

  async explainFile(repoRoot: string, filePath: string): Promise<{ file?: CodeFile; chunks: CodeChunk[]; symbols: SymbolNode[] }> {
    const projectId = this.requireProjectId(repoRoot);
    const normalized = normalizeUserPath(filePath);
    const file = this.db.prepare("SELECT * FROM files WHERE project_id = ? AND path = ?").get(projectId, normalized);
    return {
      file: file ? fileFromRow(file) : undefined,
      chunks: this.db.prepare("SELECT * FROM chunks WHERE project_id = ? AND file_path = ? ORDER BY start_line").all(projectId, normalized).map(chunkFromRow),
      symbols: this.db.prepare("SELECT * FROM symbols WHERE project_id = ? AND file_path = ? ORDER BY start_line").all(projectId, normalized).map(symbolFromRow)
    };
  }

  async searchText(query: SearchQuery): Promise<SearchHit[]> {
    const repoRoot = requireRepoRoot(query.repoRoot);
    const projectId = this.scopedProjectId(repoRoot, query.projectId);
    const terms = tokenize(query.query);
    if (terms.length === 0) return [];
    const hits: SearchHit[] = [];
    for (const chunk of this.chunksForProject(projectId)) {
      const haystack = `${chunk.filePath}\n${chunk.symbolName ?? ""}\n${chunk.content}`.toLowerCase();
      const matched = terms.filter((term) => haystack.includes(term)).length;
      if (matched === 0) continue;
      hits.push({
        chunk,
        score: matched / terms.length,
        source: "keyword",
        reason: `Matched ${matched}/${terms.length} query term(s)`
      });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, query.limit ?? 20);
  }

  async findOwner(repoRoot: string, query: string, limit = 5): Promise<OwnerCandidate[]> {
    const hits = await this.searchText({ repoRoot, query, limit: limit * 4 });
    const symbols = await this.getSymbols(repoRoot);
    const terms = tokenize(query);
    const candidates = new Map<string, OwnerCandidate>();

    for (const hit of hits) {
      const current = candidates.get(hit.chunk.filePath) ?? { filePath: hit.chunk.filePath, score: 0, reasons: [], symbols: [] };
      current.score += hit.score;
      current.reasons.push(hit.reason);
      candidates.set(hit.chunk.filePath, current);
    }

    for (const symbol of symbols) {
      const haystack = `${symbol.name} ${symbol.filePath} ${symbol.signature ?? ""}`.toLowerCase();
      const matched = terms.filter((term) => haystack.includes(term)).length;
      if (matched === 0) continue;
      const current = candidates.get(symbol.filePath) ?? { filePath: symbol.filePath, score: 0, reasons: [], symbols: [] };
      current.score += 1 + matched / Math.max(1, terms.length);
      current.reasons.push(`Symbol match: ${symbol.name}`);
      current.symbols.push(symbol);
      candidates.set(symbol.filePath, current);
    }

    return [...candidates.values()]
      .map((candidate) => ({ ...candidate, reasons: [...new Set(candidate.reasons)], symbols: uniqueSymbols(candidate.symbols) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  async impactAnalysis(repoRoot: string, target: string): Promise<ImpactAnalysis> {
    const projectId = this.requireProjectId(repoRoot);
    const normalized = normalizeUserPath(target);
    const symbols = this.symbolsForProject(projectId);
    const edges = await this.getEdges(repoRoot);
    const matchedSymbols = symbols.filter(
      (symbol) => symbol.name.toLowerCase().includes(target.toLowerCase()) || symbol.filePath === normalized || symbol.filePath.includes(normalized)
    );
    const matchedIds = new Set(matchedSymbols.map((symbol) => symbol.id));
    const incomingEdges = edges.filter((edge) => matchedIds.has(edge.targetId) || String(edge.metadata?.targetName ?? "").toLowerCase().includes(target.toLowerCase()));
    const outgoingEdges = edges.filter((edge) => matchedIds.has(edge.sourceId) || String(edge.metadata?.sourceFile ?? "") === normalized);
    const impactedFiles = new Set<string>();
    for (const edge of [...incomingEdges, ...outgoingEdges]) {
      const source = symbols.find((symbol) => symbol.id === edge.sourceId);
      const targetNode = symbols.find((symbol) => symbol.id === edge.targetId);
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
    const files = await this.getFiles(repoRoot);
    const normalized = normalizeUserPath(target);
    const basename = normalized.split("/").pop()?.replace(/\.[^.]+$/, "") ?? normalized;
    const tests = files.filter((file) => isTestFile(file.path) && file.path.toLowerCase().includes(basename.toLowerCase()));
    return { target, tests, missingLikelyTests: tests.length === 0 ? [`No indexed test file matched ${basename}.`] : [] };
  }

  async traceFlow(repoRoot: string, entry: string, maxSteps = 20): Promise<TraceFlow> {
    const symbols = await this.findSymbol(repoRoot, entry);
    const startIds = new Set(symbols.map((symbol) => symbol.id));
    const allSymbols = await this.getSymbols(repoRoot);
    const steps = (await this.getEdges(repoRoot))
      .filter((edge) => isTraceEdge(edge.kind) && (startIds.has(edge.sourceId) || String(edge.metadata?.sourceFile ?? "").toLowerCase().includes(entry.toLowerCase())))
      .slice(0, maxSteps)
      .map((edge) => {
        const source = allSymbols.find((symbol) => symbol.id === edge.sourceId);
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

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        project_id TEXT PRIMARY KEY,
        repo_root TEXT NOT NULL,
        indexed_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS files (
        project_id TEXT NOT NULL,
        path TEXT NOT NULL,
        absolute_path TEXT NOT NULL,
        language TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        modified_at_ms REAL NOT NULL,
        indexed_at_ms INTEGER NOT NULL,
        status TEXT NOT NULL,
        generation INTEGER NOT NULL,
        PRIMARY KEY(project_id, path)
      );
      CREATE TABLE IF NOT EXISTS symbols (
        project_id TEXT NOT NULL,
        id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        language TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        signature TEXT,
        exported INTEGER NOT NULL,
        generation INTEGER NOT NULL,
        PRIMARY KEY(project_id, id)
      );
      CREATE TABLE IF NOT EXISTS edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        file_path TEXT,
        generation INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chunks (
        project_id TEXT NOT NULL,
        id TEXT NOT NULL,
        repo_root TEXT NOT NULL,
        file_path TEXT NOT NULL,
        language TEXT NOT NULL,
        kind TEXT NOT NULL,
        symbol_name TEXT,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        generation INTEGER NOT NULL,
        PRIMARY KEY(project_id, id)
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(project_id UNINDEXED, id UNINDEXED, file_path, symbol_name, content);
      CREATE TABLE IF NOT EXISTS skipped_files (
        project_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        reason TEXT NOT NULL,
        PRIMARY KEY(project_id, file_path)
      );
      CREATE INDEX IF NOT EXISTS idx_symbols_project_name ON symbols(project_id, name);
      CREATE INDEX IF NOT EXISTS idx_edges_project_kind ON edges(project_id, kind);
      CREATE INDEX IF NOT EXISTS idx_chunks_project_file ON chunks(project_id, file_path);
    `);
  }

  private deleteProjectRows(projectId: string): void {
    for (const table of ["files", "symbols", "edges", "chunks", "chunks_fts", "skipped_files"]) {
      this.db.prepare(`DELETE FROM ${table} WHERE project_id = ?`).run(projectId);
    }
  }

  private deleteFileRows(projectId: string, filePath: string): void {
    this.db.prepare("DELETE FROM edges WHERE project_id = ? AND file_path = ?").run(projectId, filePath);
    this.db.prepare("DELETE FROM symbols WHERE project_id = ? AND file_path = ?").run(projectId, filePath);
    this.db.prepare("DELETE FROM chunks_fts WHERE project_id = ? AND file_path = ?").run(projectId, filePath);
    this.db.prepare("DELETE FROM chunks WHERE project_id = ? AND file_path = ?").run(projectId, filePath);
    this.db.prepare("DELETE FROM files WHERE project_id = ? AND path = ?").run(projectId, filePath);
  }

  private filePathsForProject(projectId: string): string[] {
    return this.db.prepare("SELECT path FROM files WHERE project_id = ?").all(projectId).map((row) => String(row.path));
  }

  private transaction(fn: () => void): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private projectIdForRoot(repoRoot: string): string | undefined {
    const row = this.db.prepare("SELECT project_id FROM projects WHERE repo_root = ?").get(normalizeRepoRoot(repoRoot));
    return row ? String(row.project_id) : undefined;
  }

  private requireProjectId(repoRoot: string): string {
    const projectId = this.projectIdForRoot(repoRoot);
    if (!projectId) throw new Error(`Repository is not indexed in SQLiteGraphStore: ${repoRoot}`);
    return projectId;
  }

  private scopedProjectId(repoRoot: string, projectId?: string): string {
    const resolvedProjectId = this.requireProjectId(repoRoot);
    if (projectId && projectId !== resolvedProjectId) {
      throw new Error(`Project scope mismatch: repoRoot resolves to ${resolvedProjectId}, but query requested ${projectId}.`);
    }
    return resolvedProjectId;
  }

  private chunksForProject(projectId: string): CodeChunk[] {
    return this.db.prepare("SELECT * FROM chunks WHERE project_id = ? ORDER BY file_path, start_line").all(projectId).map(chunkFromRow);
  }

  private symbolsForProject(projectId: string): SymbolNode[] {
    return this.db.prepare("SELECT * FROM symbols WHERE project_id = ? ORDER BY file_path, start_line").all(projectId).map(symbolFromRow);
  }
}

function fileFromRow(row: Record<string, unknown>): CodeFile {
  return {
    projectId: String(row.project_id),
    path: String(row.path),
    absolutePath: String(row.absolute_path),
    language: String(row.language) as CodeFile["language"],
    sizeBytes: Number(row.size_bytes),
    contentHash: String(row.content_hash),
    modifiedAtMs: Number(row.modified_at_ms)
  };
}

function symbolFromRow(row: Record<string, unknown>): SymbolNode {
  return {
    projectId: String(row.project_id),
    id: String(row.id),
    filePath: String(row.file_path),
    name: String(row.name),
    kind: String(row.kind) as SymbolNode["kind"],
    language: String(row.language) as SymbolNode["language"],
    startLine: Number(row.start_line),
    endLine: Number(row.end_line),
    signature: row.signature === null ? undefined : String(row.signature),
    exported: Boolean(row.exported)
  };
}

function edgeFromRow(row: Record<string, unknown>): GraphEdge {
  return {
    projectId: String(row.project_id),
    sourceId: String(row.source_id),
    targetId: String(row.target_id),
    kind: String(row.kind) as EdgeKind,
    metadata: parseMetadata(row.metadata_json)
  };
}

function chunkFromRow(row: Record<string, unknown>): CodeChunk {
  return {
    projectId: String(row.project_id),
    id: String(row.id),
    repoRoot: String(row.repo_root),
    filePath: String(row.file_path),
    language: String(row.language) as CodeChunk["language"],
    kind: String(row.kind) as CodeChunk["kind"],
    symbolName: row.symbol_name === null ? undefined : String(row.symbol_name),
    startLine: Number(row.start_line),
    endLine: Number(row.end_line),
    content: String(row.content),
    contentHash: String(row.content_hash)
  };
}

function parseMetadata(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function tokenize(query: string): string[] {
  return query.toLowerCase().split(/[^a-z0-9_./:-]+/i).map((part) => part.trim()).filter(Boolean);
}

function uniqueSymbols(symbols: SymbolNode[]): SymbolNode[] {
  return [...new Map(symbols.map((symbol) => [symbol.id, symbol])).values()];
}

function groupByPath<T extends { filePath: string }>(items: T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const current = grouped.get(item.filePath) ?? [];
    current.push(item);
    grouped.set(item.filePath, current);
  }
  return grouped;
}

function groupEdgesByPath(edges: GraphEdge[]): Map<string, GraphEdge[]> {
  const grouped = new Map<string, GraphEdge[]>();
  for (const edge of edges) {
    const filePath = edgeFilePath(edge);
    if (!filePath) continue;
    const current = grouped.get(filePath) ?? [];
    current.push(edge);
    grouped.set(filePath, current);
  }
  return grouped;
}

function edgeFilePath(edge: GraphEdge): string | null {
  return typeof edge.metadata?.sourceFile === "string" ? edge.metadata.sourceFile : null;
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

function requireRepoRoot(repoRoot: string | undefined): string {
  if (!repoRoot) throw new Error("Internal error: SQLite graph search requires a resolved repoRoot.");
  return repoRoot;
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function normalizeRepoRoot(repoRoot: string): string {
  return path.resolve(repoRoot);
}

function isTraceEdge(kind: EdgeKind): boolean {
  return kind === "calls" || kind === "calls_api" || kind === "routes_to" || kind === "handles_webhook";
}
