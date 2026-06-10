import fs from "node:fs/promises";
import path from "node:path";
import type { EmbeddingProvider, SemanticStore } from "../core/contracts.js";
import type { CodeChunk, SearchHit, SearchQuery } from "../core/types.js";
import { renderChunkForEmbedding } from "./in-memory-semantic-store.js";

export interface LanceTable {
  add(rows: LanceChunkRecord[]): Promise<unknown>;
  delete(predicate: string): Promise<unknown>;
  schema?(): Promise<LanceTableSchema> | LanceTableSchema;
  query?(): {
    where(predicate: string): {
      limit(limit: number): {
        toArray(): Promise<LanceChunkRecord[]>;
      };
    };
  };
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
  dropTable?(name: string): Promise<unknown>;
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

export interface LanceTableSchema {
  fields?: LanceSchemaField[];
}

export interface LanceSchemaField {
  name?: string;
  type?: unknown;
  dataType?: unknown;
  vectorDimensions?: number;
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
  embeddingRetryAttempts?: number;
  embeddingRetryBaseDelayMs?: number;
  repairOnMismatch?: boolean;
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
  private readonly embeddingRetryAttempts: number;
  private readonly embeddingRetryBaseDelayMs: number;
  private readonly repairOnMismatch: boolean;
  private readonly maxChunks?: number;
  private readonly onProgress?: (progress: LanceEmbeddingProgress) => void;

