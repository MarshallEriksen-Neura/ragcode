import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryGraphStore } from "../src/index.js";
import type { CodeChunk, EmbeddingProvider, EdgeKind, GraphEdge, SearchHit, SearchQuery, SemanticStore, SymbolNode } from "../src/index.js";

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
    expect(index.partialGraphSnapshot).toBe(true);
    expect(index.symbols.some((symbol) => symbol.name === "loginUser" && symbol.filePath === "src/auth.ts")).toBe(false);
    expect(await engine.findSymbol(tempRoot, "loginUser")).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "loginUser", filePath: "src/auth.ts" })
    ]));
    expect(await engine.findSymbol(tempRoot, "refreshProfile")).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "refreshProfile", filePath: "src/profile.ts" })
    ]));

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

  it("honors affected file hints on an empty index as a partial bootstrap batch", async () => {
    const engine = new RagCodeEngine();

    const index = await engine.indexRepo(tempRoot, { affectedFiles: ["src/unrelated.ts"] });

    expect(index.fullReindex).toBe(false);
    expect(index.partialBootstrap).toBe(true);
    expect(index.affectedFiles).toEqual(["src/unrelated.ts"]);
    expect(index.scannedFiles).toEqual(["src/unrelated.ts"]);
    expect(index.files.map((file) => file.path).sort()).toEqual(["src/unrelated.ts"]);
    expect(analyzerProbe.filePaths).toEqual(["src/unrelated.ts"]);

    const status = await engine.indexStatus(tempRoot);
    expect(status.fileCount).toBe(1);
    expect(status.pendingFileCount).toBe(2);
    expect(status.graphFresh).toBe(false);
    expect(status.semanticCoverage).toBe("indexed_graph");
    expect(status.freshness.pendingFiles).toEqual(["src/auth.ts", "src/profile.ts"]);
  });

  it("aborts a batch with an actionable memory guard error", async () => {
    const engine = new RagCodeEngine();

    await expect(engine.indexRepo(tempRoot, {
      affectedFiles: ["src/unrelated.ts"],
      maxAnalysisMemoryMb: 1
    })).rejects.toThrow(/Index memory guard tripped/);
  });

  it("continues partial bootstrap batches without reanalyzing already indexed files", async () => {
    const engine = new RagCodeEngine();
    await engine.indexRepo(tempRoot, { affectedFiles: ["src/unrelated.ts"] });
    analyzerProbe.filePaths = [];

    const index = await engine.indexRepo(tempRoot, { affectedFiles: ["src/auth.ts"] });

    expect(index.fullReindex).toBe(false);
    expect(index.partialBootstrap).toBe(false);
    expect(index.affectedFiles).toEqual(["src/auth.ts"]);
    expect(index.scannedFiles).toEqual(["src/auth.ts"]);
    expect(index.files.map((file) => file.path).sort()).toEqual(["src/auth.ts", "src/unrelated.ts"]);
    expect(analyzerProbe.filePaths).toEqual(["src/auth.ts"]);
  });

  it("uses scoped graph cache readers during incremental refresh instead of full graph loads", async () => {
    const graphStore = new CountingGraphStore();
    const engine = new RagCodeEngine({ graphStore });
    await engine.indexRepo(tempRoot);
    graphStore.resetCounts();
    analyzerProbe.filePaths = [];

    await writeRepoFile("src/unrelated.ts", [
      "export function unrelatedMarker() {",
      "  return 'bounded-cache-marker';",
      "}"
    ].join("\n"));
    const index = await engine.indexRepo(tempRoot, { affectedFiles: ["src/unrelated.ts"] });

    expect(index.partialGraphSnapshot).toBe(true);
    expect(analyzerProbe.filePaths).toEqual(["src/unrelated.ts"]);
    expect(graphStore.fullChunkLoads).toBe(0);
    expect(graphStore.fullSymbolLoads).toBe(0);
    expect(graphStore.fullEdgeLoads).toBe(0);
    expect(graphStore.scopedChunkLoads).toBeGreaterThan(0);
    expect(graphStore.scopedSymbolLoads).toBeGreaterThan(0);
    expect(graphStore.scopedEdgeLoads).toBeGreaterThan(0);
    expect(graphStore.scopedEdgeResultSizes.every((size) => size > 0)).toBe(true);
    expect(index.edges.some((edge) => edge.sourceId === "unrelated-source")).toBe(false);
    expect(graphStore.kindEdgeLoads).toEqual([]);
    expect(graphStore.scopedRouteEdgeLoads).toBeGreaterThan(0);
  });

  it("includes test-file metadata when loading scoped in-memory graph edges", async () => {
    const graphStore = new InMemoryGraphStore();
    const engine = new RagCodeEngine({ graphStore });
    await engine.indexRepo(tempRoot);

    await graphStore.upsertIndex({
      projectId: "manual-project",
      repoRoot: tempRoot,
      indexedAtMs: Date.now(),
      indexGeneration: 2,
      changedFiles: ["src/auth.ts"],
      deletedFiles: [],
      affectedFiles: ["src/auth.ts"],
      fullReindex: false,
      files: [],
      chunks: [],
      symbols: [],
      edges: [{
        projectId: "manual-project",
        sourceId: "src/auth.ts:test-subject",
        targetId: "src/auth.test.ts:test-case",
        kind: "tested_by",
        metadata: { sourceFile: "src/auth.ts", testFile: "src/auth.test.ts" }
      }],
      skippedFiles: []
    });

    const edges = await graphStore.getEdgesForFiles(tempRoot, ["src/auth.test.ts"]);

    expect(edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "tested_by", metadata: expect.objectContaining({ testFile: "src/auth.test.ts" }) })
    ]));
  });

  it("does not turn an empty scoped edge query into a kind-wide load", async () => {
    const graphStore = new InMemoryGraphStore();
    const engine = new RagCodeEngine({ graphStore });
    await engine.indexRepo(tempRoot);

    expect(await graphStore.getEdgesForScope(tempRoot, { kinds: ["imports"] })).toEqual([]);
  });

  it("loads existing framework route catalog edges by scoped route paths during client refresh", async () => {
    const graphStore = new CountingGraphStore();
    const engine = new RagCodeEngine({ graphStore });
    await writeRepoFile("src/server.ts", [
      "import express from 'express';",
      "import { createOrder } from './orders';",
      "const app = express();",
      "app.post('/api/orders', createOrder);"
    ].join("\n"));
    await writeRepoFile("src/orders.ts", [
      "export function createOrder() {",
      "  return { ok: true };",
      "}"
    ].join("\n"));
    await writeRepoFile("src/app/checkout/CheckoutButton.tsx", [
      "\"use client\";",
      "",
      "export function CheckoutButton() {",
      "  async function onClick() {",
      "    await fetch('/api/orders', { method: 'POST' });",
      "  }",
      "  return <button onClick={onClick}>Pay</button>;",
      "}"
    ].join("\n"));
    await engine.indexRepo(tempRoot);
    graphStore.resetCounts();
    analyzerProbe.filePaths = [];

    await writeRepoFile("src/app/checkout/CheckoutButton.tsx", [
      "\"use client\";",
      "",
      "export function CheckoutButton() {",
      "  async function onClick() {",
      "    await fetch('/api/orders', { method: 'POST' });",
      "    const refreshed = 'existing route catalog';",
      "    return refreshed;",
      "  }",
      "  return <button onClick={onClick}>Pay</button>;",
      "}"
    ].join("\n"));
    const index = await engine.indexRepo(tempRoot, { affectedFiles: ["src/app/checkout/CheckoutButton.tsx"] });

    expect(index.changedFiles).toEqual(["src/app/checkout/CheckoutButton.tsx"]);
    expect(analyzerProbe.filePaths).toEqual(["src/app/checkout/CheckoutButton.tsx"]);
    expect(graphStore.kindEdgeLoads).toEqual([]);
    expect(graphStore.scopedRouteEdgeLoads).toBeGreaterThan(0);
    expect(graphStore.routePathScopes).toEqual(expect.arrayContaining([expect.arrayContaining(["/api/orders"])]));
    expect(index.edges).toEqual(expect.arrayContaining([expect.objectContaining({
      kind: "calls_api",
      metadata: expect.objectContaining({
        framework: "express",
        sourceFile: "src/app/checkout/CheckoutButton.tsx",
        targetFile: "src/orders.ts",
        route: "/api/orders"
      })
    })]));
  });

  it("marks deferred semantic bootstrap as rebuild-needed and backfills all indexed chunks on the next batch", async () => {
    const semantic = new RecordingSemanticStore();
    const engine = new RagCodeEngine({ semanticStore: semantic, embeddingProvider: new NoopEmbeddingProvider() });

    await engine.indexRepo(tempRoot, { affectedFiles: ["src/unrelated.ts"], disableSemanticOnBootstrap: true });
    let status = await engine.indexStatus(tempRoot);
    expect(status.semanticFresh).toBe(false);
    expect(status.semanticRebuildNeeded).toBe(true);
    expect(status.semanticLastError).toContain("deferred");
    expect(semantic.upserts).toEqual([]);

    await engine.indexRepo(tempRoot, { affectedFiles: ["src/auth.ts"] });

    status = await engine.indexStatus(tempRoot);
    expect(status.semanticFresh).toBe(true);
    expect(status.semanticCoverage).toBe("indexed_graph");
    expect(status.semanticRebuildNeeded).toBe(false);
    expect(semantic.resets).toEqual([tempRoot]);
    expect(semantic.upserts.at(-1)?.filePaths).toEqual(["src/auth.ts", "src/unrelated.ts"]);
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
    expect(index.analysisWarnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "deduped_symbols", count: 1 }),
      expect.objectContaining({ kind: "deduped_chunks", count: 1 })
    ]));
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
}

class NoopEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = 1;

  async embed(_text: string): Promise<number[]> {
    return [1];
  }
}

class CountingGraphStore extends InMemoryGraphStore {
  fullChunkLoads = 0;
  fullSymbolLoads = 0;
  fullEdgeLoads = 0;
  scopedChunkLoads = 0;
  scopedSymbolLoads = 0;
  scopedEdgeLoads = 0;
  scopedEdgeResultSizes: number[] = [];
  scopedRouteEdgeLoads = 0;
  routePathScopes: string[][] = [];
  kindEdgeLoads: EdgeKind[] = [];

  resetCounts(): void {
    this.fullChunkLoads = 0;
    this.fullSymbolLoads = 0;
    this.fullEdgeLoads = 0;
    this.scopedChunkLoads = 0;
    this.scopedSymbolLoads = 0;
    this.scopedEdgeLoads = 0;
    this.scopedEdgeResultSizes = [];
    this.scopedRouteEdgeLoads = 0;
    this.routePathScopes = [];
    this.kindEdgeLoads = [];
  }

  override async getChunks(repoRoot: string): Promise<CodeChunk[]> {
    this.fullChunkLoads += 1;
    return super.getChunks(repoRoot);
  }

  override async getChunksForFiles(repoRoot: string, filePaths: string[]): Promise<CodeChunk[]> {
    this.scopedChunkLoads += 1;
    return super.getChunksForFiles(repoRoot, filePaths);
  }

