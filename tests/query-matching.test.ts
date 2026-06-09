import { describe, expect, it } from "vitest";
import type { CodeChunk, SymbolNode } from "../src/core/types.js";
import { buildQueryMatchProfile, scoreChunkText, scoreSymbolText } from "../src/retrieval/query-matching.js";

describe("query matching", () => {
  it("uses Snowball stemming without hand-written plural guesses", () => {
    const profile = buildQueryMatchProfile("classes users class status", []);

    expect(profile.queryTermVariants).toEqual(expect.arrayContaining(["classes", "class", "users", "user", "status"]));
    expect(profile.queryTermVariants).not.toContain("classs");
    expect(profile.queryTermVariants).not.toContain("statu");
  });

  it("matches inflected query terms against symbol and chunk text", () => {
    const symbol = symbolNode("src/users.ts", "resolveUserClasses");
    const profile = buildQueryMatchProfile("classes users", [symbol]);

    expect(profile.expandedSymbolNames).toEqual(["resolveUserClasses"]);
    expect(scoreSymbolText(symbol, profile)?.matchedSymbolName).toBe("resolveUserClasses");
    expect(scoreChunkText(codeChunk("src/users.ts", "function resolveUserClass() {}"), profile)).toBeDefined();
  });

  it("does not match query terms inside larger path tokens", () => {
    const profile = buildQueryMatchProfile("react query hook", []);

    expect(scoreChunkText(codeChunk("packages/react-query/src/useQuery.ts", "export function useQuery() {}"), profile)?.matchedQueryTerms).toBe(2);
    expect(scoreChunkText(codeChunk("packages/preact-query/src/useQuery.ts", "export function useQuery() {}"), profile)?.matchedQueryTerms).toBe(1);
  });
});

function symbolNode(filePath: string, name: string): SymbolNode {
  return {
    projectId: "project",
    id: `${filePath}:${name}`,
    filePath,
    name,
    kind: "function",
    language: "typescript",
    startLine: 1,
    endLine: 1
  };
}

function codeChunk(filePath: string, content: string): CodeChunk {
  return {
    projectId: "project",
    id: filePath,
    repoRoot: "/repo",
    filePath,
    language: "typescript",
    kind: "function",
    startLine: 1,
    endLine: 1,
    content,
    contentHash: "hash"
  };
}
