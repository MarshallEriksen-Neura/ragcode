import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RagCodeEngine } from "../src/index.js";

const tempRoots: string[] = [];

afterEach(async () => {
  if (process.platform !== "win32") {
    for (const root of tempRoots.splice(0)) {
      await fs.rm(root, { recursive: true, force: true });
    }
  } else {
    tempRoots.splice(0);
  }
});

describe("watcher dirty-file state", () => {
  it("persists coalesced burst state and keeps retrieval on last-known-good clean files", async () => {
    const root = await createRepo("ragcode-watcher-state-", {
      "src/auth.ts": "export function loginUser() { return 'auth-old-marker'; }\n",
      "src/stable.ts": "export function stableHelper() { return 'stable-clean-marker'; }\n"
    });
    const env = {
      ...process.env,
      RAGCODE_GRAPH_STORE: "sqlite",
      RAGCODE_SQLITE_PATH: path.join(root, ".ragcode", "graph.sqlite")
    };

    const firstEngine = new RagCodeEngine({ cwd: root, env });
    await firstEngine.indexRepo(root);
    firstEngine.close();

    await fs.writeFile(path.join(root, "src", "auth.ts"), "export function loginUser() { return 'auth-new-marker'; }\n");
    const secondEngine = new RagCodeEngine({ cwd: root, env });
    const recorded = await secondEngine.recordFileEvents(root, [
      "src/auth.ts",
      "src/auth.ts",
      path.join(root, "src", "stable.ts"),
      "src/new.ts",
      "src/overflow.ts"
    ], {
      burstThreshold: 2,
      maxDirtyFiles: 3
    });

    expect(recorded.burstMode).toBe(true);
    expect(recorded.droppedEvents).toBe(1);
    expect(recorded.pendingFiles).toEqual(["src/auth.ts", "src/new.ts", "src/overflow.ts"]);
    expect(recorded.dirtyFiles.find((file) => file.filePath === "src/auth.ts")?.eventCount).toBe(2);
    secondEngine.close();

    const restartedEngine = new RagCodeEngine({ cwd: root, env });
    try {
      const status = await restartedEngine.indexStatus(root);
      expect(status.burstMode).toBe(true);
      expect(status.droppedEventCount).toBe(1);
      expect(status.pendingFileCount).toBeGreaterThanOrEqual(3);
      expect(status.freshness.pendingFiles).toEqual(expect.arrayContaining(["src/auth.ts", "src/new.ts", "src/overflow.ts"]));
      expect(status.freshness.staleFiles).toContain("src/auth.ts");
      expect(status.freshness.dirtyFiles.map((file) => file.filePath)).toEqual(["src/auth.ts", "src/new.ts", "src/overflow.ts"]);

      const dirtyHits = await restartedEngine.searchCode({ repoRoot: root, query: "auth-old-marker", limit: 10 });
      expect(dirtyHits).toEqual([]);

      const cleanHits = await restartedEngine.searchCode({ repoRoot: root, query: "stable-clean-marker", limit: 10 });
      expect(cleanHits[0]?.chunk.filePath).toBe("src/stable.ts");

      const pack = await restartedEngine.getContext({ repoRoot: root, query: "stable-clean-marker", budgetChars: 2000 });
      expect(pack.freshness.burstMode).toBe(true);
      expect(pack.missingEvidence).toEqual(expect.arrayContaining([
        expect.stringContaining("Watcher burst mode is active")
      ]));

      await restartedEngine.indexRepo(root);
      const refreshed = await restartedEngine.indexStatus(root);
      expect(refreshed.burstMode).toBe(false);
      expect(refreshed.pendingFileCount).toBe(0);
      expect(refreshed.freshness.dirtyFiles).toEqual([]);
    } finally {
      restartedEngine.close();
    }
  });
});

async function createRepo(prefix: string, files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content);
  }
  return root;
}
