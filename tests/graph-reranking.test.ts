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

function graphStore(symbols: SymbolNode[], edges: GraphEdge[]): GraphStore {
  return {
    getSymbols: async () => symbols,
    getEdges: async () => edges
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
