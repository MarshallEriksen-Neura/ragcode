import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { LanceChunkRecord, LanceConnection, LanceTable } from "../src/index.js";
import { LanceSemanticStore, OpenAICompatibleEmbeddingProvider, readSemanticRuntimeConfig, createSemanticRuntimeFromEnv } from "../src/index.js";

describe("semantic runtime configuration", () => {
  it("defaults to deterministic embeddings and in-memory semantic storage", () => {
    const config = readSemanticRuntimeConfig({}, "D:/repo");

    expect(config).toMatchObject({
      semanticStore: "memory",
      embeddingProvider: "deterministic",
      lanceDbUri: "D:\\repo\\.ragcode\\lancedb",
      lanceDbTableName: "code_chunks",
      embeddingBatchSize: 64,
      embeddingConcurrency: 1
    });
  });

  it("reads LanceDB and OpenAI-compatible embedding configuration from env", () => {
    const config = readSemanticRuntimeConfig({
      RAGCODE_SEMANTIC_STORE: "lancedb",
      RAGCODE_LANCEDB_URI: "D:/vectors/ragcode",
      RAGCODE_LANCEDB_TABLE: "chunks_v2",
      RAGCODE_EMBEDDING_PROVIDER: "openai-compatible",
      RAGCODE_EMBEDDING_BASE_URL: "https://example.com/v1",
      RAGCODE_EMBEDDING_MODEL: "custom-embed",
      RAGCODE_EMBEDDING_DIMENSIONS: "1024",
      RAGCODE_EMBEDDING_REQUEST_DIMENSIONS: "true",
      RAGCODE_EMBEDDING_BATCH_SIZE: "32",
      RAGCODE_EMBEDDING_CONCURRENCY: "2"
    });

    expect(config).toEqual({
      semanticStore: "lancedb",
      embeddingProvider: "openai-compatible",
      lanceDbUri: "D:/vectors/ragcode",
      lanceDbTableName: "chunks_v2",
      embeddingBaseUrl: "https://example.com/v1",
      embeddingModel: "custom-embed",
      embeddingDimensions: 1024,
      embeddingRequestDimensions: true,
      embeddingBatchSize: 32,
      embeddingConcurrency: 2,
      semanticMaxChunks: 512
    });
  });

  it("uses OpenAI-compatible embedding responses through an injectable fetch", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const provider = new OpenAICompatibleEmbeddingProvider({
      apiKey: "test-key",
      model: "text-embedding-3-small",
      baseUrl: "https://embed.example/v1/",
      dimensions: 3,
      requestDimensions: true,
      fetch: async (url, init) => {
        calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] })
        } as Response;
      }
    });

    await expect(provider.embed("payment flow")).resolves.toEqual([0.1, 0.2, 0.3]);
    expect(provider.dimensions).toBe(3);
    expect(calls).toEqual([{
      url: "https://embed.example/v1/embeddings",
      body: {
        model: "text-embedding-3-small",
        input: "payment flow",
        dimensions: 3
      }
    }]);
  });

  it("batches OpenAI-compatible embedding requests", async () => {
    const calls: Array<{ body: unknown }> = [];
    const provider = new OpenAICompatibleEmbeddingProvider({
      apiKey: "test-key",
      model: "custom-embed",
      baseUrl: "https://embed.example/v1",
      fetch: async (_url, init) => {
        calls.push({ body: JSON.parse(String(init?.body)) });
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [
              { index: 0, embedding: [1, 0] },
              { index: 1, embedding: [0, 1] }
            ]
          })
        } as Response;
      }
    });

    await expect(provider.embedBatch(["first", "second"])).resolves.toEqual([[1, 0], [0, 1]]);
    expect(calls).toEqual([{ body: { model: "custom-embed", input: ["first", "second"] } }]);
  });

  it("passes configured vector dimensions to a new LanceDB table seed", async () => {
    const table = new SeedCaptureTable();
    const store = new LanceSemanticStore("memory://fake", {
      connection: {
        tableNames: async () => [],
        openTable: async () => table,
        createTable: async (_name, rows) => {
          table.seed = rows[0];
          return table;
        }
      } satisfies LanceConnection,
      vectorDimensions: 1024
    });

    await store.resetRepo("repo-a");

    expect(table.seed?.vector).toHaveLength(1024);
  });

  it("persists and reuses a LanceDB embedding profile", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ragcode-lancedb-profile-"));
    try {
      const table = new SeedCaptureTable();
      const connection = fakeConnection(table);
      const provider = createSemanticRuntimeFromEnv({
        RAGCODE_SEMANTIC_STORE: "memory",
        RAGCODE_EMBEDDING_PROVIDER: "deterministic",
        RAGCODE_EMBEDDING_DIMENSIONS: "32"
      }).embeddingProvider;
      const store = new LanceSemanticStore(root, {
        connection,
        vectorDimensions: 32,
        embeddingProfile: { provider: "deterministic" }
      });

      await store.upsertChunks([chunk({ content: "profile marker" })], provider);

      const profilePath = path.join(root, "code_chunks.embedding-profile.json");
      const profile = JSON.parse(await fs.readFile(profilePath, "utf8"));
      expect(profile).toMatchObject({
        schemaVersion: 1,
        tableName: "code_chunks",
        provider: "deterministic",
        dimensions: 32
      });

      const reopened = new LanceSemanticStore(root, {
        connection,
        vectorDimensions: 32,
        embeddingProfile: { provider: "deterministic" }
      });
      await expect(reopened.search({ repoRoot: "repo-a", projectId: "project-a", query: "profile marker", limit: 5 }, provider)).resolves.toEqual(expect.any(Array));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when the LanceDB embedding dimensions do not match the persisted profile", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ragcode-lancedb-profile-mismatch-"));
    try {
      const table = new SeedCaptureTable();
      const connection = fakeConnection(table);
      const firstProvider = createSemanticRuntimeFromEnv({
        RAGCODE_SEMANTIC_STORE: "memory",
        RAGCODE_EMBEDDING_PROVIDER: "deterministic",
        RAGCODE_EMBEDDING_DIMENSIONS: "32"
      }).embeddingProvider;
      await new LanceSemanticStore(root, {
        connection,
        vectorDimensions: 32,
        embeddingProfile: { provider: "deterministic" }
      }).upsertChunks([chunk({ content: "profile marker" })], firstProvider);

      const mismatchedProvider = createSemanticRuntimeFromEnv({
        RAGCODE_SEMANTIC_STORE: "memory",
        RAGCODE_EMBEDDING_PROVIDER: "deterministic",
        RAGCODE_EMBEDDING_DIMENSIONS: "16"
      }).embeddingProvider;
      const mismatched = new LanceSemanticStore(root, {
        connection,
        vectorDimensions: 16,
        embeddingProfile: { provider: "deterministic" }
      });

      await expect(mismatched.upsertChunks([chunk({ id: "chunk-b", content: "profile marker changed" })], mismatchedProvider))
        .rejects.toThrow(/embedding profile mismatch.*dimensions 32 != 16/i);
      await expect(mismatched.search({ repoRoot: "repo-a", projectId: "project-a", query: "profile marker", limit: 5 }, mismatchedProvider))
        .rejects.toThrow(/embedding profile mismatch.*dimensions 32 != 16/i);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when the LanceDB embedding model identity changes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ragcode-lancedb-model-mismatch-"));
    try {
      const table = new SeedCaptureTable();
      const connection = fakeConnection(table);
      const provider = createSemanticRuntimeFromEnv({
        RAGCODE_SEMANTIC_STORE: "memory",
        RAGCODE_EMBEDDING_PROVIDER: "deterministic",
        RAGCODE_EMBEDDING_DIMENSIONS: "32"
      }).embeddingProvider;

      await new LanceSemanticStore(root, {
        connection,
        vectorDimensions: 32,
        embeddingProfile: { provider: "openai-compatible", model: "model-a", baseUrl: "https://embed.example/v1" }
      }).upsertChunks([chunk({ content: "profile marker" })], provider);

      const mismatched = new LanceSemanticStore(root, {
        connection,
        vectorDimensions: 32,
        embeddingProfile: { provider: "openai-compatible", model: "model-b", baseUrl: "https://embed.example/v1" }
      });

      await expect(mismatched.search({ repoRoot: "repo-a", projectId: "project-a", query: "profile marker", limit: 5 }, provider))
        .rejects.toThrow(/embedding profile mismatch.*model model-a != model-b/i);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("writes LanceDB rows in embedding batches", async () => {
    const table = new SeedCaptureTable();
    const progress: number[] = [];
    const store = new LanceSemanticStore("memory://batched", {
      connection: fakeConnection(table),
      embeddingBatchSize: 2,
      embeddingConcurrency: 1,
      onProgress: (event) => progress.push(event.completedChunks)
    });

    await store.upsertChunks([
      chunk({ id: "chunk-a", filePath: "src/a.ts" }),
      chunk({ id: "chunk-b", filePath: "src/a.ts" }),
      chunk({ id: "chunk-c", filePath: "src/b.ts" })
    ], createSemanticRuntimeFromEnv({
      RAGCODE_SEMANTIC_STORE: "memory",
      RAGCODE_EMBEDDING_PROVIDER: "deterministic"
    }).embeddingProvider);

    expect(table.deletes).toHaveLength(2);
    expect(table.adds.map((rows) => rows.length)).toEqual([2, 1]);
    expect(progress).toEqual([2, 3]);
  });

  it("round-trips chunks through the installed LanceDB package", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ragcode-lancedb-runtime-"));
    try {
      const store = new LanceSemanticStore(path.join(root, "lancedb"));
      const provider = createSemanticRuntimeFromEnv({
        RAGCODE_SEMANTIC_STORE: "memory",
        RAGCODE_EMBEDDING_PROVIDER: "deterministic"
      }).embeddingProvider;

      await store.resetRepo("repo-a");
      await store.upsertChunks([{
        id: "chunk-a",
        projectId: "project-a",
        repoRoot: "repo-a",
        filePath: "src/auth.ts",
        language: "typescript",
        kind: "function",
        symbolName: "loginUser",
        startLine: 1,
        endLine: 1,
        content: "export function loginUser() { return 'lancedb-semantic-marker'; }",
        contentHash: "hash-a"
      }], provider);

      const hits = await store.search({ repoRoot: "repo-a", projectId: "project-a", query: "lancedb semantic marker", limit: 5 }, provider);

      expect(hits[0]).toMatchObject({
        chunk: {
          filePath: "src/auth.ts",
          symbolName: "loginUser"
        },
        source: "semantic",
        reason: "LanceDB vector similarity match"
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("creates runtime components from env without requiring LanceDB when memory mode is selected", () => {
    const runtime = createSemanticRuntimeFromEnv({
      RAGCODE_SEMANTIC_STORE: "memory",
      RAGCODE_EMBEDDING_PROVIDER: "deterministic",
      RAGCODE_EMBEDDING_DIMENSIONS: "32"
    });

    expect(runtime.config.semanticStore).toBe("memory");
    expect(runtime.embeddingProvider.dimensions).toBe(32);
  });
});

class SeedCaptureTable implements LanceTable {
  seed?: LanceChunkRecord;
  adds: LanceChunkRecord[][] = [];
  deletes: string[] = [];

  async add(rows: LanceChunkRecord[]): Promise<void> {
    this.adds.push(rows);
  }

  async delete(predicate: string): Promise<void> {
    this.deletes.push(predicate);
  }

  search(_vector: number[]) {
    return {
      where: (_predicate: string) => ({
        limit: (_limit: number) => ({
          toArray: async () => []
        })
      })
    };
  }
}

function fakeConnection(table: SeedCaptureTable): LanceConnection {
  return {
    tableNames: async () => ["code_chunks"],
    openTable: async () => table,
    createTable: async (_name, rows) => {
      table.seed = rows[0];
      return table;
    }
  } satisfies LanceConnection;
}

function chunk(overrides: Partial<Parameters<LanceSemanticStore["upsertChunks"]>[0][number]> = {}): Parameters<LanceSemanticStore["upsertChunks"]>[0][number] {
  return {
    id: "chunk-a",
    projectId: "project-a",
    repoRoot: "repo-a",
    filePath: "src/auth.ts",
    language: "typescript",
    kind: "function",
    symbolName: "loginUser",
    startLine: 1,
    endLine: 1,
    content: "export function loginUser() { return 'profile marker'; }",
    contentHash: "hash-a",
    ...overrides
  };
}

