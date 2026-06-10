import { describe, expect, it } from "vitest";
import type { CodeChunk, EmbeddingProvider, LanceChunkRecord, LanceConnection, LanceEmbeddingProfile, LanceProfileStore, LanceTable, LanceTableSchema } from "../src/index.js";
import { LanceSemanticStore } from "../src/index.js";

describe("Lance semantic embedding reliability", () => {
  it("creates a missing table with real rows instead of a dimension-guessing seed row", async () => {
    const table = new FakeLanceTable();
    const connection = fakeConnection(table, { existing: false });
    const provider = new CountingEmbeddingProvider();
    const store = new LanceSemanticStore("memory://seedless", {
      connection,
      embeddingBatchSize: 1
    });

    await store.upsertChunks([chunk({ id: "real", contentHash: "real-hash" })], provider);

    expect(connection.createdRows.map((record) => record.id)).toEqual(["real"]);
    expect(table.records.map((record) => record.id)).toEqual(["real"]);
    expect(table.records.some((record) => record.id === "__seed__")).toBe(false);
  });

  it("retries transient embedding failures before adding rows", async () => {
    const table = new FakeLanceTable();
    const provider = new FlakyEmbeddingProvider(2);
    const store = new LanceSemanticStore("memory://retry", {
      connection: fakeConnection(table),
      embeddingBatchSize: 1,
      embeddingRetryAttempts: 3,
      embeddingRetryBaseDelayMs: 1
    });

    await store.upsertChunks([chunk({ id: "retry", contentHash: "retry-hash" })], provider);

    expect(provider.calls).toBe(3);
    expect(table.records.map((record) => record.id)).toEqual(["retry"]);
  });

  it("reuses existing vectors by contentHash instead of re-embedding repeated content", async () => {
    const table = new FakeLanceTable();
    const provider = new CountingEmbeddingProvider();
    const store = new LanceSemanticStore("memory://reuse", {
      connection: fakeConnection(table),
      embeddingBatchSize: 1
    });

    await store.upsertChunks([chunk({ id: "first", filePath: "src/first.ts", contentHash: "same-hash" })], provider, 1);
    provider.reset();
    await store.upsertChunks([chunk({ id: "second", filePath: "src/second.ts", contentHash: "same-hash" })], provider, 2);

    expect(provider.calls).toBe(0);
    expect(table.records.find((record) => record.id === "second")).toMatchObject({
      filePath: "src/second.ts",
      contentHash: "same-hash",
      generation: 2
    });
  });

  it("backfills only chunks missing from the vector table", async () => {
    const table = new FakeLanceTable();
    const provider = new CountingEmbeddingProvider();
    const store = new LanceSemanticStore("memory://backfill", {
      connection: fakeConnection(table),
      embeddingBatchSize: 8
    });

    await store.upsertChunks([chunk({ id: "existing", filePath: "src/existing.ts", contentHash: "existing-hash" })], provider, 1);
    provider.reset();
    await store.upsertChunks([
      chunk({ id: "existing-next", filePath: "src/existing-next.ts", contentHash: "existing-hash" }),
      chunk({ id: "missing", filePath: "src/missing.ts", contentHash: "missing-hash" })
    ], provider, 2);

    expect(provider.calls).toBe(1);
    expect(table.records.map((record) => record.id).sort()).toEqual(["existing", "existing-next", "missing"]);
  });

  it("repairs profile mismatches by dropping and recreating the Lance table", async () => {
    const table = new FakeLanceTable();
    const connection = fakeConnection(table);
    await table.add([row({ id: "stale", contentHash: "same-hash", vector: [1, 1] })]);
    const profileStore = new MemoryProfileStore({
      schemaVersion: 1,
      tableName: "code_chunks",
      provider: "old-provider",
      dimensions: 2,
      createdAtMs: 1,
      updatedAtMs: 1
    });
    const provider = new CountingEmbeddingProvider();
    const store = new LanceSemanticStore("memory://repair-profile", {
      connection,
      profileStore,
      embeddingProfile: { provider: "new-provider" },
      embeddingBatchSize: 1
    });

    await store.upsertChunks([chunk({ id: "fresh", contentHash: "same-hash" })], provider);

    expect(connection.dropCalls).toEqual(["code_chunks"]);
    expect(provider.calls).toBe(1);
    expect(table.records.map((record) => record.id)).toEqual(["fresh"]);
    await expect(profileStore.read()).resolves.toMatchObject({ provider: "new-provider", dimensions: 4 });
  });

  it("repairs schema drift by recreating a table with the expected columns", async () => {
    const table = new FakeLanceTable({ fields: [{ name: "id" }, { name: "vector", vectorDimensions: 4 }] });
    const connection = fakeConnection(table);
    const provider = new CountingEmbeddingProvider();
    const store = new LanceSemanticStore("memory://repair-schema", {
      connection,
      embeddingBatchSize: 1
    });

    await store.upsertChunks([chunk({ id: "schema-fresh", contentHash: "schema-hash" })], provider);

    expect(connection.dropCalls).toEqual(["code_chunks"]);
    expect(connection.createCalls).toBe(1);
    expect(table.records.map((record) => record.id)).toEqual(["schema-fresh"]);
  });

  it("deletes seed records before appending real rows to an existing table", async () => {
    const table = new FakeLanceTable();
    await table.add([row({ id: "__seed__", projectId: "__seed__", repoRoot: "__seed__", filePath: "__seed__", contentHash: "seed" })]);
    const provider = new CountingEmbeddingProvider();
    const store = new LanceSemanticStore("memory://seed-cleanup", {
      connection: fakeConnection(table),
      embeddingBatchSize: 1
    });

    await store.upsertChunks([chunk({ id: "real-row", contentHash: "real-row-hash" })], provider);

    expect(table.deletes).toContain("id = '__seed__'");
    expect(table.records.map((record) => record.id)).toEqual(["real-row"]);
  });

  it("escapes backslashes and single quotes in Lance predicates", async () => {
    const table = new FakeLanceTable();
    const store = new LanceSemanticStore("memory://predicate", {
      connection: fakeConnection(table)
    });

    await store.deleteFile("repo-a", "project'a", "src\\owner's.ts");

    expect(table.deletes).toContain("projectId = 'project''a' AND filePath = 'src\\\\owner''s.ts'");
  });
});

