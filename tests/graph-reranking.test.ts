import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GraphStore } from "../src/core/contracts.js";
import type { CodeChunk, EdgeKind, GraphEdge, SearchHit, SymbolNode } from "../src/core/types.js";
import { RagCodeEngine } from "../src/index.js";
import { rerankWithGraph } from "../src/retrieval/graph-reranker.js";

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ragcode-rerank-"));
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe("graph-based reranking", () => {
  it("promotes direct callers and callees over disconnected semantic matches", async () => {
    const projectId = "project-a";
    const symbols = [
      symbol(projectId, "route", "POST", "src/app/api/payments/route.ts"),
      symbol(projectId, "service", "createPaymentIntent", "src/services/billing.ts")
    ];
    const edges: GraphEdge[] = [
      edge(projectId, "route", "service", "routes_to", {
        sourceFile: "src/app/api/payments/route.ts",
        targetFile: "src/services/billing.ts",
        targetName: "createPaymentIntent"
      })
    ];
    const hits: SearchHit[] = [
      hit("docs/payment-playbook.md", "markdown", 1.8, "semantic", "Disconnected payment payment payment docs"),
      hit("src/services/billing.ts", "typescript", 0.8, "keyword", "Matched owner"),
      hit("src/app/api/payments/route.ts", "typescript", 0.2, "keyword", "Weak direct route match")
    ];

    const reranked = await rerankWithGraph(hits, { repoRoot: tempRoot, projectId, query: "payment billing", mode: "feature" }, "feature", {
      graphStore: graphStore(symbols, edges),
      maxSeeds: 1
    });

    expect(indexOfFile(reranked, "src/services/billing.ts")).toBeLessThan(indexOfFile(reranked, "docs/payment-playbook.md"));
    expect(indexOfFile(reranked, "src/app/api/payments/route.ts")).toBeLessThan(indexOfFile(reranked, "docs/payment-playbook.md"));
    expect(reranked.find((candidate) => candidate.chunk.filePath === "src/app/api/payments/route.ts")?.reason)
      .toContain("graph rerank: graph proximity 1 hop via routes_to");
  });

  it("caches the scoped graph by index generation across reranks", async () => {
    const projectId = "project-a";
    const symbols = [
      symbol(projectId, "route", "POST", "src/app/api/payments/route.ts"),
      symbol(projectId, "service", "createPaymentIntent", "src/services/billing.ts")
    ];
    const edges: GraphEdge[] = [
      edge(projectId, "route", "service", "routes_to", {
        sourceFile: "src/app/api/payments/route.ts",
        targetFile: "src/services/billing.ts",
        targetName: "createPaymentIntent"
      })
    ];
    let symbolLoads = 0;
    const store = {
      getIndexGeneration: async () => 7,
      getSymbols: async () => { symbolLoads += 1; return symbols; },
      getEdges: async () => edges,
      getChunks: async () => []
    } as unknown as GraphStore;
    const hits: SearchHit[] = [
      hit("src/services/billing.ts", "typescript", 0.8, "keyword", "owner"),
      hit("src/app/api/payments/route.ts", "typescript", 0.2, "keyword", "route")
    ];

    await rerankWithGraph(hits, { repoRoot: tempRoot, projectId, query: "payment billing", mode: "feature" }, "feature", { graphStore: store, maxSeeds: 1 });
    await rerankWithGraph(hits, { repoRoot: tempRoot, projectId, query: "payment billing", mode: "feature" }, "feature", { graphStore: store, maxSeeds: 1 });

    // Second rerank at the same index generation reuses the cached scoped graph (no reload).
    expect(symbolLoads).toBe(1);
  });

  it("keeps graph traversal scoped to the requested project", async () => {
    const hits: SearchHit[] = [
      hit("docs/payment-playbook.md", "markdown", 1.2, "semantic", "Disconnected docs"),
      hit("src/services/billing.ts", "typescript", 0.3, "keyword", "Weak service match")
    ];
    const reranked = await rerankWithGraph(
      hits,
      { repoRoot: tempRoot, projectId: "project-a", query: "payment billing", mode: "feature" },
      "feature",
      {
        graphStore: graphStore(
          [
            symbol("project-a", "service-a", "createPaymentIntent", "src/services/billing.ts"),
            symbol("project-b", "route-b", "POST", "src/app/api/payments/route.ts"),
            symbol("project-b", "service-b", "createPaymentIntent", "src/services/billing.ts")
          ],
          [
            edge("project-b", "route-b", "service-b", "routes_to", {
              sourceFile: "src/app/api/payments/route.ts",
              targetFile: "src/services/billing.ts"
            })
          ]
        )
      }
    );

    expect(reranked[0]?.chunk.filePath).toBe("docs/payment-playbook.md");
    expect(reranked.every((candidate) => !candidate.reason.includes("graph rerank"))).toBe(true);
  });

  it("adds nearby implementation files that were missing from the original hits", async () => {
    const projectId = "project-a";
    const symbols = [
      symbol(projectId, "plugin", "resolvePluginConfig", "packages/vite/src/node/plugin.ts"),
      symbol(projectId, "build", "resolveBuildPlugins", "packages/vite/src/node/build.ts"),
      symbol(projectId, "container", "createPluginContainer", "packages/vite/src/node/server/pluginContainer.ts"),
      symbol(projectId, "legacy", "legacyPlugin", "packages/plugin-legacy/src/index.ts")
    ];
    const edges: GraphEdge[] = [
      edge(projectId, "plugin", "build", "imports", {
        sourceFile: "packages/vite/src/node/plugin.ts",
        targetFile: "packages/vite/src/node/build.ts"
      }),
      edge(projectId, "build", "container", "imports", {
        sourceFile: "packages/vite/src/node/build.ts",
        targetFile: "packages/vite/src/node/server/pluginContainer.ts"
      })
    ];
    const chunks = [
      codeChunk(projectId, "packages/vite/src/node/plugin.ts", "resolvePluginConfig", "export function resolvePluginConfig() { return null; }"),
      codeChunk(projectId, "packages/vite/src/node/build.ts", "build", "export async function build(config) { return config.plugins; }"),
      codeChunk(projectId, "packages/vite/src/node/server/pluginContainer.ts", "createPluginContainer", "export function createPluginContainer(config) { return config.plugins; }"),
      codeChunk(projectId, "packages/plugin-legacy/src/index.ts", "legacyPlugin", "export function legacyPlugin() { return null; }")
    ];
    const hits: SearchHit[] = [
      hit("packages/vite/src/node/plugin.ts", "typescript", 1.1, "keyword", "Matched plugin config owner"),
      hit("packages/plugin-legacy/src/index.ts", "typescript", 1.0, "semantic", "Matched legacy plugin")
    ];

    const reranked = await rerankWithGraph(hits, { repoRoot: tempRoot, projectId, query: "plugin config", mode: "feature" }, "feature", {
      graphStore: graphStore(symbols, edges, chunks),
      maxSeeds: 1
    });

    const buildHit = requireFileHit(reranked, "packages/vite/src/node/build.ts");
    const containerHit = requireFileHit(reranked, "packages/vite/src/node/server/pluginContainer.ts");

    expect(buildHit.source).toBe("graph");
    expect(containerHit.source).toBe("graph");
    expect(buildHit.reason).toContain("graph expansion");
    expect(containerHit.reason).toContain("graph expansion");
  });

  it("keeps enough owner-like expansion candidates for multi-file owner chains", async () => {
    const projectId = "project-a";
    const symbols = [
      symbol(projectId, "context", "Context", "src/context.ts"),
      symbol(projectId, "types", "ContextTypes", "src/types.ts"),
      symbol(projectId, "streaming", "ContextStreaming", "src/jsx/streaming.ts"),
      symbol(projectId, "cookie", "CookieHelpers", "src/helper/cookie/index.ts"),
      symbol(projectId, "renderer", "RequestContext", "src/middleware/jsx-renderer/index.ts"),
      symbol(projectId, "request", "HonoRequest", "src/request.ts")
    ];
    const edges: GraphEdge[] = symbols
      .filter((candidate) => candidate.id !== "context")
      .map((candidate) => edge(projectId, "context", candidate.id, "imports", {
        sourceFile: "src/context.ts",
        targetFile: candidate.filePath
      }));
    const chunks = [
      codeChunk(projectId, "src/context.ts", "Context", "export class Context {}"),
      codeChunk(projectId, "src/types.ts", "ContextTypes", "context request response helpers types"),
      codeChunk(projectId, "src/jsx/streaming.ts", "ContextStreaming", "context request response helpers streaming"),
      codeChunk(projectId, "src/helper/cookie/index.ts", "CookieHelpers", "context request response helpers cookie"),
      codeChunk(projectId, "src/middleware/jsx-renderer/index.ts", "RequestContext", "context request response helpers renderer"),
      codeChunk(projectId, "src/request.ts", "HonoRequest", "request response helper")
    ];
    const hits: SearchHit[] = [
      hit("src/context.ts", "typescript", 1.2, "keyword", "Matched context request response helpers")
    ];

    const reranked = await rerankWithGraph(hits, { repoRoot: tempRoot, projectId, query: "context request response helpers", mode: "explain", limit: 8 }, "explain", {
      graphStore: graphStore(symbols, edges, chunks),
      maxSeeds: 1
    });

    expect(requireFileHit(reranked, "src/request.ts").reason).toContain("graph expansion");
  });

  it("adds command owner files from path intent when semantic hits point at app noise", async () => {
    const projectId = "project-a";
    const symbols = [
      symbol(projectId, "app-action", "ActionMenu", "apps/v4/app/create/components/action-menu.tsx"),
      symbol(projectId, "resolver", "resolveRegistryTree", "packages/shadcn/src/registry/resolver.ts"),
      symbol(projectId, "add-command", "add", "packages/shadcn/src/commands/add.ts")
    ];
    const edges: GraphEdge[] = [
      edge(projectId, "app-action", "resolver", "imports", {
        sourceFile: "apps/v4/app/create/components/action-menu.tsx",
        targetFile: "packages/shadcn/src/registry/resolver.ts"
      })
    ];
    const chunks = [
      codeChunk(projectId, "apps/v4/app/create/components/action-menu.tsx", "ActionMenu", "add component registry resolver UI"),
      codeChunk(projectId, "packages/shadcn/src/registry/resolver.ts", "resolveRegistryTree", "registry resolver component dependencies"),
      codeChunk(projectId, "packages/shadcn/src/commands/add.ts", "add", "command add component registry")
    ];
    const hits: SearchHit[] = [
      hit("apps/v4/app/create/components/action-menu.tsx", "typescript", 1.2, "semantic", "add component command registry resolver")
    ];

    const reranked = await rerankWithGraph(hits, { repoRoot: tempRoot, projectId, query: "add component command registry resolver", mode: "feature", limit: 10 }, "feature", {
      graphStore: graphStore(symbols, edges, chunks),
      maxSeeds: 1
    });

    expect(requireFileHit(reranked, "packages/shadcn/src/commands/add.ts").reason).toContain("owner intent");
  });

  it("promotes compound core owner hits over adapter package noise", async () => {
    const projectId = "project-a";
    const symbols = [
      symbol(projectId, "react-use-query", "useQuery", "packages/react-query/src/useQuery.ts"),
      symbol(projectId, "vue-use-query", "useQuery", "packages/vue-query/src/useQuery.ts"),
      symbol(projectId, "solid-use-query", "useQuery", "packages/solid-query/src/useQuery.ts"),
      symbol(projectId, "observer", "QueryObserver", "packages/query-core/src/queryObserver.ts")
    ];
    const edges: GraphEdge[] = [
      edge(projectId, "react-use-query", "observer", "imports", {
        sourceFile: "packages/react-query/src/useQuery.ts",
        targetFile: "packages/query-core/src/queryObserver.ts"
      }),
      edge(projectId, "vue-use-query", "observer", "imports", {
        sourceFile: "packages/vue-query/src/useQuery.ts",
        targetFile: "packages/query-core/src/queryObserver.ts"
      }),
      edge(projectId, "solid-use-query", "observer", "imports", {
        sourceFile: "packages/solid-query/src/useQuery.ts",
        targetFile: "packages/query-core/src/queryObserver.ts"
      })
    ];
    const hits: SearchHit[] = [
      hit("packages/vue-query/src/useQuery.ts", "typescript", 6.0, "graph", "adapter useQuery"),
      hit("packages/react-query/src/useQuery.ts", "typescript", 5.9, "graph", "react adapter useQuery"),
      hit("packages/solid-query/src/useQuery.ts", "typescript", 5.8, "graph", "adapter useQuery"),
      hit("packages/query-core/src/queryObserver.ts", "typescript", 3.4, "keyword", "core query observer")
    ];

    const reranked = await rerankWithGraph(hits, { repoRoot: tempRoot, projectId, query: "useQuery react hook observer", mode: "explain", limit: 10 }, "explain", {
      graphStore: graphStore(symbols, edges),
      maxSeeds: 3
    });

    expect(indexOfFile(reranked, "packages/query-core/src/queryObserver.ts")).toBeLessThanOrEqual(3);
    expect(requireFileHit(reranked, "packages/query-core/src/queryObserver.ts").reason).toContain("owner intent rerank");
  });

  it("promotes exact collection operation owners over endpoint and version noise", async () => {
    const projectId = "project-a";
    const symbols = [
      symbol(projectId, "endpoint-find", "findHandler", "packages/payload/src/collections/endpoints/find.ts"),
      symbol(projectId, "version-find", "findVersionByIDOperation", "packages/payload/src/collections/operations/findVersionByID.ts"),
      symbol(projectId, "local-find", "findLocal", "packages/payload/src/collections/operations/local/find.ts"),
      symbol(projectId, "operation-find", "findOperation", "packages/payload/src/collections/operations/find.ts")
    ];
    const edges: GraphEdge[] = [
      edge(projectId, "endpoint-find", "operation-find", "imports", {
        sourceFile: "packages/payload/src/collections/endpoints/find.ts",
        targetFile: "packages/payload/src/collections/operations/find.ts"
      }),
      edge(projectId, "operation-find", "local-find", "imports", {
        sourceFile: "packages/payload/src/collections/operations/find.ts",
        targetFile: "packages/payload/src/collections/operations/local/find.ts"
      }),
      edge(projectId, "version-find", "operation-find", "imports", {
        sourceFile: "packages/payload/src/collections/operations/findVersionByID.ts",
        targetFile: "packages/payload/src/collections/operations/find.ts"
      })
    ];
    const hits: SearchHit[] = [
      hit("packages/payload/src/collections/endpoints/find.ts", "typescript", 5.4, "graph", "endpoint find handler"),
      hit("packages/payload/src/collections/operations/findVersionByID.ts", "typescript", 5.2, "graph", "version operation"),
      hit("packages/payload/src/collections/operations/local/find.ts", "typescript", 3.2, "keyword", "local collection find operation"),
      hit("packages/payload/src/collections/operations/find.ts", "typescript", 3.1, "keyword", "collection find operation")
    ];

    const reranked = await rerankWithGraph(hits, { repoRoot: tempRoot, projectId, query: "local collection find operation access pagination", mode: "debug", limit: 10 }, "debug", {
      graphStore: graphStore(symbols, edges),
      maxSeeds: 2
    });

    expect(indexOfFile(reranked, "packages/payload/src/collections/operations/local/find.ts")).toBeLessThanOrEqual(5);
    expect(indexOfFile(reranked, "packages/payload/src/collections/operations/find.ts")).toBeLessThanOrEqual(5);
    expect(indexOfFile(reranked, "packages/payload/src/collections/operations/find.ts")).toBeLessThan(indexOfFile(reranked, "packages/payload/src/collections/operations/findVersionByID.ts"));
    expect(requireFileHit(reranked, "packages/payload/src/collections/operations/local/find.ts").reason).toContain("owner intent rerank");
    expect(requireFileHit(reranked, "packages/payload/src/collections/operations/find.ts").reason).toContain("owner intent rerank");
  });

  it("reranks a payment-flow fixture toward real owners instead of isolated docs and mocks", async () => {
    await writePaymentFixture(tempRoot);
    const engine = new RagCodeEngine();
    await engine.indexRepo(tempRoot);

    const hits = await engine.searchCode({
      repoRoot: tempRoot,
      query: "payment checkout billing",
      mode: "feature",
      limit: 12
    });

    const docIndex = indexOfFile(hits, "docs/payment-playbook.md");
    const mockIndex = indexOfFile(hits, "src/mocks/payment-copy.json");
    expect(indexOfFile(hits, "src/services/billing.ts")).toBeLessThan(docIndex);
    expect(indexOfFile(hits, "src/app/api/payments/route.ts")).toBeLessThan(docIndex);
    expect(indexOfFile(hits, "src/app/checkout/CheckoutButton.tsx")).toBeLessThan(mockIndex);
    expect(hits.some((candidate) => candidate.reason.includes("graph rerank:"))).toBe(true);
  });

  it("promotes related tests in debug/review mode and demotes them in feature mode unless requested", async () => {
    await writePaymentFixture(tempRoot);
    const engine = new RagCodeEngine();
    await engine.indexRepo(tempRoot);

    const featureHits = await engine.searchCode({
      repoRoot: tempRoot,
      query: "payment billing",
      mode: "feature",
      limit: 12
    });
    const debugHits = await engine.searchCode({
      repoRoot: tempRoot,
      query: "payment billing",
      mode: "debug",
      limit: 12
    });

    const featureTest = requireFileHit(featureHits, "src/services/billing.test.ts");
    const debugTest = requireFileHit(debugHits, "src/services/billing.test.ts");

    expect(featureTest.reason).toContain("test default demotion");
    expect(debugTest.reason).toContain("test relevance boost");
    expect(debugTest.score).toBeGreaterThan(featureTest.score);
    expect(indexOfFile(featureHits, "src/services/billing.ts")).toBeLessThan(indexOfFile(featureHits, "src/services/billing.test.ts"));
  });
});

