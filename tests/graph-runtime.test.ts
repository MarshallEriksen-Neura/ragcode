import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGraphRuntimeFromEnv, RagCodeEngine, readGraphRuntimeConfig, SQLiteGraphStore } from "../src/index.js";

const tempRoots: string[] = [];

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe("graph runtime configuration", () => {
  it("defaults to in-memory graph storage with a conventional SQLite path available", () => {
    const config = readGraphRuntimeConfig({}, "D:/repo");

    expect(config).toEqual({
      graphStore: "memory",
      sqlitePath: "D:\\repo\\.ragcode\\graph.sqlite"
    });
  });

  it("reads SQLite graph storage configuration from env", () => {
    const config = readGraphRuntimeConfig({
      RAGCODE_GRAPH_STORE: "sqlite",
      RAGCODE_SQLITE_PATH: "D:/ragcode/graph.sqlite"
    }, "D:/repo");

    expect(config).toEqual({
      graphStore: "sqlite",
      sqlitePath: "D:/ragcode/graph.sqlite"
    });
  });

  it("creates parent directories and opens SQLiteGraphStore from env", async () => {
    const root = await tempDir("ragcode-graph-runtime-");
    const sqlitePath = path.join(root, "nested", "graph.sqlite");

    const runtime = createGraphRuntimeFromEnv({
      RAGCODE_GRAPH_STORE: "sqlite",
      RAGCODE_SQLITE_PATH: sqlitePath
    }, root);

    expect(runtime.config.graphStore).toBe("sqlite");
    expect(runtime.graphStore).toBeInstanceOf(SQLiteGraphStore);
    expect(await exists(path.dirname(sqlitePath))).toBe(true);
    (runtime.graphStore as SQLiteGraphStore).close();
  });

  it("lets RagCodeEngine persist graph rows through env-selected SQLite", async () => {
    const root = await tempDir("ragcode-engine-sqlite-");
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(
      path.join(root, "src", "auth.ts"),
      [
        "export function loginUser() {",
        "  return 'sqlite-runtime-marker';",
        "}"
      ].join("\n")
    );
    const sqlitePath = path.join(root, ".ragcode", "graph.sqlite");
    const previousGraphStore = process.env.RAGCODE_GRAPH_STORE;
    const previousSqlitePath = process.env.RAGCODE_SQLITE_PATH;

    try {
      process.env.RAGCODE_GRAPH_STORE = "sqlite";
      process.env.RAGCODE_SQLITE_PATH = sqlitePath;
      const firstEngine = new RagCodeEngine({ cwd: root });
      await firstEngine.indexRepo(root);
      firstEngine.close();

      const reopenedStore = new SQLiteGraphStore(sqlitePath);
      try {
        const hits = await reopenedStore.searchText({ repoRoot: root, query: "sqlite-runtime-marker", limit: 5 });
        expect(hits[0]).toMatchObject({
          chunk: {
            filePath: "src/auth.ts"
          },
          source: "keyword"
        });
      } finally {
        reopenedStore.close();
      }
    } finally {
      restoreEnv("RAGCODE_GRAPH_STORE", previousGraphStore);
      restoreEnv("RAGCODE_SQLITE_PATH", previousSqlitePath);
    }
  });
});

async function tempDir(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
