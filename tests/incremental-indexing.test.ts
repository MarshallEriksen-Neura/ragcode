import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const analyzerProbe = vi.hoisted(() => ({
  filePaths: [] as string[]
}));

vi.mock("../src/indexing/ast-analyzer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/indexing/ast-analyzer.js")>();
  return {
    ...actual,
    analyzeFile: ((repoRoot, file, content) => {
      analyzerProbe.filePaths.push(file.path);
      return actual.analyzeFile(repoRoot, file, content);
    }) satisfies typeof actual.analyzeFile
  };
});

const { RagCodeEngine } = await import("../src/index.js");

let tempRoot: string;

beforeEach(async () => {
  analyzerProbe.filePaths = [];
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ragcode-incremental-"));
  await writeRepoFile("src/auth.ts", [
    "import { refreshProfile } from './profile';",
    "",
    "export function loginUser(email: string) {",
    "  return refreshProfile(email);",
    "}"
  ].join("\n"));
  await writeRepoFile("src/profile.ts", [
    "export function refreshProfile(userId: string) {",
    "  return `/profiles/${userId}`;",
    "}"
  ].join("\n"));
  await writeRepoFile("src/unrelated.ts", [
    "export function unrelatedMarker() {",
    "  return 'old-unrelated-marker';",
    "}"
  ].join("\n"));
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe("incremental indexing", () => {
  it("reuses cached analysis for unchanged files on an unrelated one-file refresh", async () => {
    const engine = new RagCodeEngine();
    await engine.indexRepo(tempRoot);
    analyzerProbe.filePaths = [];

    await writeRepoFile("src/unrelated.ts", [
      "export function unrelatedMarker() {",
      "  return 'new-unrelated-marker';",
      "}"
    ].join("\n"));
    const index = await engine.indexRepo(tempRoot);

    expect(index.changedFiles).toEqual(["src/unrelated.ts"]);
    expect(index.deletedFiles).toEqual([]);
    expect(index.refreshedFiles).toEqual(["src/unrelated.ts"]);
    expect(analyzerProbe.filePaths).toEqual(["src/unrelated.ts"]);
    expect(index.symbols.some((symbol) => symbol.name === "loginUser" && symbol.filePath === "src/auth.ts")).toBe(true);
    expect(index.symbols.some((symbol) => symbol.name === "refreshProfile" && symbol.filePath === "src/profile.ts")).toBe(true);

    const explained = await engine.explainFile(tempRoot, "src/unrelated.ts");
    expect(explained.chunks.some((chunk) => chunk.content.includes("old-unrelated-marker"))).toBe(false);
    expect(explained.chunks.some((chunk) => chunk.content.includes("new-unrelated-marker"))).toBe(true);
  });

  it("refreshes importers when a changed target file can alter resolved cross-file edges", async () => {
    const engine = new RagCodeEngine();
    await engine.indexRepo(tempRoot);
    analyzerProbe.filePaths = [];

    await writeRepoFile("src/profile.ts", [
      "export function loadProfile(userId: string) {",
      "  return `/profiles/${userId}`;",
      "}"
    ].join("\n"));
    const index = await engine.indexRepo(tempRoot);

    expect(index.changedFiles).toEqual(["src/profile.ts"]);
    expect(index.refreshedFiles).toEqual(["src/auth.ts", "src/profile.ts"]);
    expect([...analyzerProbe.filePaths].sort()).toEqual(["src/auth.ts", "src/profile.ts"]);
    expect(index.edges.find((edge) => edge.kind === "calls" && edge.metadata?.sourceFile === "src/auth.ts" && edge.metadata?.targetName === "refreshProfile")?.metadata?.resolution).toBe("unresolved");
  });

  it("removes deleted files and refreshes old source references without reanalyzing the whole repo", async () => {
    const engine = new RagCodeEngine();
    await engine.indexRepo(tempRoot);
    analyzerProbe.filePaths = [];

    await fs.rm(path.join(tempRoot, "src", "profile.ts"));
    const index = await engine.indexRepo(tempRoot);

    expect(index.changedFiles).toEqual([]);
    expect(index.deletedFiles).toEqual(["src/profile.ts"]);
    expect(index.refreshedFiles).toEqual(["src/auth.ts"]);
    expect(analyzerProbe.filePaths).toEqual(["src/auth.ts"]);
    expect(index.files.map((file) => file.path)).not.toContain("src/profile.ts");
    expect(index.symbols.some((symbol) => symbol.filePath === "src/profile.ts")).toBe(false);
    expect(index.edges.find((edge) => edge.kind === "imports" && edge.metadata?.sourceFile === "src/auth.ts")?.metadata?.resolution).toBe("unresolved");
  });

  it("drops unreferenced deleted files from the returned snapshot without analyzing other files", async () => {
    const engine = new RagCodeEngine();
    await engine.indexRepo(tempRoot);
    analyzerProbe.filePaths = [];

    await fs.rm(path.join(tempRoot, "src", "unrelated.ts"));
    const index = await engine.indexRepo(tempRoot);

    expect(index.changedFiles).toEqual([]);
    expect(index.deletedFiles).toEqual(["src/unrelated.ts"]);
    expect(index.refreshedFiles).toEqual([]);
    expect(analyzerProbe.filePaths).toEqual([]);
    expect(index.files.map((file) => file.path)).not.toContain("src/unrelated.ts");
    expect(index.chunks.some((chunk) => chunk.filePath === "src/unrelated.ts")).toBe(false);
    expect(index.symbols.some((symbol) => symbol.filePath === "src/unrelated.ts")).toBe(false);
  });
});

async function writeRepoFile(relativePath: string, content: string): Promise<void> {
  const absolutePath = path.join(tempRoot, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, `${content}\n`);
}
