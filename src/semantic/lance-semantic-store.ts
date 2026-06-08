import type { EmbeddingProvider, SemanticStore } from "../core/contracts.js";
import type { CodeChunk, SearchHit, SearchQuery } from "../core/types.js";
import { renderChunkForEmbedding } from "./in-memory-semantic-store.js";

export interface LanceTable {
  add(rows: LanceChunkRecord[]): Promise<unknown>;
  delete(predicate: string): Promise<unknown>;
  search(vector: number[]): {
    where(predicate: string): {
      limit(limit: number): {
        toArray(): Promise<Array<LanceChunkRecord & { _distance?: number }>>;
      };
    };
  };
}

export interface LanceConnection {
  tableNames(): Promise<string[]>;
  openTable(name: string): Promise<LanceTable>;
  createTable(name: string, rows: LanceChunkRecord[]): Promise<LanceTable>;
}

export interface LanceModule {
  connect(uri: string): Promise<LanceConnection>;
}

export interface LanceChunkRecord {
  id: string;
  projectId: string;
  repoRoot: string;
  filePath: string;
  language: string;
  kind: string;
  symbolName?: string;
  startLine: number;
  endLine: number;
  content: string;
  contentHash: string;
  generation: number;
  vector: number[];
}

export interface LanceSemanticStoreOptions {
  tableName?: string;
  connection?: LanceConnection;
  module?: LanceModule;
  vectorDimensions?: number;
}

export class LanceSemanticStore implements SemanticStore {
  private tablePromise?: Promise<LanceTable>;
  private readonly tableName: string;
  private readonly connection?: LanceConnection;
  private readonly module?: LanceModule;
  private readonly vectorDimensions?: number;

  constructor(private readonly uri: string, tableNameOrOptions: string | LanceSemanticStoreOptions = "code_chunks") {
    if (typeof tableNameOrOptions === "string") {
      this.tableName = tableNameOrOptions;
      return;
    }
    this.tableName = tableNameOrOptions.tableName ?? "code_chunks";
    this.connection = tableNameOrOptions.connection;
    this.module = tableNameOrOptions.module;
    this.vectorDimensions = tableNameOrOptions.vectorDimensions;
  }

  async resetRepo(repoRoot: string): Promise<void> {
    const table = await this.getTable();
    await table.delete(`repoRoot = '${escapeSqlLiteral(repoRoot)}'`);
  }

  async deleteFile(_repoRoot: string, projectId: string, filePath: string): Promise<void> {
    const table = await this.getTable();
    await table.delete(`projectId = '${escapeSqlLiteral(projectId)}' AND filePath = '${escapeSqlLiteral(filePath)}'`);
  }

  async upsertChunks(chunks: CodeChunk[], provider: EmbeddingProvider): Promise<void> {
    if (chunks.length === 0) return;
    const rows: LanceChunkRecord[] = [];
    const fileScopes = new Set<string>();
    for (const chunk of chunks) {
      fileScopes.add(JSON.stringify([chunk.projectId, chunk.filePath]));
      rows.push({
        id: chunk.id,
        projectId: chunk.projectId,
        repoRoot: chunk.repoRoot,
        filePath: chunk.filePath,
        language: chunk.language,
        kind: chunk.kind,
        symbolName: chunk.symbolName ?? "",
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        content: chunk.content,
        contentHash: chunk.contentHash,
        generation: 1,
        vector: await provider.embed(renderChunkForEmbedding(chunk))
      });
    }
    const table = await this.getTable(rows[0]?.vector.length);
    for (const fileScope of fileScopes) {
      const [projectId, filePath] = JSON.parse(fileScope) as [string, string];
      await table.delete(`projectId = '${escapeSqlLiteral(projectId)}' AND filePath = '${escapeSqlLiteral(filePath)}'`);
    }
    await table.add(rows);
  }

  async search(query: SearchQuery, provider: EmbeddingProvider): Promise<SearchHit[]> {
    const table = await this.getTable();
    const vector = await provider.embed(query.query);
    const predicate = searchPredicate(query);
    const rows = await table
      .search(vector)
      .where(predicate)
      .limit(query.limit ?? 20)
      .toArray() as Array<LanceChunkRecord & { _distance?: number }>;

    return rows.filter((row) => row.id !== "__seed__").map((row) => ({
      chunk: {
        id: row.id,
        projectId: row.projectId,
        repoRoot: row.repoRoot,
        filePath: row.filePath,
        language: row.language as CodeChunk["language"],
        kind: row.kind as CodeChunk["kind"],
        symbolName: row.symbolName || undefined,
        startLine: row.startLine,
        endLine: row.endLine,
        content: row.content,
        contentHash: row.contentHash
      },
      score: 1 / (1 + (row._distance ?? 0)),
      source: "semantic",
      reason: "LanceDB vector similarity match"
    }));
  }

  private async getTable(vectorDimensions?: number): Promise<LanceTable> {
    if (!this.tablePromise) {
      this.tablePromise = this.openTable(vectorDimensions);
    }
    return this.tablePromise;
  }

  private async openTable(vectorDimensions?: number): Promise<LanceTable> {
    const db = this.connection ?? await (this.module ?? await loadLanceDb()).connect(this.uri);
    const names = await db.tableNames();
    if (names.includes(this.tableName)) {
      return db.openTable(this.tableName);
    }
    return db.createTable(this.tableName, [emptySeedRecord(vectorDimensions ?? this.vectorDimensions ?? 64)]);
  }
}

async function loadLanceDb(): Promise<LanceModule> {
  try {
    return await import("@lancedb/lancedb") as LanceModule;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`LanceDB is not installed. Install @lancedb/lancedb to use LanceSemanticStore. Cause: ${message}`);
  }
}

function emptySeedRecord(vectorDimensions: number): LanceChunkRecord {
  return {
    id: "__seed__",
    projectId: "__seed__",
    repoRoot: "__seed__",
    filePath: "__seed__",
    language: "unknown",
    kind: "block",
    symbolName: "",
    startLine: 0,
    endLine: 0,
    content: "seed",
    contentHash: "seed",
    generation: 1,
    vector: new Array<number>(vectorDimensions).fill(0)
  };
}

function escapeSqlLiteral(value: string): string {
  return value.replaceAll("'", "''");
}

function searchPredicate(query: SearchQuery): string {
  if (query.projectId) return `projectId = '${escapeSqlLiteral(query.projectId)}'`;
  if (query.repoRoot) return `repoRoot = '${escapeSqlLiteral(query.repoRoot)}'`;
  throw new Error("Internal error: LanceDB semantic search requires a resolved projectId or repoRoot.");
}
