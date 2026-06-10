import { DatabaseSync } from "node:sqlite";
import path from "node:path";
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
  ProjectIdentity,
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
import { SqliteStatements } from "./sqlite-statements.js";
import { coalesceFileEvents } from "../watch/file-event-coalescer.js";
import { buildQueryMatchProfile, scoreChunkText, scoreSymbolText } from "../retrieval/query-matching.js";
import { extractChangedFiles } from "./diff-files.js";

export class SQLiteGraphStore implements GraphStore {
  private readonly db: DatabaseSync;
  private readonly sql: SqliteStatements;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA journal_mode = DELETE");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
    this.sql = new SqliteStatements(this.db);
  }

  close(): void {
    this.db.close();
  }

  async getProjectByRoot(repoRoot: string): Promise<ProjectIdentity | undefined> {
    const root = normalizeRepoRoot(repoRoot);
    const row = this.sql.selectProjectByRoot.get(root, root);
    return row ? projectFromRow(row) : undefined;
  }

  async listProjects(): Promise<ProjectIdentity[]> {
    return this.sql.listProjects.all().map(projectFromRow);
  }

  async getIndexGeneration(repoRoot: string): Promise<number> {
    const root = normalizeRepoRoot(repoRoot);
    const row = this.sql.selectProjectByRoot.get(root, root);
    return row ? Number((row as Record<string, unknown>).index_generation ?? 0) : 0;
  }

  async recordFileEvents(repoRoot: string, filePaths: string[], options?: WatcherEventOptions): Promise<WatcherState> {
    const projectId = this.requireProjectId(repoRoot);
    const coalesced = coalesceFileEvents(repoRoot, filePaths, options);
    this.transaction(() => {
      for (const filePath of coalesced.dirtyFiles) {
        const eventCount = coalesced.eventCountByFile.get(filePath) ?? 1;
        this.db.prepare(`
          INSERT INTO dirty_files(project_id, file_path, status, reason, first_seen_at_ms, last_seen_at_ms, event_count)
          VALUES (?, ?, 'pending', ?, ?, ?, ?)
          ON CONFLICT(project_id, file_path) DO UPDATE SET
            status = 'pending',
            reason = excluded.reason,
            last_seen_at_ms = excluded.last_seen_at_ms,
            event_count = dirty_files.event_count + excluded.event_count
        `).run(projectId, filePath, coalesced.burstMode ? "watcher burst event" : "watcher file event", coalesced.lastEventAtMs, coalesced.lastEventAtMs, eventCount);
      }
      this.db.prepare(`
        INSERT INTO watcher_state(project_id, burst_mode, dropped_events, last_event_at_ms, updated_at_ms)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(project_id) DO UPDATE SET
          burst_mode = CASE WHEN watcher_state.burst_mode = 1 OR excluded.burst_mode = 1 THEN 1 ELSE 0 END,
          dropped_events = watcher_state.dropped_events + excluded.dropped_events,
          last_event_at_ms = excluded.last_event_at_ms,
          updated_at_ms = excluded.updated_at_ms
      `).run(projectId, coalesced.burstMode ? 1 : 0, coalesced.droppedEvents, coalesced.lastEventAtMs, coalesced.lastEventAtMs);
    });
    return this.watcherStateForProject(projectId);
  }

  async getWatcherState(repoRoot: string): Promise<WatcherState> {
    return this.watcherStateForProject(this.requireProjectId(repoRoot));
  }

  async markDirtyFilesIndexing(repoRoot: string, filePaths: string[]): Promise<WatcherState> {
    const projectId = this.requireProjectId(repoRoot);
    const now = Date.now();
    this.transaction(() => {
      for (const filePath of filePaths) {
        this.db.prepare(`
          UPDATE dirty_files
          SET status = 'indexing', reason = 'background batch indexing', last_seen_at_ms = ?
          WHERE project_id = ? AND file_path = ?
        `).run(now, projectId, filePath);
      }
      this.db.prepare(`
        INSERT INTO watcher_state(project_id, burst_mode, dropped_events, last_event_at_ms, updated_at_ms)
        VALUES (?, 0, 0, ?, ?)
        ON CONFLICT(project_id) DO UPDATE SET updated_at_ms = excluded.updated_at_ms
      `).run(projectId, now, now);
    });
    return this.watcherStateForProject(projectId);
  }

  async markDirtyFilesDeadLetter(repoRoot: string, filePaths: string[], reason: string): Promise<WatcherState> {
    const projectId = this.requireProjectId(repoRoot);
    const now = Date.now();
    this.transaction(() => {
      for (const filePath of filePaths) {
        this.db.prepare(`
          UPDATE dirty_files
          SET status = 'dead_letter', reason = ?, last_seen_at_ms = ?
          WHERE project_id = ? AND file_path = ?
        `).run(reason, now, projectId, filePath);
      }
      this.db.prepare(`
        INSERT INTO watcher_state(project_id, burst_mode, dropped_events, last_event_at_ms, updated_at_ms)
        VALUES (?, 0, 0, ?, ?)
        ON CONFLICT(project_id) DO UPDATE SET updated_at_ms = excluded.updated_at_ms
      `).run(projectId, now, now);
    });
    return this.watcherStateForProject(projectId);
  }

  async clearDirtyFiles(repoRoot: string, filePaths?: string[]): Promise<void> {
    const projectId = this.requireProjectId(repoRoot);
    this.transaction(() => this.clearDirtyRows(projectId, filePaths));
  }

  async resetRepo(repoRoot: string): Promise<void> {
    const projectId = this.projectIdForRoot(repoRoot);
    if (!projectId) return;
    this.transaction(() => this.deleteProjectRows(projectId));
  }

  async upsertIndex(index: RepoIndex): Promise<void> {
    const repoRoot = normalizeRepoRoot(index.repoRoot);
    const project = index.project ?? fallbackProjectIdentity(index.projectId, repoRoot, index.indexedAtMs);
    const symbolsByFile = groupByPath(index.symbols);
    const edgesByFile = groupEdgesByPath(index.edges);
    const chunksByFile = groupByPath(index.chunks);

    this.transaction(() => {
      this.sql.upsertProject.run(
        project.projectId,
        normalizeRepoRoot(project.repoRoot),
        normalizeRepoRoot(project.canonicalRoot),
        project.displayName,
        project.gitRemote ?? null,
        project.gitHead ?? null,
        project.createdAtMs,
        project.lastIndexedAtMs ?? index.indexedAtMs,
        index.indexedAtMs,
        index.indexGeneration
      );

      const changedOrDeleted = refreshedOrDeletedFiles(index);
      if (index.fullReindex) {
        const nextFilePaths = new Set(index.files.map((file) => file.path));
        for (const stalePath of this.filePathsForProject(index.projectId)) {
          if (!nextFilePaths.has(stalePath)) this.deleteFileRows(index.projectId, stalePath);
        }
      }
      for (const filePath of changedOrDeleted) this.deleteFileRows(index.projectId, filePath);
      this.sql.deleteSkippedFiles.run(index.projectId);

      const filesToWrite = index.fullReindex ? index.files : index.files.filter((file) => changedOrDeleted.has(file.path));
      for (const file of filesToWrite) {
        this.sql.insertFile.run(file.projectId, file.path, file.absolutePath, file.language, file.sizeBytes, file.contentHash, file.modifiedAtMs, index.indexedAtMs, "fresh", index.indexGeneration);

        for (const symbol of symbolsByFile.get(file.path) ?? []) {
          this.sql.insertSymbol.run(symbol.projectId, symbol.id, symbol.filePath, symbol.name, symbol.kind, symbol.language, symbol.startLine, symbol.endLine, symbol.signature ?? null, symbol.exported ? 1 : 0, index.indexGeneration);
        }

        for (const edge of edgesByFile.get(file.path) ?? []) {
          this.sql.insertEdge.run(edge.projectId, edge.sourceId, edge.targetId, edge.kind, JSON.stringify(edge.metadata ?? {}), edgeFilePath(edge), index.indexGeneration);
        }

        for (const chunk of chunksByFile.get(file.path) ?? []) {
          this.sql.insertChunk.run(chunk.projectId, chunk.id, repoRoot, chunk.filePath, chunk.language, chunk.kind, chunk.symbolName ?? null, chunk.startLine, chunk.endLine, chunk.content, chunk.contentHash, index.indexGeneration);
          this.sql.insertFts.run(chunk.projectId, chunk.id, chunk.filePath, chunk.symbolName ?? null, chunk.content);
        }
      }

      for (const skipped of index.skippedFiles) {
        this.sql.insertSkippedFile.run(index.projectId, skipped.filePath, skipped.reason);
      }
      this.clearDirtyRows(index.projectId, index.affectedFiles);
    });
  }

  async getFiles(repoRoot: string): Promise<CodeFile[]> {
    const projectId = this.requireProjectId(repoRoot);
    return this.sql.selectFiles.all(projectId).map(fileFromRow);
  }

  async getChunks(repoRoot: string): Promise<CodeChunk[]> {
    const projectId = this.requireProjectId(repoRoot);
    return this.chunksForProject(projectId);
  }

  async getSkippedFiles(repoRoot: string): Promise<Array<{ filePath: string; reason: string }>> {
    const projectId = this.requireProjectId(repoRoot);
    return this.sql.selectSkippedFiles.all(projectId).map((row: any) => ({
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
      ? this.sql.selectEdgesByKind.all(projectId, kind)
      : this.sql.selectEdges.all(projectId);
    return rows.map(edgeFromRow);
  }

  async findSymbol(repoRoot: string, name: string): Promise<SymbolNode[]> {
    const projectId = this.requireProjectId(repoRoot);
    const needle = `%${escapeLike(name.toLowerCase())}%`;
    return this.sql.selectSymbolByNameLike.all(projectId, needle).map(symbolFromRow);
  }

  async explainFile(repoRoot: string, filePath: string): Promise<{ file?: CodeFile; chunks: CodeChunk[]; symbols: SymbolNode[] }> {
    const projectId = this.requireProjectId(repoRoot);
    const normalized = normalizeUserPath(filePath);
    const file = this.sql.selectFile.get(projectId, normalized);
    return {
      file: file ? fileFromRow(file) : undefined,
      chunks: this.sql.selectChunksByFile.all(projectId, normalized).map(chunkFromRow),
      symbols: this.sql.selectSymbolsByFile.all(projectId, normalized).map(symbolFromRow)
    };
  }

  async searchText(query: SearchQuery): Promise<SearchHit[]> {
    const repoRoot = requireRepoRoot(query.repoRoot);
    const projectId = this.scopedProjectId(repoRoot, query.projectId);
    const profile = buildQueryMatchProfile(query.query, this.symbolsForProject(projectId));
    if (profile.queryTerms.length === 0) return [];
    const ftsQuery = ftsQueryForTerms(profile.ftsTerms);
    if (!ftsQuery) return [];
    const rows = this.sql.searchFts.all(projectId, ftsQuery, Math.max(query.limit ?? 20, 20) * 4);
    const hits: SearchHit[] = [];
    for (const row of rows) {
      const chunk = chunkFromRow(row);
      const match = scoreChunkText(chunk, profile);
      if (!match) continue;
      const rank = Number((row as Record<string, unknown>).rank);
      const rankSignal = Number.isFinite(rank) ? Math.min(0.25, Math.log1p(Math.max(0, -rank))) : 0;
      hits.push({
        chunk,
        score: match.score + rankSignal,
        source: "keyword",
        reason: `FTS MATCH ${match.reason}; bm25=${formatRank(rank)}`
      });
    }
    return hits.sort((a, b) => b.score - a.score || a.chunk.filePath.localeCompare(b.chunk.filePath)).slice(0, query.limit ?? 20);
  }

  async findOwner(repoRoot: string, query: string, limit = 5): Promise<OwnerCandidate[]> {
    const hits = await this.searchText({ repoRoot, query, limit: limit * 4 });
    const symbols = await this.getSymbols(repoRoot);
    const profile = buildQueryMatchProfile(query, symbols);
    const candidates = new Map<string, OwnerCandidate>();

    for (const hit of hits) {
      const current = candidates.get(hit.chunk.filePath) ?? { filePath: hit.chunk.filePath, score: 0, reasons: [], symbols: [] };
      current.score += hit.score;
      current.reasons.push(hit.reason);
      candidates.set(hit.chunk.filePath, current);
    }

    for (const symbol of symbols) {
      const match = scoreSymbolText(symbol, profile);
      if (!match) continue;
      const current = candidates.get(symbol.filePath) ?? { filePath: symbol.filePath, score: 0, reasons: [], symbols: [] };
      current.score += 1 + match.score;
      current.reasons.push(match.reason);
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
    const parsedTarget = parseImpactTarget(target);
    const symbols = this.symbolsForProject(projectId);
    const edges = await this.getEdges(repoRoot);
    const matchedSymbols = symbols.filter(
      (symbol) => matchesImpactTarget(symbol, parsedTarget)
    );
    const matchedIds = new Set(matchedSymbols.map((symbol) => symbol.id));
    const incomingEdges = edges.filter((edge) => isIncomingImpactEdge(edge, matchedIds, parsedTarget));
    const outgoingEdges = edges.filter((edge) => isOutgoingImpactEdge(edge, matchedIds, parsedTarget));
    return buildImpactAnalysis({
      target,
      matchedSymbols,
      incomingEdges,
      outgoingEdges,
      symbols
    });
  }

  async relatedTests(repoRoot: string, target: string): Promise<RelatedTests> {
    const files = await this.getFiles(repoRoot);
    const symbols = await this.getSymbols(repoRoot);
    const edges = await this.getEdges(repoRoot);
    const symbolsById = new Map(symbols.map((symbol) => [symbol.id, symbol]));
    const filesByPath = new Map(files.map((file) => [file.path, file]));
    const normalized = normalizeUserPath(target);
    const basename = normalized.split("/").pop()?.replace(/\.[^.]+$/, "") ?? normalized;
    const matchedIds = new Set(symbols
      .filter((symbol) => matchesTarget(symbol, normalized, target))
      .map((symbol) => symbol.id));
    const graphTestsByPath = new Map<string, CodeFile>();
    const references = [];
    for (const edge of edges) {
      if (edge.kind !== "tested_by") continue;
      const sourceFile = typeof edge.metadata?.sourceFile === "string" ? edge.metadata.sourceFile : undefined;
      if (!matchedIds.has(edge.sourceId) && sourceFile !== normalized) continue;
      const targetSymbol = symbolsById.get(edge.targetId);
      if (!targetSymbol || !isTestFile(targetSymbol.filePath)) continue;
      const file = filesByPath.get(targetSymbol.filePath);
      if (file) graphTestsByPath.set(file.path, file);
      references.push(impactReference(edge, symbolsById));
    }
    const testsByPath = graphTestsByPath.size > 0 ? graphTestsByPath : filenameTestMatches(files, basename);
    const tests = [...testsByPath.values()].sort((a, b) => a.path.localeCompare(b.path));
    return { target, tests, references, missingLikelyTests: tests.length === 0 ? [`No indexed test file matched ${basename}.`] : [] };
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
        canonical_root TEXT,
        display_name TEXT,
        git_remote TEXT,
        git_head TEXT,
        created_at_ms INTEGER,
        last_indexed_at_ms INTEGER,
        index_generation INTEGER,
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
      CREATE TABLE IF NOT EXISTS dirty_files (
        project_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT NOT NULL,
        first_seen_at_ms INTEGER NOT NULL,
        last_seen_at_ms INTEGER NOT NULL,
        event_count INTEGER NOT NULL,
        PRIMARY KEY(project_id, file_path)
      );
      CREATE TABLE IF NOT EXISTS watcher_state (
        project_id TEXT PRIMARY KEY,
        burst_mode INTEGER NOT NULL,
        dropped_events INTEGER NOT NULL,
        last_event_at_ms INTEGER,
        updated_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_symbols_project_name ON symbols(project_id, name);
      CREATE INDEX IF NOT EXISTS idx_edges_project_kind ON edges(project_id, kind);
      CREATE INDEX IF NOT EXISTS idx_chunks_project_file ON chunks(project_id, file_path);
      CREATE INDEX IF NOT EXISTS idx_dirty_files_project_status ON dirty_files(project_id, status);
    `);
    this.ensureProjectColumns();
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_projects_repo_root ON projects(repo_root);
      CREATE INDEX IF NOT EXISTS idx_projects_canonical_root ON projects(canonical_root);
    `);
  }

  private ensureProjectColumns(): void {
    const columns = new Set(this.db.prepare("PRAGMA table_info(projects)").all().map((row: any) => String(row.name)));
    const additions: Record<string, string> = {
      canonical_root: "ALTER TABLE projects ADD COLUMN canonical_root TEXT",
      display_name: "ALTER TABLE projects ADD COLUMN display_name TEXT",
      git_remote: "ALTER TABLE projects ADD COLUMN git_remote TEXT",
      git_head: "ALTER TABLE projects ADD COLUMN git_head TEXT",
      created_at_ms: "ALTER TABLE projects ADD COLUMN created_at_ms INTEGER",
      last_indexed_at_ms: "ALTER TABLE projects ADD COLUMN last_indexed_at_ms INTEGER",
      index_generation: "ALTER TABLE projects ADD COLUMN index_generation INTEGER"
    };
    for (const [column, sql] of Object.entries(additions)) {
      if (!columns.has(column)) this.db.exec(sql);
    }
    this.db.exec("UPDATE projects SET canonical_root = repo_root WHERE canonical_root IS NULL");
    this.db.exec("UPDATE projects SET display_name = project_id WHERE display_name IS NULL");
    this.db.exec("UPDATE projects SET created_at_ms = indexed_at_ms WHERE created_at_ms IS NULL");
    this.db.exec("UPDATE projects SET last_indexed_at_ms = indexed_at_ms WHERE last_indexed_at_ms IS NULL");
    this.db.exec("UPDATE projects SET index_generation = 1 WHERE index_generation IS NULL");
  }

  private deleteProjectRows(projectId: string): void {
    for (const table of ["files", "symbols", "edges", "chunks", "chunks_fts", "skipped_files", "dirty_files", "watcher_state"]) {
      this.db.prepare(`DELETE FROM ${table} WHERE project_id = ?`).run(projectId);
    }
  }

  private clearDirtyRows(projectId: string, filePaths?: string[]): void {
    if (!filePaths) {
      this.db.prepare("DELETE FROM dirty_files WHERE project_id = ?").run(projectId);
      this.db.prepare("DELETE FROM watcher_state WHERE project_id = ?").run(projectId);
      return;
    }
    for (const filePath of filePaths) {
      this.db.prepare("DELETE FROM dirty_files WHERE project_id = ? AND file_path = ?").run(projectId, filePath);
    }
    const remaining = Number((this.db.prepare("SELECT COUNT(*) AS count FROM dirty_files WHERE project_id = ?").get(projectId) as any)?.count ?? 0);
    if (remaining === 0) this.db.prepare("DELETE FROM watcher_state WHERE project_id = ?").run(projectId);
  }

  private watcherStateForProject(projectId: string): WatcherState {
    const dirtyFiles = this.db.prepare("SELECT * FROM dirty_files WHERE project_id = ? ORDER BY file_path")
      .all(projectId)
      .map(dirtyFileFromRow);
    const state = this.db.prepare("SELECT * FROM watcher_state WHERE project_id = ?").get(projectId) as Record<string, unknown> | undefined;
    return {
      projectId,
      dirtyFiles,
      pendingFiles: dirtyFiles.filter((file) => file.status === "pending").map((file) => file.filePath),
      indexingFiles: dirtyFiles.filter((file) => file.status === "indexing").map((file) => file.filePath),
      burstMode: Boolean(Number(state?.burst_mode ?? 0)),
      droppedEvents: Number(state?.dropped_events ?? 0),
      lastEventAtMs: state?.last_event_at_ms === null || state?.last_event_at_ms === undefined ? undefined : Number(state.last_event_at_ms),
      updatedAtMs: state?.updated_at_ms === null || state?.updated_at_ms === undefined ? undefined : Number(state.updated_at_ms)
    };
  }

  private deleteFileRows(projectId: string, filePath: string): void {
    this.db.prepare("DELETE FROM edges WHERE project_id = ? AND file_path = ?").run(projectId, filePath);
    this.db.prepare("DELETE FROM symbols WHERE project_id = ? AND file_path = ?").run(projectId, filePath);
    this.db.prepare("DELETE FROM chunks_fts WHERE project_id = ? AND file_path = ?").run(projectId, filePath);
    this.db.prepare("DELETE FROM chunks WHERE project_id = ? AND file_path = ?").run(projectId, filePath);
    this.db.prepare("DELETE FROM files WHERE project_id = ? AND path = ?").run(projectId, filePath);
  }

  private filePathsForProject(projectId: string): string[] {
    return this.db.prepare("SELECT path FROM files WHERE project_id = ?").all(projectId).map((row: any) => String(row.path));
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
    const root = normalizeRepoRoot(repoRoot);
    const row = this.sql.selectProjectByRoot.get(root, root);
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

function projectFromRow(row: Record<string, unknown>): ProjectIdentity {
  const repoRoot = String(row.repo_root);
  const canonicalRoot = row.canonical_root === null || row.canonical_root === undefined
    ? repoRoot
    : String(row.canonical_root);
  const indexedAtMs = Number(row.indexed_at_ms);
  return {
    projectId: String(row.project_id),
    repoRoot,
    canonicalRoot,
    displayName: row.display_name === null || row.display_name === undefined ? path.basename(canonicalRoot) : String(row.display_name),
    gitRemote: row.git_remote === null || row.git_remote === undefined ? undefined : String(row.git_remote),
    gitHead: row.git_head === null || row.git_head === undefined ? undefined : String(row.git_head),
    createdAtMs: row.created_at_ms === null || row.created_at_ms === undefined ? indexedAtMs : Number(row.created_at_ms),
    lastIndexedAtMs: row.last_indexed_at_ms === null || row.last_indexed_at_ms === undefined ? indexedAtMs : Number(row.last_indexed_at_ms)
  };
}

function dirtyFileFromRow(row: Record<string, unknown>): DirtyFile {
  return {
    projectId: String(row.project_id),
    filePath: String(row.file_path),
    status: String(row.status) as DirtyFile["status"],
    reason: String(row.reason),
    firstSeenAtMs: Number(row.first_seen_at_ms),
    lastSeenAtMs: Number(row.last_seen_at_ms),
    eventCount: Number(row.event_count)
  };
}

function fallbackProjectIdentity(projectId: string, repoRoot: string, indexedAtMs: number): ProjectIdentity {
  return {
    projectId,
    repoRoot,
    canonicalRoot: repoRoot,
    displayName: path.basename(repoRoot),
    createdAtMs: indexedAtMs,
    lastIndexedAtMs: indexedAtMs
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

function ftsQueryForTerms(terms: string[]): string {
  return [...new Set(terms)]
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
    .map((part) => `"${part.replaceAll('"', '""')}"`)
    .join(" OR ");
}

function formatRank(rank: number): string {
  return Number.isFinite(rank) ? rank.toFixed(6) : "nan";
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

function refreshedOrDeletedFiles(index: RepoIndex): Set<string> {
  return new Set(index.fullReindex ? index.files.map((file) => file.path) : [...(index.refreshedFiles ?? index.changedFiles), ...index.deletedFiles]);
}

function isTestFile(filePath: string): boolean {
  return /(^|\/)(__tests__|tests?)(\/|$)|\.(test|spec)\.[jt]sx?$/.test(filePath);
}

function filenameTestMatches(files: CodeFile[], basename: string): Map<string, CodeFile> {
  const tests = new Map<string, CodeFile>();
  for (const file of files) {
    if (isTestFile(file.path) && file.path.toLowerCase().includes(basename.toLowerCase())) tests.set(file.path, file);
  }
  return tests;
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