async function writePaymentFixture(root: string): Promise<void> {
  await fs.mkdir(path.join(root, "src", "app", "checkout"), { recursive: true });
  await fs.mkdir(path.join(root, "src", "app", "api", "payments"), { recursive: true });
  await fs.mkdir(path.join(root, "src", "services"), { recursive: true });
  await fs.mkdir(path.join(root, "src", "mocks"), { recursive: true });
  await fs.mkdir(path.join(root, "docs"), { recursive: true });

  await fs.writeFile(
    path.join(root, "src", "app", "checkout", "CheckoutButton.tsx"),
    [
      "\"use client\";",
      "",
      "export function CheckoutButton() {",
      "  async function onClick() {",
      "    await fetch('/api/payments', { method: 'POST' });",
      "  }",
      "  return <button onClick={onClick}>Checkout</button>;",
      "}"
    ].join("\n")
  );
  await fs.writeFile(
    path.join(root, "src", "app", "api", "payments", "route.ts"),
    [
      "import { createPaymentIntent } from '../../../services/billing';",
      "",
      "export async function POST() {",
      "  return createPaymentIntent();",
      "}"
    ].join("\n")
  );
  await fs.writeFile(
    path.join(root, "src", "services", "billing.ts"),
    [
      "export function createPaymentIntent() {",
      "  return { clientSecret: 'payment-intent-secret' };",
      "}"
    ].join("\n")
  );
  await fs.writeFile(
    path.join(root, "src", "services", "billing.test.ts"),
    [
      "import { expect, it } from 'vitest';",
      "import { createPaymentIntent } from './billing';",
      "",
      "it('creates a payment intent for billing', () => {",
      "  expect(createPaymentIntent().clientSecret).toContain('payment');",
      "});"
    ].join("\n")
  );
  await fs.writeFile(
    path.join(root, "docs", "payment-playbook.md"),
    "payment checkout billing ".repeat(80)
  );
  await fs.writeFile(
    path.join(root, "src", "mocks", "payment-copy.json"),
    JSON.stringify({ text: "payment checkout billing ".repeat(40) })
  );
}

