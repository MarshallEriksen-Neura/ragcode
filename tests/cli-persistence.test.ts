import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
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

describe("CLI persisted reads", () => {
  it("searches a SQLite index across CLI processes without implicit reindex", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ragcode-cli-persist-"));
    tempRoots.push(root);
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(
      path.join(root, "src", "auth.ts"),
      [
        "export function cliPersistedLogin() {",
        "  return 'cli-persisted-marker';",
        "}"
      ].join("\n")
    );
    await fs.writeFile(
      path.join(root, "src", "auth.test.ts"),
      [
        "import { cliPersistedLogin } from './auth';",
        "",
        "test('cliPersistedLogin', () => {",
        "  expect(cliPersistedLogin()).toContain('cli-persisted-marker');",
        "});"
      ].join("\n")
    );
    const sqlitePath = path.join(root, ".ragcode", "graph.sqlite");
    const env = {
      ...process.env,
      RAGCODE_GRAPH_STORE: "sqlite",
      RAGCODE_SQLITE_PATH: sqlitePath
    };

    await runCli(["index", root, "--full"], env);

    const search = await runCli(["search", root, "cli-persisted-marker", "--limit", "5"], env);
    const hits = JSON.parse(search.stdout) as Array<{ filePath: string }>;
    expect(hits.map((hit) => hit.filePath)).toContain("src/auth.ts");

    const context = await runCli(["context", root, "cli-persisted-marker", "--budget", "2000"], env);
    const pack = JSON.parse(context.stdout) as { snippets: Array<{ filePath: string }> };
    expect(pack.snippets.map((snippet) => snippet.filePath)).toContain("src/auth.ts");

    const impact = await runCli(["impact", root, "cliPersistedLogin"], env);
    const impactReport = JSON.parse(impact.stdout) as { matchedSymbols: Array<{ filePath: string; name: string }> };
    expect(impactReport.matchedSymbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ filePath: "src/auth.ts", name: "cliPersistedLogin" })
    ]));

    const tests = await runCli(["tests", root, "src/auth.ts"], env);
    const related = JSON.parse(tests.stdout) as { tests: Array<{ path: string }> };
    expect(related.tests.map((file) => file.path)).toContain("src/auth.test.ts");

    await fs.writeFile(
      path.join(root, "src", "new-file.ts"),
      "export const shouldNotAppearWithoutRefresh = 'new-file-marker';\n"
    );

    const recorded = await runCli(["record-events", root, "src/auth.ts", "src/new-file.ts", "--burst-threshold", "2", "--max-dirty-files", "10"], env);
    const watcherState = JSON.parse(recorded.stdout) as { burstMode: boolean; pendingFiles: string[] };
    expect(watcherState.burstMode).toBe(true);
    expect(watcherState.pendingFiles).toEqual(["src/auth.ts", "src/new-file.ts"]);

    const status = await runCli(["status", root], env);
    const indexStatus = JSON.parse(status.stdout) as { burstMode: boolean; semanticCoverage: string; freshness: { pendingFiles: string[]; semanticCoverage: string } };
    expect(indexStatus.burstMode).toBe(true);
    expect(indexStatus.semanticCoverage).toBe("indexed_graph");
    expect(indexStatus.freshness.semanticCoverage).toBe("indexed_graph");
    expect(indexStatus.freshness.pendingFiles).toEqual(expect.arrayContaining(["src/auth.ts", "src/new-file.ts"]));

    const staleRead = await runCli(["search", root, "new-file-marker", "--limit", "5"], env);
    expect(JSON.parse(staleRead.stdout)).toEqual([]);
  }, 90_000);

  it("defaults empty CLI indexes to a bounded graph-first bootstrap batch", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ragcode-cli-bootstrap-"));
    tempRoots.push(root);
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "a.ts"), "export const a = 1;\n");
    await fs.writeFile(path.join(root, "src", "b.ts"), "export const b = 2;\n");
    await fs.writeFile(path.join(root, "src", "c.ts"), "export const c = 3;\n");
    const env = {
      ...process.env,
      RAGCODE_GRAPH_STORE: "sqlite",
      RAGCODE_SQLITE_PATH: path.join(root, ".ragcode", "graph.sqlite")
    };

    const result = await runCli(["index", root, "--max-batch-files", "2"], env);
    const output = JSON.parse(result.stdout) as { files: number; partialBootstrap: boolean; semanticDeferred: boolean; pendingFiles: number };
    const progress = result.stderr.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as { index: { phase: string; semanticDeferred?: boolean } });

    expect(output.files).toBe(2);
    expect(output.partialBootstrap).toBe(true);
    expect(output.semanticDeferred).toBe(true);
    expect(output.pendingFiles).toBe(1);
    expect(progress.some((line) => line.index.phase === "scanning_inventory")).toBe(true);
    expect(progress.some((line) => line.index.phase === "writing_semantic_batch" && line.index.semanticDeferred)).toBe(true);
  }, 90_000);

  it("resumes pending bootstrap batches instead of falling back to a full index", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ragcode-cli-bootstrap-resume-"));
    tempRoots.push(root);
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "a.ts"), "export const a = 1;\n");
    await fs.writeFile(path.join(root, "src", "b.ts"), "export const b = 2;\n");
    await fs.writeFile(path.join(root, "src", "c.ts"), "export const c = 3;\n");
    const env = {
      ...process.env,
      RAGCODE_GRAPH_STORE: "sqlite",
      RAGCODE_SQLITE_PATH: path.join(root, ".ragcode", "graph.sqlite")
    };

    const first = JSON.parse((await runCli(["index", root, "--max-batch-files", "2"], env)).stdout) as { files: number; pendingFiles: number; partialBootstrap: boolean };
    const second = JSON.parse((await runCli(["index", root, "--max-batch-files", "2"], env)).stdout) as { files: number; pendingFiles: number; fullReindex: boolean; affectedFiles?: string[] };

    expect(first).toMatchObject({ files: 2, pendingFiles: 1, partialBootstrap: true });
    expect(second.files).toBe(3);
    expect(second.pendingFiles).toBe(0);
    expect(second.fullReindex).toBe(false);
    expect(second.affectedFiles).toEqual(["src/c.ts"]);
  }, 90_000);
});

async function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
  // Run the CLI through the current Node + tsx loader (matches the repo's `node --import tsx`
  // convention) so the test has no implicit dependency on bun being installed — CI has node
  // and tsx but not bun, which previously caused `spawn bun ENOENT`.
  const result = await execFileAsync(
    process.execPath,
    ["--import", "tsx", "src/cli/index.ts", ...args],
    {
      cwd: process.cwd(),
      env,
      encoding: "utf8"
    }
  );
  return {
    stdout: String(result.stdout),
    stderr: String(result.stderr)
  };
}
