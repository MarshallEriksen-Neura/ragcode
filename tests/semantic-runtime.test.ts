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
      lanceDbTableName: "code_chunks"
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
      RAGCODE_EMBEDDING_REQUEST_DIMENSIONS: "true"
    });

    expect(config).toEqual({
      semanticStore: "lancedb",
      embeddingProvider: "openai-compatible",
      lanceDbUri: "D:/vectors/ragcode",
      lanceDbTableName: "chunks_v2",
      embeddingBaseUrl: "https://example.com/v1",
      embeddingModel: "custom-embed",
      embeddingDimensions: 1024,
      embeddingRequestDimensions: true
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
          json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] })
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

  async add(_rows: LanceChunkRecord[]): Promise<void> {}

  async delete(_predicate: string): Promise<void> {}

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
