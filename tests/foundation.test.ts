import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RagCodeEngine, callTool, listToolDefinitions } from "../src/index.js";

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ragcode-test-"));
  await fs.mkdir(path.join(tempRoot, "src"));
  await fs.writeFile(
    path.join(tempRoot, "src", "auth.ts"),
    [
      "import { refreshProfile } from './profile';",
      "",
      "export function loginUser(email: string) {",
      "  refreshProfile(email);",
      "  return createSession(email);",
      "}",
      "",
      "function createSession(email: string) {",
      "  return { email, authenticated: true };",
      "}"
    ].join("\n")
  );
  await fs.writeFile(
    path.join(tempRoot, "src", "auth.test.ts"),
    [
      "import { loginUser } from './auth';",
      "",
      "test('loginUser creates a session', () => {",
      "  expect(loginUser('a@example.com').authenticated).toBe(true);",
      "});"
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
  await fs.writeFile(path.join(tempRoot, ".env"), "SECRET_TOKEN=do-not-index\n");
  await fs.mkdir(path.join(tempRoot, ".venv", "Lib", "site-packages"), { recursive: true });
  await fs.writeFile(path.join(tempRoot, ".venv", "Lib", "site-packages", "vendor.py"), "def vendor_only():\n    return 1\n");
  await fs.mkdir(path.join(tempRoot, "out", "_next", "static", "chunks"), { recursive: true });
  await fs.writeFile(path.join(tempRoot, "out", "_next", "static", "chunks", "app.js"), "let t=1;let t=2;\n");
  await fs.mkdir(path.join(tempRoot, "src", "generated"), { recursive: true });
  await fs.writeFile(path.join(tempRoot, "src", "generated", "client.generated.ts"), "export const generatedClient = true;\n");
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe("RagCode foundation", () => {
  it("indexes files and searches over keyword plus semantic stores", async () => {
    const engine = new RagCodeEngine();
    const index = await engine.indexRepo(tempRoot);

    expect(index.files.map((file) => file.path)).toEqual(["src/auth.test.ts", "src/auth.ts", "src/profile.ts"]);
    expect(index.files.every((file) => file.projectId === index.projectId)).toBe(true);
    expect(index.files.find((file) => file.path === "src/auth.test.ts")?.classification?.role).toBe("test");
    expect(index.skippedFiles).toEqual(expect.arrayContaining([expect.objectContaining({ filePath: ".env", reason: "sensitive file policy" })]));
    expect(index.skippedFiles).toEqual(expect.arrayContaining([expect.objectContaining({ filePath: ".venv", reason: "ignored directory: .venv", classification: expect.objectContaining({ role: "vendor" }) })]));
    expect(index.skippedFiles).toEqual(expect.arrayContaining([expect.objectContaining({ filePath: "out", reason: "ignored directory: out", classification: expect.objectContaining({ role: "build" }) })]));
    expect(index.skippedFiles).toEqual(expect.arrayContaining([expect.objectContaining({ filePath: "src/generated", reason: "ignored directory: generated", classification: expect.objectContaining({ role: "generated" }) })]));
    expect(index.chunks.length).toBeGreaterThan(0);
    expect(index.symbols.some((symbol) => symbol.name === "loginUser" && symbol.kind === "function")).toBe(true);
    expect(index.edges.some((edge) => edge.kind === "imports")).toBe(true);
    expect(index.edges.some((edge) => edge.kind === "calls" && edge.metadata?.targetName === "refreshProfile")).toBe(true);

    const hits = await engine.searchCode({ repoRoot: tempRoot, query: "login session", limit: 3 });
    expect(hits[0]?.chunk.filePath).toBe("src/auth.ts");
    expect(hits[0]?.reason).toContain("Matched");
  });

  it("emits truthful index progress phases", async () => {
    const engine = new RagCodeEngine();
    const phases: string[] = [];

    await engine.indexRepo(tempRoot, {
      onProgress: (event) => phases.push(event.phase)
    });

    expect(phases).toEqual(expect.arrayContaining([
      "loading_existing_index",
      "scanning_inventory",
      "analyzing",
      "writing_graph",
      "writing_semantic",
      "complete"
    ]));
    expect(phases.at(-1)).toBe("complete");
  });

  it("builds budgeted context packs with file and line evidence", async () => {
    const engine = new RagCodeEngine();
    await engine.indexRepo(tempRoot);

    const pack = await engine.getContext({ repoRoot: tempRoot, query: "refresh profile route", mode: "feature", budgetChars: 2000 });

    expect(pack.snippets.length).toBeGreaterThan(0);
    expect(pack.mode).toBe("feature");
    expect(pack.answerable).toBe(true);
    expect(pack.projectId).toBeTruthy();
    expect(pack.brief).toContain("feature context");
    expect(pack.freshness.projectId).toBe(pack.projectId);
    expect(pack.freshness.skippedFiles).toEqual(expect.arrayContaining([expect.objectContaining({ filePath: ".env" })]));
    expect(pack.ownerChain.map((owner) => owner.filePath)).toContain("src/profile.ts");
    expect(pack.ownerChain.flatMap((owner) => owner.symbols.map((symbol) => symbol.name))).toContain("refreshProfile");
    expect(pack.snippets[0]?.filePath).toBe("src/profile.ts");
    expect(pack.snippets[0]?.expansionLevel).toBe("focused_body");
    expect(pack.topology.some((edge) => edge.to === "refreshProfile")).toBe(true);
    const topologyKeys = pack.topology.map((edge) => [edge.from, edge.to, edge.edge, edge.sourceFile ?? "", edge.targetFile ?? ""].join("\0"));
    expect(new Set(topologyKeys).size).toBe(topologyKeys.length);
    expect(pack.usedChars).toBeLessThanOrEqual(pack.budgetChars);
  });

  it("auto-scopes retrieval to the active workspace and keeps projects isolated", async () => {
    const otherRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ragcode-other-"));
    try {
      await fs.mkdir(path.join(otherRoot, "src"));
      await fs.writeFile(
        path.join(otherRoot, "src", "auth.ts"),
        [
          "export function loginUser() {",
          "  return 'other-project-only';",
          "}"
        ].join("\n")
      );

      const engine = new RagCodeEngine();
      const first = await engine.indexRepo(tempRoot);
      const second = await engine.indexRepo(otherRoot);
      expect(first.projectId).not.toBe(second.projectId);

      const firstHits = await engine.searchCode({ repoRoot: tempRoot, query: "other-project-only", limit: 5 });
      expect(firstHits.every((hit) => hit.chunk.projectId === first.projectId)).toBe(true);
      expect(firstHits.some((hit) => hit.chunk.projectId === second.projectId)).toBe(false);

      const secondHits = await engine.searchCode({ workspace: { root: otherRoot }, query: "other-project-only", limit: 5 });
      expect(secondHits[0]?.chunk.projectId).toBe(second.projectId);
      expect(secondHits[0]?.chunk.filePath).toBe("src/auth.ts");

      const activePack = await engine.getContext({ query: "other-project-only", budgetChars: 2000 });
      expect(activePack.projectId).toBe(second.projectId);
      expect(activePack.ownerChain.map((owner) => owner.filePath)).toContain("src/auth.ts");
    } finally {
      await fs.rm(otherRoot, { recursive: true, force: true });
    }
  });

  it("supports owner, impact, related-test, trace, and diff-review queries", async () => {
    const engine = new RagCodeEngine();
    await engine.indexRepo(tempRoot);

    const owners = await engine.findOwner(tempRoot, "login user session");
    expect(owners[0]?.filePath).toBe("src/auth.ts");

    const impact = await engine.impactAnalysis(tempRoot, "refreshProfile");
    expect(impact.impactedFiles).toContain("src/auth.ts");

    const related = await engine.relatedTests(tempRoot, "src/auth.ts");
    expect(related.tests.map((file) => file.path)).toContain("src/auth.test.ts");

    const flow = await engine.traceFlow(tempRoot, "loginUser");
    expect(flow.steps.some((step) => step.targetName === "refreshProfile")).toBe(true);

    const review = await engine.reviewDiff(tempRoot, undefined, ["src/auth.ts"]);
    expect(review.relatedTests).toContain("src/auth.test.ts");
  });

  it("exposes MCP tool handlers through the engine boundary", async () => {
    const engine = new RagCodeEngine();
    const tools = listToolDefinitions().map((tool) => tool.name);

    expect(tools).toEqual([
      "index_repo",
      "refresh_index",
      "index_status",
      "watch_status",
      "record_file_events",
      "search_code",
      "get_context",
      "topology_map",
      "find_symbol",
      "explain_file",
      "expand_node",
      "find_owner",
      "find_reuse_candidates",
      "impact_analysis",
      "explain_impact",
      "related_tests",
      "trace_flow",
      "trace_request_flow",
      "review_diff"
    ]);

    const indexResult = await callTool(engine, "index_repo", { repoRoot: tempRoot });
    expect(indexResult).toHaveProperty("files");

    const contextResult = await callTool(engine, "get_context", { query: "login" });
    expect(contextResult).toHaveProperty("snippets");

    const ownerResult = await callTool(engine, "find_owner", { query: "login" });
    expect(ownerResult).toEqual(expect.arrayContaining([expect.objectContaining({ filePath: "src/auth.ts" })]));
  });
});
