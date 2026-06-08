import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
