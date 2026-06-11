import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDoctor } from "../src/index.js";

const tempRoots: string[] = [];

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe("doctor", () => {
  it("checks dependencies and runs an optional repo smoke", async () => {
    const repoRoot = await tempDir("ragcode-doctor-repo-");
    await fs.mkdir(path.join(repoRoot, "src"), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, "src", "doctor.ts"),
      [
        "export function doctorSmoke() {",
        "  return 'doctor-smoke-marker';",
        "}"
      ].join("\n")
    );

    const report = await runDoctor({
      cwd: repoRoot,
      env: {
        RAGCODE_GRAPH_STORE: "memory",
        RAGCODE_SEMANTIC_STORE: "memory",
        RAGCODE_EMBEDDING_PROVIDER: "deterministic"
      },
      repoRoot,
      searchQuery: "doctor-smoke-marker"
    });

    expect(report.ok).toBe(true);
    expect(report.dependencies.sqlite.ok).toBe(true);
    expect(report.dependencies.lancedb.ok).toBe(true);
    expect(report.dependencies.mcpSdk.ok).toBe(true);
    expect(report.mcp.toolCount).toBeGreaterThan(0);
    expect(report.smoke?.indexed?.files).toBe(1);
    expect(report.smoke?.search?.hits[0]?.filePath).toBe("src/doctor.ts");
  }, 20_000);

  it("reports invalid runtime env instead of throwing", async () => {
    const report = await runDoctor({
      env: {
        RAGCODE_GRAPH_STORE: "bad-store"
      }
    });

    expect(report.ok).toBe(false);
    expect(report.runtime.graph.ok).toBe(false);
    expect(report.runtime.graph.message).toContain("Invalid runtime config field graphStore");
  });
});

async function tempDir(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}
