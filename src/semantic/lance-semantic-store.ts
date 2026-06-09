import fs from "node:fs/promises";
import path from "node:path";
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
  embeddingProfile?: LanceEmbeddingProfileIdentity;
  profileStore?: LanceProfileStore;
  embeddingBatchSize?: number;
  embeddingConcurrency?: number;
  maxChunks?: number;
  onProgress?: (progress: LanceEmbeddingProgress) => void;
}

export interface LanceEmbeddingProgress {
  totalChunks: number;
  completedChunks: number;
  batchChunks: number;
  batchIndex: number;
  batchCount: number;
  elapsedMs: number;
}

export interface LanceEmbeddingProfileIdentity {
  provider: string;
  model?: string;
  baseUrl?: string;
  requestDimensions?: boolean;
}

export interface LanceEmbeddingProfile extends LanceEmbeddingProfileIdentity {
  schemaVersion: 1;
  tableName: string;
  dimensions: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface LanceProfileStore {
  read(): Promise<LanceEmbeddingProfile | undefined>;
  write(profile: LanceEmbeddingProfile): Promise<void>;
}

export class LanceSemanticStore implements SemanticStore {
  private tablePromise?: Promise<LanceTable>;
  private readonly tableName: string;
  private readonly connection?: LanceConnection;
  private readonly module?: LanceModule;
  private readonly vectorDimensions?: number;
  private readonly embeddingProfile: LanceEmbeddingProfileIdentity;
  private readonly profileStore: LanceProfileStore;
  private readonly embeddingBatchSize: number;
  private readonly embeddingConcurrency: number;
  private readonly maxChunks?: number;
  private readonly onProgress?: (progress: LanceEmbeddingProgress) => void;

  constructor(private readonly uri: string, tableNameOrOptions: string | LanceSemanticStoreOptions = "code_chunks") {
    if (typeof tableNameOrOptions === "string") {
      this.tableName = tableNameOrOptions;
      this.embeddingProfile = { provider: "unknown" };
      this.profileStore = defaultProfileStore(uri, this.tableName);
      this.embeddingBatchSize = 64;
      this.embeddingConcurrency = 1;
      return;
    }
    this.tableName = tableNameOrOptions.tableName ?? "code_chunks";
    this.connection = tableNameOrOptions.connection;
    this.module = tableNameOrOptions.module;
    this.vectorDimensions = tableNameOrOptions.vectorDimensions;
    this.embeddingProfile = tableNameOrOptions.embeddingProfile ?? { provider: "unknown" };
    this.profileStore = tableNameOrOptions.profileStore ?? defaultProfileStore(uri, this.tableName);
    this.embeddingBatchSize = positiveInteger(tableNameOrOptions.embeddingBatchSize, 64);
    this.embeddingConcurrency = positiveInteger(tableNameOrOptions.embeddingConcurrency, 1);
    this.maxChunks = tableNameOrOptions.maxChunks;
    this.onProgress = tableNameOrOptions.onProgress;
  }

  async needsRebuild(_repoRoot: string, _projectId: string): Promise<boolean> {
    return !(await this.profileStore.read());
  }


  async resetRepo(repoRoot: string): Promise<void> {
    const table = await this.getTable();
    await table.delete(`repoRoot = '${escapeSqlLiteral(repoRoot)}'`);
  }

  async deleteFile(_repoRoot: string, projectId: string, filePath: string): Promise<void> {
    const table = await this.getTable();
    await table.delete(`projectId = '${escapeSqlLiteral(projectId)}' AND filePath = '${escapeSqlLiteral(filePath)}'`);
  }

  async upsertChunks(chunks: CodeChunk[], provider: EmbeddingProvider, generation = 1): Promise<void> {
    if (chunks.length === 0) return;

    const embeddingChunks = selectChunksForEmbedding(chunks, this.maxChunks);
    const batches = chunkArray(embeddingChunks, this.embeddingBatchSize);
    let completedChunks = 0;
    let tablePromise: Promise<LanceTable> | undefined;
    const startedAt = Date.now();

    for (let start = 0; start < batches.length; start += this.embeddingConcurrency) {
      const window = batches.slice(start, start + this.embeddingConcurrency);
      const embeddedBatches = await Promise.all(window.map((batch) => this.embedChunkBatch(batch, provider, generation)));

      for (let offset = 0; offset < embeddedBatches.length; offset += 1) {
        const rows = embeddedBatches[offset];
        const vectorDimensions = rows[0]?.vector.length;
        if (!vectorDimensions) continue;

        await this.ensureCompatibleProfile(vectorDimensions);
        tablePromise ??= this.prepareTableForUpsert(chunks, vectorDimensions);
        const table = await tablePromise;
        await table.add(rows);

        completedChunks += rows.length;
        this.onProgress?.({
          totalChunks: embeddingChunks.length,
          completedChunks,
          batchChunks: rows.length,
          batchIndex: start + offset + 1,
          batchCount: batches.length,
          elapsedMs: Date.now() - startedAt
        });
      }
    }
  }

  private async embedChunkBatch(chunks: CodeChunk[], provider: EmbeddingProvider, generation: number): Promise<LanceChunkRecord[]> {
    const texts = chunks.map((chunk) => renderChunkForEmbedding(chunk));
    const vectors = provider.embedBatch ? await provider.embedBatch(texts) : await Promise.all(texts.map((text) => provider.embed(text)));
    if (vectors.length !== chunks.length) {
      throw new Error(`Embedding provider returned ${vectors.length} vector(s), expected ${chunks.length}.`);
    }
    return chunks.map((chunk, index) => ({
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
      generation,
      vector: vectors[index]
    }));
  }