class FakeLanceTable implements LanceTable {
  records: LanceChunkRecord[] = [];
  deletes: string[] = [];
  private readonly schemaShape: LanceTableSchema;

  constructor(schemaShape: LanceTableSchema = completeSchema(4)) {
    this.schemaShape = schemaShape;
  }

  async add(rows: LanceChunkRecord[]): Promise<void> {
    for (const row of rows) {
      this.records = this.records.filter((record) => record.id !== row.id);
      this.records.push(row);
    }
  }

  async delete(predicate: string): Promise<void> {
    this.deletes.push(predicate);
    this.records = this.records.filter((record) => !matchesPredicate(record, predicate));
  }

  async schema(): Promise<LanceTableSchema> {
    return this.schemaShape;
  }

  query() {
    return {
      where: (predicate: string) => ({
        limit: (limit: number) => ({
          toArray: async () => this.records.filter((record) => matchesPredicate(record, predicate)).slice(0, limit)
        })
      })
    };
  }

  search(_vector: number[]) {
    return {
      where: (predicate: string) => ({
        limit: (limit: number) => ({
          toArray: async () => this.records.filter((record) => matchesPredicate(record, predicate)).slice(0, limit).map((record) => ({ ...record, _distance: 0 }))
        })
      })
    };
  }
}

class CountingEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = 4;
  calls = 0;

  reset(): void {
    this.calls = 0;
  }

  async embed(text: string): Promise<number[]> {
    this.calls += 1;
    return vector(text);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    this.calls += texts.length;
    return texts.map(vector);
  }
}

class FlakyEmbeddingProvider extends CountingEmbeddingProvider {
  constructor(private remainingFailures: number) {
    super();
  }

  override async embedBatch(texts: string[]): Promise<number[][]> {
    this.calls += 1;
    if (this.remainingFailures > 0) {
      this.remainingFailures -= 1;
      throw Object.assign(new Error("rate limited"), { status: 429 });
    }
    return texts.map(vector);
  }
}

interface FakeConnection extends LanceConnection {
  dropCalls: string[];
  createCalls: number;
  createdRows: LanceChunkRecord[];
}

function fakeConnection(table: FakeLanceTable, options: { existing?: boolean } = {}): FakeConnection {
  let exists = options.existing ?? true;
  const connection: FakeConnection = {
    dropCalls: [],
    createCalls: 0,
    createdRows: [],
    tableNames: async () => exists ? ["code_chunks"] : [],
    openTable: async () => table,
    createTable: async (_name, rows) => {
      exists = true;
      connection.createCalls += 1;
      connection.createdRows = [...rows];
      await table.add(rows);
      return table;
    },
    dropTable: async (name) => {
      connection.dropCalls.push(name);
      table.records = [];
      exists = false;
    }
  };
  return connection;
}

function chunk(overrides: Partial<CodeChunk> = {}): CodeChunk {
  return {
    id: "chunk-a",
    projectId: "project-a",
    repoRoot: "repo-a",
    filePath: "src/auth.ts",
    language: "typescript",
    kind: "function",
    symbolName: "loginUser",
    startLine: 1,
    endLine: 3,
    content: "export function loginUser() { return 'ok'; }",
    contentHash: "hash-a",
    ...overrides
  };
}

function matchesPredicate(record: LanceChunkRecord, predicate: string): boolean {
  const clauses = predicate.split(/\s+AND\s+/i);
  return clauses.every((clause) => {
    const match = /^\s*(id|projectId|repoRoot|filePath|contentHash)\s*=\s*'((?:''|\\\\|[^'])*)'\s*$/.exec(clause);
    if (!match) return false;
    const key = match[1] as "id" | "projectId" | "repoRoot" | "filePath" | "contentHash";
    return record[key] === unescapePredicateLiteral(match[2]);
  });
}

function unescapePredicateLiteral(value: string): string {
  return value.replaceAll("''", "'").replaceAll("\\\\", "\\");
}

function row(overrides: Partial<LanceChunkRecord> = {}): LanceChunkRecord {
  return {
    id: "row-a",
    projectId: "project-a",
    repoRoot: "repo-a",
    filePath: "src/auth.ts",
    language: "typescript",
    kind: "function",
    symbolName: "loginUser",
    startLine: 1,
    endLine: 3,
    content: "export function loginUser() { return 'ok'; }",
    contentHash: "hash-a",
    generation: 1,
    vector: [1, 2, 3, 4],
    ...overrides
  };
}

function completeSchema(dimensions: number): LanceTableSchema {
  const scalarFields = [
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
    "generation"
  ].map((name) => ({ name }));
  return {
    fields: [...scalarFields, { name: "vector", vectorDimensions: dimensions }]
  };
}

class MemoryProfileStore implements LanceProfileStore {
  constructor(private profile?: LanceEmbeddingProfile) {}

  async read(): Promise<LanceEmbeddingProfile | undefined> {
    return this.profile;
  }

  async write(profile: LanceEmbeddingProfile): Promise<void> {
    this.profile = profile;
  }
}

function vector(text: string): number[] {
  return [text.length, text.charCodeAt(0) || 0, text.charCodeAt(text.length - 1) || 0, 1];
}
