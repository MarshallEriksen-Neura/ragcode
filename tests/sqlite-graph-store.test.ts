import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { EmbeddingProvider, SearchHit, SearchQuery, SemanticStore } from "../src/index.js";
import type { CodeChunk } from "../src/index.js";
import { RagCodeEngine, SQLiteGraphStore } from "../src/index.js";

const tempRoots: string[] = [];

afterEach(async () => {
  // Skip cleanup on Windows due to bun:sqlite file handle release timing
  // Temp files are cleaned by OS tmpdir policy
  if (process.platform !== "win32") {
    for (const root of tempRoots.splice(0)) {
      await rmWithRetry(root);
    }
  } else {
    tempRoots.splice(0);
  }
});

async function rmWithRetry(dirPath: string, maxRetries = 3): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      await fs.rm(dirPath, { recursive: true, force: true });
      return;
    } catch (err: unknown) {
      if (i === maxRetries - 1) throw err;
      await new Promise((resolve) => setTimeout(resolve, 50 * (i + 1)));
    }
  }
}

describe("SQLiteGraphStore", () => {
  it("persists graph rows and skipped file freshness metadata", async () => {
    const repoRoot = await createRepo("sqlite-persist", {
      "src/auth.ts": [
        "import { refreshProfile } from './profile';",
        "",
        "export function loginUser(email: string) {",
        "  refreshProfile(email);",
        "  return { email, authenticated: true };",
        "}"
      ].join("\n"),
      "src/profile.ts": [
        "export function refreshProfile(userId: string) {",
        "  return `/profiles/${userId}`;",
        "}"
      ].join("\n"),
      ".env": "SECRET_TOKEN=do-not-index\n"
    });
    const dbPath = await tempDbPath();

    const store = new SQLiteGraphStore(dbPath);
    const engine = new RagCodeEngine({ graphStore: store });
    const index = await engine.indexRepo(repoRoot);
    store.close();

    const reopened = new SQLiteGraphStore(dbPath);
    try {
      expect((await reopened.getFiles(repoRoot)).map((file) => file.path)).toEqual(["src/auth.ts", "src/profile.ts"]);
      expect((await reopened.findSymbol(repoRoot, "loginUser"))[0]?.projectId).toBe(index.projectId);
      expect(await reopened.getSkippedFiles(repoRoot)).toEqual([
        { filePath: ".env", reason: "sensitive file policy" }
      ]);
    } finally {
      reopened.close();
    }
  });

  it("transactionally replaces changed and deleted file rows on reindex", async () => {
    const repoRoot = await createRepo("sqlite-replace", {
      "src/auth.ts": [
        "import { refreshProfile } from './profile';",
        "",
        "export function loginUser(email: string) {",
        "  refreshProfile(email);",
        "  return { email, authenticated: true };",
        "}"
      ].join("\n"),
      "src/profile.ts": [
        "export function refreshProfile(userId: string) {",
        "  return `/profiles/${userId}`;",
        "}"
      ].join("\n")
    });
    const store = new SQLiteGraphStore(await tempDbPath());
    const engine = new RagCodeEngine({ graphStore: store });

    try {
      await engine.indexRepo(repoRoot);
      await fs.writeFile(
        path.join(repoRoot, "src", "auth.ts"),
        [
          "export function logoutUser(email: string) {",
          "  return { email, authenticated: false };",
          "}"
        ].join("\n")
      );
      await fs.rm(path.join(repoRoot, "src", "profile.ts"));
      await engine.indexRepo(repoRoot);

      expect(await store.findSymbol(repoRoot, "loginUser")).toEqual([]);
      expect((await store.findSymbol(repoRoot, "logoutUser"))[0]?.filePath).toBe("src/auth.ts");
      expect((await store.explainFile(repoRoot, "src/profile.ts")).file).toBeUndefined();
      expect(await store.searchText({ repoRoot, query: "refreshProfile", limit: 10 })).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("increments generation and only updates semantic chunks for changed or deleted files", async () => {
    const repoRoot = await createRepo("sqlite-incremental", {
      "src/auth.ts": "export function loginUser() { return 'login-v1-marker'; }\n",
      "src/profile.ts": "export function refreshProfile() { return 'profile-delete-marker'; }\n",
      "src/stable.ts": "export function stableHelper() { return 'stable-unchanged-marker'; }\n"
    });
    const dbPath = await tempDbPath();
    const store = new SQLiteGraphStore(dbPath);
    const semantic = new RecordingSemanticStore();
    const engine = new RagCodeEngine({ graphStore: store, semanticStore: semantic, embeddingProvider: new NoopEmbeddingProvider() });

    try {
      const first = await engine.indexRepo(repoRoot);
      expect(first).toMatchObject({
        indexGeneration: 1,
        fullReindex: true,
        deletedFiles: []
      });
      expect(first.changedFiles).toEqual(["src/auth.ts", "src/profile.ts", "src/stable.ts"]);
      expect(semantic.resets).toEqual([repoRoot]);
      expect(semantic.upserts[0]?.filePaths).toEqual(["src/auth.ts", "src/profile.ts", "src/stable.ts"]);

      semantic.clear();
      await fs.writeFile(path.join(repoRoot, "src", "auth.ts"), "export function logoutUser() { return 'login-v2-marker'; }\n");
      await fs.rm(path.join(repoRoot, "src", "profile.ts"));
      const second = await engine.indexRepo(repoRoot);

      expect(second).toMatchObject({
        projectId: first.projectId,
        indexGeneration: 2,
        fullReindex: false,
        changedFiles: ["src/auth.ts"],
        deletedFiles: ["src/profile.ts"]
      });
      expect(await store.getIndexGeneration(repoRoot)).toBe(2);
      expect((await engine.indexStatus(repoRoot)).freshness.indexGeneration).toBe(2);
      expect(fileGenerations(dbPath, first.projectId)).toEqual({
        "src/auth.ts": 2,
        "src/stable.ts": 1
      });
      expect(semantic.resets).toEqual([]);
      expect(semantic.deletes.map((entry) => entry.filePath)).toEqual(["src/auth.ts", "src/profile.ts"]);
      expect(semantic.upserts).toEqual([
        {
          generation: 2,
          filePaths: ["src/auth.ts"]
        }
      ]);
      expect(await store.searchText({ repoRoot, query: "profile-delete-marker", limit: 10 })).toEqual([]);
      expect((await store.searchText({ repoRoot, query: "stable-unchanged-marker", limit: 10 }))[0]?.chunk.filePath).toBe("src/stable.ts");
    } finally {
      store.close();
    }
  });

  it("preserves skipped files across affected refreshes without duplicate-key failures", async () => {
    const repoRoot = await createRepo("sqlite-skipped-incremental", {
      "src/a.ts": "export const a = 1;\n",
      "src/b.ts": "export const b = 1;\n",
      "secrets/.env": "TOKEN=secret\n"
    });
    const store = new SQLiteGraphStore(await tempDbPath());
    const engine = new RagCodeEngine({ graphStore: store });

    try {
      await engine.indexRepo(repoRoot, { affectedFiles: ["src/a.ts", "secrets/.env"] });
      await expect(engine.indexRepo(repoRoot, { affectedFiles: ["src/b.ts"] })).resolves.toBeDefined();

      expect(await store.getSkippedFiles(repoRoot)).toEqual([
        { filePath: "secrets/.env", reason: "sensitive file policy" }
      ]);
    } finally {
      store.close();
    }
  });

  it("uses SQLite FTS bm25 ranking for keyword search", async () => {
    const repeatedTerm = Array.from({ length: 20 }, () => "critical-marker").join(" ");
    const repoRoot = await createRepo("sqlite-fts", {
      "src/a-low.ts": "export function lowPriority() { return 'critical-marker'; }\n",
      "src/z-high.ts": `export function highPriority() { return '${repeatedTerm}'; }\n`
    });
    const store = new SQLiteGraphStore(await tempDbPath());
    const engine = new RagCodeEngine({ graphStore: store });

    try {
      await engine.indexRepo(repoRoot);

      const hits = await store.searchText({ repoRoot, query: "critical-marker", limit: 5 });

      expect(hits[0]?.chunk.filePath).toBe("src/z-high.ts");
      expect(hits[0]?.reason).toContain("FTS MATCH");
      expect(hits[0]?.reason).toContain("bm25");
    } finally {
      store.close();
    }
  });

  it("keeps projects isolated inside one SQLite database", async () => {
    const firstRoot = await createRepo("sqlite-project-a", {
      "src/auth.ts": "export function alphaOnlyLogin() { return 'alpha-project-only'; }\n"
    });
    const secondRoot = await createRepo("sqlite-project-b", {
      "src/auth.ts": "export function betaOnlyLogin() { return 'beta-project-only'; }\n"
    });
    const store = new SQLiteGraphStore(await tempDbPath());
    const engine = new RagCodeEngine({ graphStore: store });

    try {
      const first = await engine.indexRepo(firstRoot);
      const second = await engine.indexRepo(secondRoot);
      expect(first.projectId).not.toBe(second.projectId);

      expect(await store.searchText({ repoRoot: firstRoot, query: "beta-project-only", limit: 10 })).toEqual([]);
      const secondHits = await store.searchText({ repoRoot: secondRoot, query: "beta-project-only", limit: 10 });
      expect(secondHits[0]?.chunk.projectId).toBe(second.projectId);
      expect(secondHits[0]?.reason).toContain("FTS MATCH");
      await expect(store.searchText({ repoRoot: firstRoot, projectId: second.projectId, query: "beta-project-only" })).rejects.toThrow(/Project scope mismatch/);
    } finally {
      store.close();
    }
  });

  it("accepts a stale project id when it belongs to the same canonical root", async () => {
    const repoRoot = await createRepo("sqlite-stale-project-id", {
      "src/scratch.ts": "export function scratchOwner() { return 'scratch-owner-marker'; }\n"
    });
    const dbPath = await tempDbPath();
    const store = new SQLiteGraphStore(dbPath);
    const engine = new RagCodeEngine({ graphStore: store });

    try {
      const current = await engine.indexRepo(repoRoot);
      const staleProjectId = "stale-same-root-project";
      const db = new DatabaseSync(dbPath);
      try {
        db.prepare(`
          INSERT INTO projects(
            project_id,
            repo_root,
            canonical_root,
            display_name,
            created_at_ms,
            last_indexed_at_ms,
            indexed_at_ms,
            index_generation
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          staleProjectId,
          repoRoot,
          repoRoot,
          "stale-same-root",
          current.indexedAtMs - 2,
          current.indexedAtMs - 2,
          current.indexedAtMs - 2,
          Math.max(1, current.indexGeneration - 1)
        );
      } finally {
        db.close();
      }

      const hits = await store.searchText({ repoRoot, projectId: staleProjectId, query: "scratch-owner-marker", limit: 5 });

      expect(hits[0]?.chunk.projectId).toBe(current.projectId);
      expect(hits[0]?.chunk.filePath).toBe("src/scratch.ts");
    } finally {
      store.close();
    }
  });
});

async function createRepo(prefix: string, files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  tempRoots.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content);
  }
  return root;
}

async function tempDbPath(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ragcode-sqlite-db-"));
  tempRoots.push(root);
  return path.join(root, "graph.sqlite");
}

class RecordingSemanticStore implements SemanticStore {
  resets: string[] = [];
  deletes: Array<{ repoRoot: string; projectId: string; filePath: string }> = [];
  upserts: Array<{ generation: number | undefined; filePaths: string[] }> = [];

  async resetRepo(repoRoot: string): Promise<void> {
    this.resets.push(repoRoot);
  }

  async deleteFile(repoRoot: string, projectId: string, filePath: string): Promise<void> {
    this.deletes.push({ repoRoot, projectId, filePath });
  }

  async upsertChunks(chunks: CodeChunk[], _provider: EmbeddingProvider, generation?: number): Promise<void> {
    this.upserts.push({
      generation,
      filePaths: [...new Set(chunks.map((chunk) => chunk.filePath))].sort()
    });
  }

  async search(_query: SearchQuery, _provider: EmbeddingProvider): Promise<SearchHit[]> {
    return [];
  }

  clear(): void {
    this.resets = [];
    this.deletes = [];
    this.upserts = [];
  }
}

class NoopEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = 1;

  async embed(_text: string): Promise<number[]> {
    return [1];
  }
}

function fileGenerations(dbPath: string, projectId: string): Record<string, number> {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return Object.fromEntries(
      db.prepare("SELECT path, generation FROM files WHERE project_id = ? ORDER BY path")
        .all(projectId)
        .map((row: any) => [String(row.path), Number(row.generation)])
    );
  } finally {
    db.close();
  }
}