  constructor(private readonly uri: string, tableNameOrOptions: string | LanceSemanticStoreOptions = "code_chunks") {
    if (typeof tableNameOrOptions === "string") {
      this.tableName = tableNameOrOptions;
      this.embeddingProfile = { provider: "unknown" };
      this.profileStore = defaultProfileStore(uri, this.tableName);
      this.embeddingBatchSize = 64;
      this.embeddingConcurrency = 1;
      this.embeddingRetryAttempts = 3;
      this.embeddingRetryBaseDelayMs = 100;
      this.repairOnMismatch = true;
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
    this.embeddingRetryAttempts = positiveInteger(tableNameOrOptions.embeddingRetryAttempts, 3);
    this.embeddingRetryBaseDelayMs = positiveInteger(tableNameOrOptions.embeddingRetryBaseDelayMs, 100);
    this.repairOnMismatch = tableNameOrOptions.repairOnMismatch ?? true;
    this.maxChunks = tableNameOrOptions.maxChunks;
    this.onProgress = tableNameOrOptions.onProgress;
  }

  async needsRebuild(_repoRoot: string, _projectId: string): Promise<boolean> {
    const profile = await this.profileStore.read();
    if (!profile) return true;
    const table = await this.getExistingTable(profile.dimensions, { repair: false }).catch(() => undefined);
    return !table;
  }


  async resetRepo(repoRoot: string): Promise<void> {
    const table = await this.getExistingTable();
    if (!table) {
      const dimensions = this.vectorDimensions ?? 64;
      await this.getTable(dimensions, [emptySeedRecord(dimensions)]);
      return;
    }
    await table.delete(equalsPredicate("repoRoot", repoRoot));
  }

  async deleteFile(_repoRoot: string, projectId: string, filePath: string): Promise<void> {
    const table = await this.getExistingTable();
    if (!table) return;
    await table.delete(andPredicate(equalsPredicate("projectId", projectId), equalsPredicate("filePath", filePath)));
  }

  async upsertChunks(chunks: CodeChunk[], provider: EmbeddingProvider, generation = 1): Promise<void> {
    if (chunks.length === 0) return;

    const selectedChunks = selectChunksForEmbedding(chunks, this.maxChunks);
    const knownDimensions = provider.dimensions ?? this.vectorDimensions;
    const repairedBeforeReuse = knownDimensions ? await this.ensureCompatibleProfile(knownDimensions) : false;
    let table = repairedBeforeReuse ? undefined : await this.getExistingTable(knownDimensions);
    let { chunksToEmbed, reusedRows } = table
      ? await this.planChunkEmbeddings(table, selectedChunks, generation)
      : { chunksToEmbed: selectedChunks, reusedRows: [] };
    if (table) await this.deleteFileScopesForChunks(table, chunks);
    const reusedVectorDimensions = reusedRows[0]?.vector.length;
    if (reusedVectorDimensions) {
      const repaired = await this.ensureCompatibleProfile(reusedVectorDimensions);
      if (repaired) {
        table = undefined;
        chunksToEmbed = selectedChunks;
        reusedRows = [];
      } else {
        table = await this.addRows(table, reusedRows);
      }
    }
    if (chunksToEmbed.length === 0) return;
    const batches = chunkArray(chunksToEmbed, this.embeddingBatchSize);
    let completedChunks = 0;
    const startedAt = Date.now();

    for (let start = 0; start < batches.length; start += this.embeddingConcurrency) {
      const window = batches.slice(start, start + this.embeddingConcurrency);
      const settled = await Promise.allSettled(window.map((batch) => this.embedChunkBatch(batch, provider, generation)));

      for (let offset = 0; offset < settled.length; offset += 1) {
        const outcome = settled[offset];
        if (outcome.status !== "fulfilled") continue;
        const rows = outcome.value;
        const vectorDimensions = rows[0]?.vector.length;
        if (!vectorDimensions) continue;

        const repaired = await this.ensureCompatibleProfile(vectorDimensions);
        if (repaired) table = undefined;
        table = await this.addRows(table, rows);

        completedChunks += rows.length;
        this.onProgress?.({
          totalChunks: chunksToEmbed.length,
          completedChunks,
          batchChunks: rows.length,
          batchIndex: start + offset + 1,
          batchCount: batches.length,
          elapsedMs: Date.now() - startedAt
        });
      }

      // Surface a failure only after persisting every batch that succeeded in this window, so
      // one transient error never discards (and forces re-embedding of) already-completed batches.
      const failure = settled.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
      if (failure) throw failure.reason;
    }
  }

  private async embedChunkBatch(chunks: CodeChunk[], provider: EmbeddingProvider, generation: number): Promise<LanceChunkRecord[]> {
    const texts = chunks.map((chunk) => renderChunkForEmbedding(chunk));
    const vectors = await retryEmbedding(() => provider.embedBatch ? provider.embedBatch(texts) : Promise.all(texts.map((text) => provider.embed(text))), {
      attempts: this.embeddingRetryAttempts,
      baseDelayMs: this.embeddingRetryBaseDelayMs
    });
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

  private async deleteFileScopesForChunks(table: LanceTable, chunks: CodeChunk[]): Promise<void> {
    const fileScopes = new Set(chunks.map((chunk) => JSON.stringify([chunk.projectId, chunk.filePath])));
    for (const fileScope of fileScopes) {
      const [projectId, filePath] = JSON.parse(fileScope) as [string, string];
      await table.delete(andPredicate(
        equalsPredicate("projectId", projectId),
        equalsPredicate("filePath", filePath),
        "id != '__seed__'"
      ));
    }
  }

  private async planChunkEmbeddings(table: LanceTable, chunks: CodeChunk[], generation: number): Promise<{ chunksToEmbed: CodeChunk[]; reusedRows: LanceChunkRecord[] }> {
    if (!table.query) return { chunksToEmbed: chunks, reusedRows: [] };
    const reusableVectors = await this.loadReusableVectors(table, chunks);
    const chunksToEmbed: CodeChunk[] = [];
    const reusedRows: LanceChunkRecord[] = [];
    for (const chunk of chunks) {
      const vector = reusableVectors.get(reuseVectorKey(chunk.projectId, chunk.contentHash));
      if (vector) reusedRows.push(rowForChunk(chunk, vector, generation));
      else chunksToEmbed.push(chunk);
    }
    return { chunksToEmbed, reusedRows };
  }

  private async loadReusableVectors(table: LanceTable, chunks: CodeChunk[]): Promise<Map<string, number[]>> {
    const vectors = new Map<string, number[]>();
    if (!table.query) return vectors;

    const hashesByProject = new Map<string, Set<string>>();
    for (const chunk of chunks) {
      const existing = hashesByProject.get(chunk.projectId);
      if (existing) existing.add(chunk.contentHash);
      else hashesByProject.set(chunk.projectId, new Set([chunk.contentHash]));
    }

    for (const [projectId, hashSet] of hashesByProject) {
      // One batched IN-query per project (chunked to keep predicates bounded) replaces the
      // former one-round-trip-per-chunk lookup. A truncated batch only lowers the reuse hit
      // rate (those chunks get re-embedded) and never reuses a stale vector.
      for (const batch of chunkArray([...hashSet], REUSE_LOOKUP_BATCH)) {
        const rows = await table.query()
          .where(andPredicate(equalsPredicate("projectId", projectId), inPredicate("contentHash", batch)))
          .limit(batch.length * REUSE_LOOKUP_ROW_MULTIPLIER)
          .toArray();
        for (const reusable of rows) {
          const key = reuseVectorKey(projectId, reusable.contentHash);
          // A vector read back from LanceDB is an Arrow Vector, not a plain number[]; re-adding it
          // verbatim makes the next table.add() fail Arrow schema inference ("vector.isValid").
          // Materialize a plain number[] so reused rows write back cleanly on real LanceDB.
          if (!vectors.has(key)) vectors.set(key, Array.from(reusable.vector as Iterable<number>));
        }
      }
    }
    return vectors;
  }
  async search(query: SearchQuery, provider: EmbeddingProvider): Promise<SearchHit[]> {
    const vector = await retryEmbedding(() => provider.embed(query.query), {
      attempts: this.embeddingRetryAttempts,
      baseDelayMs: this.embeddingRetryBaseDelayMs
    });
    const repaired = await this.ensureCompatibleProfile(vector.length);
    if (repaired) return [];
    const table = await this.getExistingTable(vector.length);
    if (!table) return [];
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

  private async getTable(vectorDimensions: number, seedRows?: LanceChunkRecord[]): Promise<LanceTable> {
    if (!this.tablePromise) {
      this.tablePromise = this.openOrCreateTable(vectorDimensions, seedRows);
    }
    return this.tablePromise;
  }

  private async getExistingTable(vectorDimensions?: number, options: { repair?: boolean } = {}): Promise<LanceTable | undefined> {
    const db = await this.getConnection();
    const names = await db.tableNames();
    if (!names.includes(this.tableName)) return undefined;

    if (!this.tablePromise) this.tablePromise = db.openTable(this.tableName);
    const table = await this.tablePromise;
    const problems = await tableSchemaProblems(table, vectorDimensions);
    if (problems.length === 0) return table;

    const repair = options.repair ?? this.repairOnMismatch;
    if (!repair) throw new Error(`LanceDB table "${this.tableName}" schema mismatch: ${problems.join("; ")}.`);
    await this.dropTableForRepair(db, problems);
    return undefined;
  }

  private async addRows(table: LanceTable | undefined, rows: LanceChunkRecord[]): Promise<LanceTable> {
    const vectorDimensions = rows[0]?.vector.length;
    if (!vectorDimensions) throw new Error("Cannot write LanceDB rows without vector dimensions.");
    if (!table) return this.getTable(vectorDimensions, rows);
    await deleteSeedRecord(table);
    await table.add(rows);
    return table;
  }

  private async openOrCreateTable(vectorDimensions: number, seedRows?: LanceChunkRecord[]): Promise<LanceTable> {
    const db = await this.getConnection();
    const names = await db.tableNames();
    if (names.includes(this.tableName)) {
      const table = await db.openTable(this.tableName);
      const problems = await tableSchemaProblems(table, vectorDimensions);
      if (problems.length > 0) {
        await this.dropTableForRepair(db, problems);
        if (seedRows?.length) {
          return db.createTable(this.tableName, seedRows);
        }
        const seedRow = emptySeedRecord(vectorDimensions);
        const created = await db.createTable(this.tableName, [seedRow]);
        return created;
      }
      if (seedRows?.length) {
        await deleteSeedRecord(table);
        await table.add(seedRows);
      }
      return table;
    }
    if (seedRows?.length) {
      return db.createTable(this.tableName, seedRows);
    }
    const seedRow = emptySeedRecord(vectorDimensions);
    return db.createTable(this.tableName, [seedRow]);
  }

  private async getConnection(): Promise<LanceConnection> {
    return this.connection ?? await (this.module ?? await loadLanceDb()).connect(this.uri);
  }

  private async ensureCompatibleProfile(dimensions: number): Promise<boolean> {
    const expected = this.expectedProfile(dimensions);
    const existing = await this.profileStore.read();
    if (!existing) {
      await this.profileStore.write(expected);
      return false;
    }
    const mismatches = profileMismatches(existing, expected);
    if (mismatches.length > 0) {
      if (!this.repairOnMismatch) {
        throw new Error(`LanceDB embedding profile mismatch for table "${this.tableName}": ${mismatches.join("; ")}. Re-index into a new LanceDB URI/table or clear the existing semantic table/profile.`);
      }
      await this.dropTableForRepair(await this.getConnection(), mismatches);
      await this.profileStore.write(expected);
      return true;
    }
    return false;
  }

  private async dropTableForRepair(db: LanceConnection, reasons: string[]): Promise<void> {
    if (!db.dropTable) {
      throw new Error(`LanceDB table "${this.tableName}" requires repair but the current connection cannot drop/recreate tables: ${reasons.join("; ")}.`);
    }
    this.tablePromise = undefined;
    await db.dropTable(this.tableName);
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

function rowForChunk(chunk: CodeChunk, vector: number[], generation: number): LanceChunkRecord {
  return {
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
    vector
  };
}

async function retryEmbedding<T>(operation: () => Promise<T>, options: { attempts: number; baseDelayMs: number }): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt >= options.attempts || !isRetryableEmbeddingError(error)) break;
      await sleep(options.baseDelayMs * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}

function isRetryableEmbeddingError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { status?: number; code?: string; message?: string; cause?: { code?: string } };
  if (candidate.status === 429 || candidate.status === 408 || (candidate.status !== undefined && candidate.status >= 500)) return true;
  // Node/undici network failures surface the code on error.cause, not the top-level error.
  const text = `${candidate.code ?? ""} ${candidate.cause?.code ?? ""} ${candidate.message ?? ""}`.toLowerCase();
  return /rate|timeout|temporar|econnreset|etimedout|429|5\d\d/.test(text);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function tableSchemaProblems(table: LanceTable, vectorDimensions: number | undefined): Promise<string[]> {
  const problems: string[] = [];
  if (!table.schema) return problems;
  const schema = await table.schema();
  const fields = schema.fields ?? [];
  const fieldNames = new Set(fields.map((field) => field.name).filter((name): name is string => typeof name === "string"));
  for (const fieldName of requiredLanceFields) {
    if (!fieldNames.has(fieldName)) problems.push(`missing column ${fieldName}`);
  }
  const vectorField = fields.find((field) => field.name === "vector");
  const actualDimensions = vectorDimensionsFromField(vectorField);
  if (vectorDimensions !== undefined && actualDimensions !== undefined && actualDimensions !== vectorDimensions) {
    problems.push(`vector dimensions ${actualDimensions} != ${vectorDimensions}`);
  }
  return problems;
}

const requiredLanceFields = [
  "id",
  "projectId",
  "repoRoot",
  "filePath",
  "language",
  "kind",
  "symbolName",
  "startLine",
  "endLine",
  "content",
  "contentHash",
  "generation",
  "vector"
];

function vectorDimensionsFromField(field: LanceSchemaField | undefined): number | undefined {
  if (!field || typeof field !== "object") return undefined;
  const direct = (field as { vectorDimensions?: unknown }).vectorDimensions;
  if (typeof direct === "number") return direct;
  const type = (field as { type?: unknown; dataType?: unknown }).type ?? (field as { dataType?: unknown }).dataType;
  return vectorDimensionsFromType(type);
}

function vectorDimensionsFromType(type: unknown): number | undefined {
  if (!type) return undefined;
  if (typeof type === "object") {
    const candidate = type as Record<string, unknown>;
    for (const key of ["listSize", "fixedSize", "dimension", "dimensions", "length"]) {
      if (typeof candidate[key] === "number") return candidate[key] as number;
    }
    if (typeof candidate.toString === "function") return vectorDimensionsFromType(candidate.toString());
  }
  if (typeof type === "string") {
    const match = /(?:fixed_size_list|vector|float32|float64)[^0-9]*(\d+)/i.exec(type);
    if (match) return Number(match[1]);
  }
  return undefined;
}

async function deleteSeedRecord(table: LanceTable): Promise<void> {
  await table.delete(equalsPredicate("id", "__seed__"));
}

function andPredicate(...predicates: string[]): string {
  return predicates.join(" AND ");
}

const REUSE_LOOKUP_BATCH = 512;
const REUSE_LOOKUP_ROW_MULTIPLIER = 4;

function inPredicate(column: string, values: string[]): string {
  if (values.length === 0) return "1 = 0";
  const list = values.map((value) => `'${escapeSqlLiteral(value)}'`).join(", ");
  return `${identifier(column)} IN (${list})`;
}

function reuseVectorKey(projectId: string, contentHash: string): string {
  return `${projectId} ${contentHash}`;
}

function equalsPredicate(column: string, value: string): string {
  return `${identifier(column)} = '${escapeSqlLiteral(value)}'`;
}

function identifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`Invalid LanceDB predicate identifier: ${value}`);
  return value;
}

function escapeSqlLiteral(value: string): string {
  // DataFusion (LanceDB's query engine) follows standard SQL: backslashes are literal inside
  // string literals — only single quotes are escaped, by doubling. Doubling backslashes too
  // made Windows paths (repoRoot from path.resolve) query as `\\` and miss the stored single `\`.
  return value.replaceAll("'", "''");
}

function searchPredicate(query: SearchQuery): string {
  if (query.projectId) return equalsPredicate("projectId", query.projectId);
  if (query.repoRoot) return equalsPredicate("repoRoot", query.repoRoot);
  throw new Error("Internal error: LanceDB semantic search requires a resolved projectId or repoRoot.");
}






