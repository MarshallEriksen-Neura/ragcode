import type { DatabaseSync } from "node:sqlite";

/**
 * Prepared statement pool for SQLiteGraphStore.
 * All SQL lives here — single source of truth for schema access patterns.
 */
export class SqliteStatements {
  // Projects
  readonly upsertProject: any;
  readonly selectProject: any;

  // Files
  readonly selectFiles: any;
  readonly selectFile: any;
  readonly insertFile: any;
  readonly deleteFilesNotIn: any;

  // Symbols
  readonly selectSymbols: any;
  readonly selectSymbolsByFile: any;
  readonly selectSymbolByNameLike: any;
  readonly insertSymbol: any;
  readonly deleteSymbols: any;

  // Edges
  readonly selectEdges: any;
  readonly selectEdgesByKind: any;
  readonly insertEdge: any;
  readonly deleteEdges: any;

  // Chunks
  readonly selectChunks: any;
  readonly selectChunksByFile: any;
  readonly insertChunk: any;
  readonly deleteChunks: any;

  // FTS
  readonly searchFts: any;
  readonly insertFts: any;
  readonly deleteFts: any;

  // Skipped files
  readonly selectSkippedFiles: any;
  readonly insertSkippedFile: any;
  readonly deleteSkippedFiles: any;

  // Cleanup
  readonly deleteProjectData: any;
  readonly selectFilePaths: any;

  constructor(db: DatabaseSync) {
    // Projects
    this.upsertProject = db.prepare(
      "INSERT OR REPLACE INTO projects(project_id, repo_root, indexed_at_ms) VALUES (?, ?, ?)"
    );
    this.selectProject = db.prepare(
      "SELECT * FROM projects WHERE repo_root = ?"
    );

    // Files
    this.selectFiles = db.prepare(
      "SELECT * FROM files WHERE project_id = ? ORDER BY path"
    );
    this.selectFile = db.prepare(
      "SELECT * FROM files WHERE project_id = ? AND path = ?"
    );
    this.insertFile = db.prepare(
      "INSERT INTO files(project_id, path, absolute_path, language, size_bytes, content_hash, modified_at_ms, indexed_at_ms, status, generation) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    this.selectFilePaths = db.prepare(
      "SELECT path FROM files WHERE project_id = ?"
    );

    // Symbols
    this.selectSymbols = db.prepare(
      "SELECT * FROM symbols WHERE project_id = ? ORDER BY file_path, start_line"
    );
    this.selectSymbolsByFile = db.prepare(
      "SELECT * FROM symbols WHERE project_id = ? AND file_path = ? ORDER BY start_line"
    );
    this.selectSymbolByNameLike = db.prepare(
      "SELECT * FROM symbols WHERE project_id = ? AND lower(name) LIKE ? ESCAPE '\\' ORDER BY name"
    );
    this.insertSymbol = db.prepare(
      "INSERT INTO symbols(project_id, id, file_path, name, kind, language, start_line, end_line, signature, exported, generation) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    this.deleteSymbols = db.prepare(
      "DELETE FROM symbols WHERE project_id = ? AND file_path = ?"
    );

    // Edges
    this.selectEdges = db.prepare(
      "SELECT * FROM edges WHERE project_id = ? ORDER BY id"
    );
    this.selectEdgesByKind = db.prepare(
      "SELECT * FROM edges WHERE project_id = ? AND kind = ? ORDER BY id"
    );
    this.insertEdge = db.prepare(
      "INSERT INTO edges(project_id, source_id, target_id, kind, metadata_json, file_path, generation) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );
    this.deleteEdges = db.prepare(
      "DELETE FROM edges WHERE project_id = ? AND file_path = ?"
    );

    // Chunks
    this.selectChunks = db.prepare(
      "SELECT * FROM chunks WHERE project_id = ? ORDER BY file_path, start_line"
    );
    this.selectChunksByFile = db.prepare(
      "SELECT * FROM chunks WHERE project_id = ? AND file_path = ? ORDER BY start_line"
    );
    this.insertChunk = db.prepare(
      "INSERT INTO chunks(project_id, id, repo_root, file_path, language, kind, symbol_name, start_line, end_line, content, content_hash, generation) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    this.deleteChunks = db.prepare(
      "DELETE FROM chunks WHERE project_id = ? AND file_path = ?"
    );

    // FTS
    this.searchFts = db.prepare(
      `SELECT c.*, bm25(chunks_fts) AS rank
       FROM chunks_fts
       JOIN chunks c ON c.project_id = chunks_fts.project_id AND c.id = chunks_fts.id
       WHERE chunks_fts.project_id = ? AND chunks_fts MATCH ?
       ORDER BY rank, c.file_path, c.start_line
       LIMIT ?`
    );
    this.insertFts = db.prepare(
      "INSERT INTO chunks_fts(project_id, id, file_path, symbol_name, content) VALUES (?, ?, ?, ?, ?)"
    );
    this.deleteFts = db.prepare(
      "DELETE FROM chunks_fts WHERE project_id = ? AND file_path = ?"
    );

    // Skipped files
    this.selectSkippedFiles = db.prepare(
      "SELECT file_path, reason FROM skipped_files WHERE project_id = ? ORDER BY file_path"
    );
    this.insertSkippedFile = db.prepare(
      "INSERT INTO skipped_files(project_id, file_path, reason) VALUES (?, ?, ?)"
    );
    this.deleteSkippedFiles = db.prepare(
      "DELETE FROM skipped_files WHERE project_id = ?"
    );

    // Cleanup (used for table iteration in deleteProjectRows)
    this.deleteProjectData = (table: string) =>
      db.prepare(`DELETE FROM ${table} WHERE project_id = ?`);
  }
}