  private async prepareTableForUpsert(chunks: CodeChunk[], vectorDimensions: number): Promise<LanceTable> {
    const table = await this.getTable(vectorDimensions);
    const fileScopes = new Set(chunks.map((chunk) => JSON.stringify([chunk.projectId, chunk.filePath])));
    for (const fileScope of fileScopes) {
      const [projectId, filePath] = JSON.parse(fileScope) as [string, string];
      await table.delete(`projectId = '${escapeSqlLiteral(projectId)}' AND filePath = '${escapeSqlLiteral(filePath)}'`);
    }
    return table;
  }
  async search(query: SearchQuery, provider: EmbeddingProvider): Promise<SearchHit[]> {
    const vector = await provider.embed(query.query);
    await this.ensureCompatibleProfile(vector.length);
    const table = await this.getTable(vector.length);
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

  private async ensureCompatibleProfile(dimensions: number): Promise<void> {
    const expected = this.expectedProfile(dimensions);
    const existing = await this.profileStore.read();
    if (!existing) {
      await this.profileStore.write(expected);
      return;
    }
    const mismatches = profileMismatches(existing, expected);
    if (mismatches.length > 0) {
      throw new Error(`LanceDB embedding profile mismatch for table "${this.tableName}": ${mismatches.join("; ")}. Re-index into a new LanceDB URI/table or clear the existing semantic table/profile.`);
    }
  }

  private expectedProfile(dimensions: number): LanceEmbeddingProfile {
    const now = Date.now();
    return {
      schemaVersion: 1,
      tableName: this.tableName,
      provider: this.embeddingProfile.provider,
      model: this.embeddingProfile.model,
      baseUrl: this.embeddingProfile.baseUrl,
      requestDimensions: this.embeddingProfile.requestDimensions,
      dimensions,
      createdAtMs: now,
      updatedAtMs: now
    };
  }
}

function selectChunksForEmbedding(chunks: CodeChunk[], maxChunks: number | undefined): CodeChunk[] {
  if (maxChunks === undefined || chunks.length <= maxChunks) return chunks;
  return chunks
    .map((chunk, index) => ({ chunk, index, priority: semanticChunkPriority(chunk) }))
    .sort((a, b) => a.priority - b.priority || a.index - b.index)
    .slice(0, maxChunks)
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.chunk);
}

function semanticChunkPriority(chunk: CodeChunk): number {
  switch (chunk.kind) {
    case "function":
    case "method":
      return 0;
    case "class":
    case "type":
      return 1;
    case "file":
      return 2;
    case "block":
      return 3;
    case "variable":
      return 4;
    default:
      return 5;
  }
}
function chunkArray<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}


function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) throw new Error(`Invalid positive integer: ${value}`);
  return value;
}
function profileMismatches(existing: LanceEmbeddingProfile, expected: LanceEmbeddingProfile): string[] {
  const mismatches: string[] = [];
  if (existing.schemaVersion !== expected.schemaVersion) mismatches.push(`schemaVersion ${existing.schemaVersion} != ${expected.schemaVersion}`);
  if (existing.tableName !== expected.tableName) mismatches.push(`tableName ${existing.tableName} != ${expected.tableName}`);
  if (existing.provider !== expected.provider) mismatches.push(`provider ${existing.provider} != ${expected.provider}`);
  if ((existing.model ?? "") !== (expected.model ?? "")) mismatches.push(`model ${existing.model ?? "<unset>"} != ${expected.model ?? "<unset>"}`);
  if ((existing.baseUrl ?? "") !== (expected.baseUrl ?? "")) mismatches.push(`baseUrl ${existing.baseUrl ?? "<unset>"} != ${expected.baseUrl ?? "<unset>"}`);
  if (Boolean(existing.requestDimensions) !== Boolean(expected.requestDimensions)) mismatches.push(`requestDimensions ${Boolean(existing.requestDimensions)} != ${Boolean(expected.requestDimensions)}`);
  if (existing.dimensions !== expected.dimensions) mismatches.push(`dimensions ${existing.dimensions} != ${expected.dimensions}`);
  return mismatches;
}

function defaultProfileStore(uri: string, tableName: string): LanceProfileStore {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(uri)) {
    return new MemoryLanceProfileStore(`${uri}::${tableName}`);
  }
  return new FileLanceProfileStore(path.join(uri, `${tableName}.embedding-profile.json`));
}

const memoryProfiles = new Map<string, LanceEmbeddingProfile>();

class MemoryLanceProfileStore implements LanceProfileStore {
  constructor(private readonly key: string) {}

  async read(): Promise<LanceEmbeddingProfile | undefined> {
    return memoryProfiles.get(this.key);
  }

  async write(profile: LanceEmbeddingProfile): Promise<void> {
    const existing = memoryProfiles.get(this.key);
    memoryProfiles.set(this.key, {
      ...profile,
      createdAtMs: existing?.createdAtMs ?? profile.createdAtMs
    });
  }
}

class FileLanceProfileStore implements LanceProfileStore {
  constructor(private readonly filePath: string) {}

  async read(): Promise<LanceEmbeddingProfile | undefined> {
    const content = await fs.readFile(this.filePath, "utf8").catch(() => undefined);
    if (!content) return undefined;
    const parsed = JSON.parse(content) as LanceEmbeddingProfile;
    return parsed;
  }

  async write(profile: LanceEmbeddingProfile): Promise<void> {
    const existing = await this.read();
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify({
      ...profile,
      createdAtMs: existing?.createdAtMs ?? profile.createdAtMs,
      updatedAtMs: profile.updatedAtMs
    }, null, 2));
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






