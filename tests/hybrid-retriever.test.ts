import { describe, expect, it } from "vitest";
import type { EmbeddingProvider, GraphStore, SearchHit, SemanticStore } from "../src/index.js";
import { HybridRetriever, fuseHits } from "../src/index.js";

describe("hybrid retrieval fusion", () => {
  it("normalizes each source before fusion instead of adding raw keyword and semantic scores", () => {
    const fused = fuseHits(
      [
        hit("src/raw-keyword-top.ts", 12_000, "keyword"),
        hit("src/raw-keyword-second.ts", 8_000, "keyword")
      ],
      [
        hit("src/semantic-owner.ts", 0.92, "semantic")
      ]
    );

    expect(indexOfFile(fused, "src/semantic-owner.ts")).toBeLessThan(indexOfFile(fused, "src/raw-keyword-second.ts"));
    expect(fused.every((item) => item.scoreBreakdown?.final === item.score)).toBe(true);
    expect(fused.find((item) => item.chunk.filePath === "src/semantic-owner.ts")?.reason).toContain("rank fusion semantic rank 1");
  });

  it("reports semantic search failures without dropping keyword fallback results", async () => {
    const retriever = new HybridRetriever({
      graphStore: graphStore([hit("src/owner.ts", 1, "keyword")]),
      semanticStore: failingSemanticStore(),
      embeddingProvider: embeddingProvider()
    });

    const result = await retriever.searchWithDiagnostics({ repoRoot: "repo", projectId: "project-a", query: "owner", limit: 5 });

    expect(result.hits.map((item) => item.chunk.filePath)).toEqual(["src/owner.ts"]);
    expect(result.diagnostics.semantic.status).toBe("failed");
    expect(result.diagnostics.semantic.error).toContain("semantic backend unavailable");
  });
});

function graphStore(hits: SearchHit[]): GraphStore {
  return {
    searchText: async () => hits,
    getSymbols: async () => [],
    getEdges: async () => []
  } as unknown as GraphStore;
}

function failingSemanticStore(): SemanticStore {
  return {
    search: async () => {
      throw new Error("semantic backend unavailable");
    }
  } as unknown as SemanticStore;
}

function embeddingProvider(): EmbeddingProvider {
  return {
    embed: async () => [1]
  };
}

function hit(filePath: string, score: number, source: SearchHit["source"]): SearchHit {
  return {
    chunk: {
      id: `${filePath}::chunk`,
      projectId: "project-a",
      repoRoot: "repo",
      filePath,
      language: "typescript",
      kind: "function",
      symbolName: filePath.split("/").pop()?.replace(/\.[^.]+$/, ""),
      startLine: 1,
      endLine: 3,
      content: "export function owner() { return true; }",
      contentHash: "hash"
    },
    score,
    source,
    reason: `base ${source}`
  };
}

function indexOfFile(hits: SearchHit[], filePath: string): number {
  const index = hits.findIndex((item) => item.chunk.filePath === filePath);
  expect(index, `${filePath} was not returned`).toBeGreaterThanOrEqual(0);
  return index;
}