function graphStore(symbols: SymbolNode[], edges: GraphEdge[], chunks: CodeChunk[] = []): GraphStore {
  return {
    getSymbols: async () => symbols,
    getEdges: async () => edges,
    getChunks: async () => chunks
  } as unknown as GraphStore;
}

function symbol(projectId: string, id: string, name: string, filePath: string): SymbolNode {
  return {
    id,
    projectId,
    filePath,
    name,
    kind: "function",
    language: "typescript",
    startLine: 1,
    endLine: 3
  };
}

function edge(projectId: string, sourceId: string, targetId: string, kind: EdgeKind, metadata: Record<string, unknown>): GraphEdge {
  return { projectId, sourceId, targetId, kind, metadata };
}

function codeChunk(projectId: string, filePath: string, symbolName: string, content: string): CodeChunk {
  return {
    id: `${filePath}::${symbolName}`,
    projectId,
    repoRoot: tempRoot,
    filePath,
    language: "typescript",
    kind: "function",
    symbolName,
    startLine: 1,
    endLine: 3,
    content,
    contentHash: "hash"
  };
}

function hit(filePath: string, language: CodeChunk["language"], score: number, source: SearchHit["source"], content: string): SearchHit {
  return {
    chunk: {
      id: `${filePath}::chunk`,
      projectId: "project-a",
      repoRoot: tempRoot,
      filePath,
      language,
      kind: "file",
      startLine: 1,
      endLine: 1,
      content,
      contentHash: "hash"
    },
    score,
    source,
    reason: `base ${source}`
  };
}

function indexOfFile(hits: SearchHit[], filePath: string): number {
  const index = hits.findIndex((hit) => hit.chunk.filePath === filePath);
  expect(index, `${filePath} was not returned`).toBeGreaterThanOrEqual(0);
  return index;
}

function requireFileHit(hits: SearchHit[], filePath: string): SearchHit {
  const hit = hits.find((candidate) => candidate.chunk.filePath === filePath);
  expect(hit, `${filePath} was not returned`).toBeDefined();
  return hit as SearchHit;
}
