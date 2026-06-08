import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CodeFile, GraphEdge, SymbolNode } from "../src/index.js";
import { RagCodeEngine } from "../src/index.js";
import { resolveCallDefinitionsWithTypeScript } from "../src/lsp/definition-resolver.js";

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ragcode-lsp-"));
  await fs.mkdir(path.join(tempRoot, "src"), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, "src", "auth.ts"),
    [
      "import * as profile from './profile';",
      "",
      "export function loginUser(email: string) {",
      "  return profile.refreshProfile(email);",
      "}",
      "",
      "export function unresolvedGateway() {",
      "  return missingPaymentGateway();",
      "}"
    ].join("\n")
  );
  await fs.writeFile(
    path.join(tempRoot, "src", "profile.ts"),
    [
      "export function refreshProfile(userId: string) {",
      "  return `/profiles/${userId}`;",
      "}"
    ].join("\n")
  );
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe("TypeScript Language Service bridge", () => {
  it("resolves namespace import property calls that AST import binding cannot resolve", async () => {
    const engine = new RagCodeEngine();
    const index = await engine.indexRepo(tempRoot);
    const refreshProfile = index.symbols.find((symbol) => symbol.name === "refreshProfile" && symbol.filePath === "src/profile.ts");

    const callEdge = index.edges.find((edge) => edge.kind === "calls" && edge.metadata?.targetName === "refreshProfile");

    expect(callEdge).toMatchObject({
      targetId: refreshProfile?.id,
      metadata: {
        targetFile: "src/profile.ts",
        targetSymbol: "refreshProfile",
        resolution: "resolved_lsp"
      }
    });
  });

  it("uses LSP-resolved edges in impact analysis and trace flow", async () => {
    const engine = new RagCodeEngine();
    await engine.indexRepo(tempRoot);

    const impact = await engine.impactAnalysis(tempRoot, "refreshProfile");
    expect(impact.impactedFiles).toEqual(expect.arrayContaining(["src/auth.ts", "src/profile.ts"]));
    expect(impact.incomingEdges.some((edge) => edge.metadata?.resolution === "resolved_lsp" && edge.metadata?.sourceFile === "src/auth.ts")).toBe(true);

    const flow = await engine.traceFlow(tempRoot, "loginUser");
    expect(flow.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: "src/auth.ts",
        symbolName: "loginUser",
        targetName: "refreshProfile",
        targetFile: "src/profile.ts"
      })
    ]));
  });

  it("keeps unresolved calls explicit instead of guessing", async () => {
    const engine = new RagCodeEngine();
    const index = await engine.indexRepo(tempRoot);

    const unresolved = index.edges.find((edge) => edge.kind === "calls" && edge.metadata?.targetName === "missingPaymentGateway");

    expect(unresolved).toMatchObject({
      metadata: {
        targetName: "missingPaymentGateway",
        sourceFile: "src/auth.ts",
        resolution: "unresolved"
      }
    });
  });

  it("degrades to the input AST graph if the language service cannot start", () => {
    const file: CodeFile = {
      projectId: "project-a",
      path: "src/auth.ts",
      absolutePath: path.join(tempRoot, "src", "auth.ts"),
      language: "typescript",
      sizeBytes: 1,
      contentHash: "hash",
      modifiedAtMs: 1
    };
    const symbol: SymbolNode = {
      id: "symbol-login",
      projectId: "project-a",
      filePath: "src/auth.ts",
      name: "loginUser",
      kind: "function",
      language: "typescript",
      startLine: 1,
      endLine: 1
    };
    const edge: GraphEdge = {
      projectId: "project-a",
      sourceId: "symbol-login",
      targetId: "weak-target",
      kind: "calls",
      metadata: { sourceFile: "src/auth.ts", targetName: "unknownCall", position: 0, resolution: "unresolved" }
    };

    const result = resolveCallDefinitionsWithTypeScript("bad-root", [{ filePath: file.path, absolutePath: file.absolutePath, content: "loginUser();" }], [symbol], [edge], {
      createService: () => {
        throw new Error("language service failed");
      }
    });

    expect(result).toEqual([edge]);
  });
});
