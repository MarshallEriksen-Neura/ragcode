import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EmbeddingProvider, LanceChunkRecord, LanceConnection, LanceTable, SemanticStore } from "../src/index.js";
import { DeterministicEmbeddingProvider, LanceSemanticStore, RagCodeEngine } from "../src/index.js";
import type { CodeChunk, SearchHit, SearchQuery } from "../src/index.js";

const provider = new DeterministicEmbeddingProvider();
const tempRoots: string[] = [];

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe("semantic vector consistency", () => {
  it("deletes old vectors by project and file before LanceDB upsert", async () => {
    const table = new FakeLanceTable();
    const store = new LanceSemanticStore("memory://fake", { connection: fakeConnection(table) });

    await store.upsertChunks([chunk({ id: "old", content: "old login vector", symbolName: "loginUser" })], provider);
    await store.upsertChunks([chunk({ id: "new", content: "new login vector", symbolName: "loginUser" })], provider);

    expect(table.deletes).toEqual([
      "projectId = 'project-a' AND filePath = 'src/auth.ts'",
      "projectId = 'project-a' AND filePath = 'src/auth.ts'"
    ]);
    expect(table.records.map((record) => record.id)).toEqual(["new"]);
    expect(table.records[0]).toMatchObject({
      projectId: "project-a",
      filePath: "src/auth.ts",
      symbolName: "loginUser",
      generation: 1
    });
  });

  it("supports explicit single-file vector deletion for incremental indexing", async () => {
    const table = new FakeLanceTable();
    const store = new LanceSemanticStore("memory://fake", { connection: fakeConnection(table) });
    await store.upsertChunks([
      chunk({ id: "auth", filePath: "src/auth.ts", content: "auth vector" }),
      chunk({ id: "profile", filePath: "src/profile.ts", content: "profile vector" })
    ], provider);

    await store.deleteFile("repo-a", "project-a", "src/auth.ts");

    expect(table.records.map((record) => record.filePath)).toEqual(["src/profile.ts"]);
    expect(table.deletes).toContain("projectId = 'project-a' AND filePath = 'src/auth.ts'");
  });

  it("filters LanceDB semantic search by projectId", async () => {
    const table = new FakeLanceTable();
    const store = new LanceSemanticStore("memory://fake", { connection: fakeConnection(table) });
    await store.upsertChunks([
      chunk({ id: "a", projectId: "project-a", repoRoot: "repo-a", content: "shared auth term" }),
      chunk({ id: "b", projectId: "project-b", repoRoot: "repo-b", content: "shared auth term" })
    ], provider);

    const hits = await store.search({ repoRoot: "repo-a", projectId: "project-a", query: "shared auth term", limit: 10 }, provider);

    expect(hits.map((hit) => hit.chunk.projectId)).toEqual(["project-a"]);
    expect(hits.map((hit) => hit.chunk.id)).toEqual(["a"]);
  });

  it("keeps graph indexing and keyword retrieval working when semantic storage is unavailable", async () => {
    const repoRoot = await createRepo({
      "src/auth.ts": [
        "export function loginUser(email: string) {",
        "  return { email, marker: 'graph-only-marker' };",
        "}"
      ].join("\n")
    });
    const engine = new RagCodeEngine({ semanticStore: new FailingSemanticStore() });

    await expect(engine.indexRepo(repoRoot)).resolves.toHaveProperty("files");
    const hits = await engine.searchCode({ repoRoot, query: "graph-only-marker", limit: 5 });

    expect(hits[0]?.chunk.filePath).toBe("src/auth.ts");
    expect(hits[0]?.source).toBe("keyword");
  });
});

class FakeLanceTable implements LanceTable {
  records: LanceChunkRecord[] = [];
  deletes: string[] = [];

  async add(rows: LanceChunkRecord[]): Promise<void> {
    this.records.push(...rows);
  }

  async delete(predicate: string): Promise<void> {
    this.deletes.push(predicate);
    this.records = this.records.filter((record) => !matchesPredicate(record, predicate));
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

class FailingSemanticStore implements SemanticStore {
  async resetRepo(_repoRoot: string): Promise<void> {
    throw new Error("LanceDB unavailable");
  }

  async upsertChunks(_chunks: CodeChunk[], _provider: EmbeddingProvider): Promise<void> {
    throw new Error("LanceDB unavailable");
  }

  async search(_query: SearchQuery, _provider: EmbeddingProvider): Promise<SearchHit[]> {
    throw new Error("LanceDB unavailable");
  }
}

function fakeConnection(table: FakeLanceTable): LanceConnection {
  return {
    tableNames: async () => ["code_chunks"],
    openTable: async () => table,
    createTable: async (_name, rows) => {
      await table.add(rows);
      return table;
    }
  };
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

async function createRepo(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ragcode-semantic-"));
  tempRoots.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content);
  }
  return root;
}

function matchesPredicate(record: LanceChunkRecord, predicate: string): boolean {
  const clauses = predicate.split(/\s+AND\s+/i);
  return clauses.every((clause) => {
    const match = /^\s*(projectId|repoRoot|filePath)\s*=\s*'([^']*)'\s*$/.exec(clause);
    if (!match) return false;
    const key = match[1] as "projectId" | "repoRoot" | "filePath";
    return record[key] === match[2];
  });
}
