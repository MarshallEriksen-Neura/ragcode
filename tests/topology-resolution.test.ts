import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RagCodeEngine } from "../src/index.js";

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ragcode-topology-"));
  await fs.mkdir(path.join(tempRoot, "src", "profile"), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, "src", "auth.ts"),
    [
      "import { refreshProfile as refresh } from './profile';",
      "",
      "export function loginUser(email: string) {",
      "  return refresh(email);",
      "}"
    ].join("\n")
  );
  await fs.writeFile(
    path.join(tempRoot, "src", "profile", "index.ts"),
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

describe("TypeScript import/export topology resolution", () => {
  it("resolves relative imports to target file symbols and imported calls to exported symbols", async () => {
    const engine = new RagCodeEngine();
    const index = await engine.indexRepo(tempRoot);
    const profileFile = index.symbols.find((symbol) => symbol.kind === "file" && symbol.filePath === "src/profile/index.ts");
    const refreshProfile = index.symbols.find((symbol) => symbol.name === "refreshProfile" && symbol.filePath === "src/profile/index.ts");

    const importEdge = index.edges.find((edge) => edge.kind === "imports" && edge.metadata?.sourceFile === "src/auth.ts");
    expect(importEdge).toMatchObject({
      targetId: profileFile?.id,
      metadata: {
        source: "./profile",
        targetFile: "src/profile/index.ts",
        resolution: "resolved"
      }
    });

    const callEdge = index.edges.find((edge) => edge.kind === "calls" && edge.metadata?.targetName === "refresh");
    expect(callEdge).toMatchObject({
      sourceId: index.symbols.find((symbol) => symbol.name === "loginUser")?.id,
      targetId: refreshProfile?.id,
      metadata: {
        importedName: "refreshProfile",
        targetFile: "src/profile/index.ts",
        resolution: "resolved"
      }
    });
  });

  it("uses resolved call edges in impact analysis and trace flow", async () => {
    const engine = new RagCodeEngine();
    await engine.indexRepo(tempRoot);

    const impact = await engine.impactAnalysis(tempRoot, "refreshProfile");
    expect(impact.impactedFiles).toEqual(expect.arrayContaining(["src/auth.ts", "src/profile/index.ts"]));
    expect(impact.incomingEdges.some((edge) => edge.metadata?.resolution === "resolved" && edge.metadata?.sourceFile === "src/auth.ts")).toBe(true);

    const flow = await engine.traceFlow(tempRoot, "loginUser");
    expect(flow.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: "src/auth.ts",
        symbolName: "loginUser",
        targetName: "refresh",
        targetFile: "src/profile/index.ts"
      })
    ]));
  });

  it("surfaces resolved topology target files in context packs", async () => {
    const engine = new RagCodeEngine();
    await engine.indexRepo(tempRoot);

    const pack = await engine.getContext({ repoRoot: tempRoot, query: "login refresh profile", budgetChars: 3000 });

    expect(pack.topology).toEqual(expect.arrayContaining([
      expect.objectContaining({
        from: "src/auth.ts",
        to: "refresh",
        targetFile: "src/profile/index.ts",
        confidence: "high"
      })
    ]));
  });
});
