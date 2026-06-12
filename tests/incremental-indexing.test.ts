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
      if (content.includes("DUPLICATE_ANALYSIS_MARKER")) {
        const symbol = {
          id: "duplicate-symbol-id",
          projectId: file.projectId,
          filePath: file.path,
          name: "duplicateSymbol",
          kind: "function" as const,
          language: file.language,
          startLine: 1,
          endLine: 3,
          signature: "export function duplicateSymbol()",
          exported: true
        };
        const chunk = {
          id: "duplicate-chunk-id",
          projectId: file.projectId,
          repoRoot,
          filePath: file.path,
          language: file.language,
          kind: "function" as const,
          symbolName: "duplicateSymbol",
          startLine: 1,
          endLine: 3,
          content,
          contentHash: "duplicate-content-hash"
        };
        return { chunks: [chunk, chunk], symbols: [symbol, symbol], edges: [] };
      }
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

  it("scans only explicitly affected files during affected refreshes", async () => {
    const engine = new RagCodeEngine();
    await engine.indexRepo(tempRoot);
    analyzerProbe.filePaths = [];

    await writeRepoFile("src/unrelated.ts", [
      "export function unrelatedMarker() {",
      "  return 'affected-scan-marker';",
      "}"
    ].join("\n"));
    const index = await engine.indexRepo(tempRoot, { affectedFiles: ["src/unrelated.ts"] });

    expect(index.affectedFiles).toEqual(["src/unrelated.ts"]);
    expect(index.scannedFiles).toEqual(["src/unrelated.ts"]);
    expect(index.changedFiles).toEqual(["src/unrelated.ts"]);
    expect(index.refreshedFiles).toEqual(["src/unrelated.ts"]);
    expect(analyzerProbe.filePaths).toEqual(["src/unrelated.ts"]);
    expect(index.files.map((file) => file.path).sort()).toEqual(["src/auth.ts", "src/profile.ts", "src/unrelated.ts"]);
  });

  it("ignores affected file hints on the first index so cold start remains complete", async () => {
    const engine = new RagCodeEngine();

    const index = await engine.indexRepo(tempRoot, { affectedFiles: ["src/unrelated.ts"] });

    expect(index.fullReindex).toBe(true);
    expect(index.affectedFiles).toBeUndefined();
    expect(index.scannedFiles).toEqual(["src/auth.ts", "src/profile.ts", "src/unrelated.ts"]);
    expect(index.files.map((file) => file.path).sort()).toEqual(["src/auth.ts", "src/profile.ts", "src/unrelated.ts"]);
  });

  it("deduplicates analyzer output before graph persistence", async () => {
    await writeRepoFile("src/duplicate.ts", [
      "export function duplicateSymbol() {",
      "  return 'DUPLICATE_ANALYSIS_MARKER';",
      "}"
    ].join("\n"));

    const engine = new RagCodeEngine();
    const index = await engine.indexRepo(tempRoot);

    expect(index.symbols.filter((symbol) => symbol.id === "duplicate-symbol-id")).toHaveLength(1);
    expect(index.chunks.filter((chunk) => chunk.id === "duplicate-chunk-id")).toHaveLength(1);
    expect(await engine.explainFile(tempRoot, "src/duplicate.ts")).toEqual(expect.objectContaining({
      symbols: [expect.objectContaining({ id: "duplicate-symbol-id" })],
      chunks: [expect.objectContaining({ id: "duplicate-chunk-id" })]
    }));
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

  it("refreshes only direct API clients when a Next.js route changes", async () => {
    await writeRepoFile("src/app/checkout/CheckoutButton.tsx", [
      "\"use client\";",
      "",
      "export function CheckoutButton() {",
      "  async function onClick() {",
      "    await fetch('/api/payments', { method: 'POST' });",
      "  }",
      "  return <button onClick={onClick}>Pay</button>;",
      "}"
    ].join("\n"));
    await writeRepoFile("src/app/api/payments/route.ts", [
      "export async function POST() {",
      "  return Response.json({ ok: true });",
      "}"
    ].join("\n"));
    await writeRepoFile("src/app/api/orders/route.ts", [
      "export async function POST() {",
      "  return Response.json({ order: true });",
      "}"
    ].join("\n"));
    await writeRepoFile("src/app/orders/OrdersButton.tsx", [
      "\"use client\";",
      "",
      "export function OrdersButton() {",
      "  async function onClick() {",
      "    await fetch('/api/orders', { method: 'POST' });",
      "  }",
      "  return <button onClick={onClick}>Order</button>;",
      "}"
    ].join("\n"));

    const engine = new RagCodeEngine();
    await engine.indexRepo(tempRoot);
    analyzerProbe.filePaths = [];

    await writeRepoFile("src/app/api/payments/route.ts", [
      "export async function POST() {",
      "  return Response.json({ ok: 'changed' });",
      "}"
    ].join("\n"));
    const index = await engine.indexRepo(tempRoot);

    expect(index.changedFiles).toEqual(["src/app/api/payments/route.ts"]);
    expect(index.refreshedFiles).toEqual(["src/app/api/payments/route.ts", "src/app/checkout/CheckoutButton.tsx"]);
    expect([...analyzerProbe.filePaths].sort()).toEqual(["src/app/api/payments/route.ts", "src/app/checkout/CheckoutButton.tsx"]);
    expect(analyzerProbe.filePaths).not.toContain("src/app/api/orders/route.ts");
    expect(analyzerProbe.filePaths).not.toContain("src/app/orders/OrdersButton.tsx");
    expect(analyzerProbe.filePaths).not.toContain("src/unrelated.ts");
  });

  it("refreshes route files from middleware reverse edges without reanalyzing every TypeScript file", async () => {
    await writeRepoFile("src/middleware.ts", [
      "export function middleware() {",
      "  return Response.next();",
      "}"
    ].join("\n"));
    await writeRepoFile("src/app/api/payments/route.ts", [
      "export async function POST() {",
      "  return Response.json({ ok: true });",
      "}"
    ].join("\n"));
    await writeRepoFile("src/app/api/orders/route.ts", [
      "export async function POST() {",
      "  return Response.json({ order: true });",
      "}"
    ].join("\n"));
    await writeRepoFile("src/app/checkout/CheckoutButton.tsx", [
      "\"use client\";",
      "export function CheckoutButton() {",
      "  return <button>Pay</button>;",
      "}"
    ].join("\n"));

    const engine = new RagCodeEngine();
    await engine.indexRepo(tempRoot);
    analyzerProbe.filePaths = [];

    await writeRepoFile("src/middleware.ts", [
      "export function middleware() {",
      "  return new Response('changed');",
      "}"
    ].join("\n"));
    const index = await engine.indexRepo(tempRoot);

    expect(index.changedFiles).toEqual(["src/middleware.ts"]);
    expect(index.refreshedFiles).toEqual(["src/app/api/orders/route.ts", "src/app/api/payments/route.ts", "src/middleware.ts"]);
    expect([...analyzerProbe.filePaths].sort()).toEqual(["src/app/api/orders/route.ts", "src/app/api/payments/route.ts", "src/middleware.ts"]);
    expect(analyzerProbe.filePaths).not.toContain("src/app/checkout/CheckoutButton.tsx");
    expect(analyzerProbe.filePaths).not.toContain("src/unrelated.ts");
  });
});

async function writeRepoFile(relativePath: string, content: string): Promise<void> {
  const absolutePath = path.join(tempRoot, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, `${content}\n`);
}