  override async getSymbols(repoRoot: string): Promise<SymbolNode[]> {
    this.fullSymbolLoads += 1;
    return super.getSymbols(repoRoot);
  }

  override async getSymbolsForFiles(repoRoot: string, filePaths: string[]): Promise<SymbolNode[]> {
    this.scopedSymbolLoads += 1;
    return super.getSymbolsForFiles(repoRoot, filePaths);
  }

  override async getEdges(repoRoot: string, kind?: EdgeKind): Promise<GraphEdge[]> {
    if (kind) {
      this.kindEdgeLoads.push(kind);
    } else {
      this.fullEdgeLoads += 1;
    }
    return super.getEdges(repoRoot, kind);
  }

  override async getEdgesForFiles(repoRoot: string, filePaths: string[]): Promise<GraphEdge[]> {
    this.scopedEdgeLoads += 1;
    const edges = await super.getEdgesForFiles(repoRoot, filePaths);
    const unrelatedEdge: GraphEdge = {
      projectId: edges[0]?.projectId ?? "project",
      sourceId: "unrelated-source",
      targetId: "unrelated-target",
      kind: "imports",
      metadata: {
        sourceFile: "src/auth.ts",
        targetFile: "src/profile.ts"
      }
    };
    const result = [...edges, unrelatedEdge];
    this.scopedEdgeResultSizes.push(result.length);
    return result;
  }

  override async getEdgesForScope(repoRoot: string, scope: { filePaths?: string[]; routePaths?: string[]; kinds?: EdgeKind[] }): Promise<GraphEdge[]> {
    this.scopedRouteEdgeLoads += 1;
    this.routePathScopes.push([...(scope.routePaths ?? [])].sort());
    return super.getEdgesForScope(repoRoot, scope);
  }
}
