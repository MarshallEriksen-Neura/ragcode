import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RagCodeEngine } from "../src/index.js";

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ragcode-reuse-"));
  await fs.mkdir(path.join(tempRoot, "src", "lib"), { recursive: true });
  await fs.mkdir(path.join(tempRoot, "src", "middleware"), { recursive: true });

  await fs.writeFile(
    path.join(tempRoot, "src", "lib", "traffic-control.ts"),
    [
      "export function tokenBucket(key: string, capacity = 10) {",
      "  return { key, capacity, remaining: capacity };",
      "}",
      "",
      "export function throttleRequests(key: string) {",
      "  return tokenBucket(key, 20).remaining > 0;",
      "}"
    ].join("\n")
  );
  await fs.writeFile(
    path.join(tempRoot, "src", "middleware", "auth.ts"),
    [
      "export function requireSession() {",
      "  return true;",
      "}"
    ].join("\n")
  );
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe("reuse candidate detection", () => {
  it("surfaces existing implementations across a naming gap before recommending new code", async () => {
    const engine = new RagCodeEngine();
    await engine.indexRepo(tempRoot);

    const report = await engine.findReuseCandidates({
      repoRoot: tempRoot,
      query: "add rate limiting middleware",
      limit: 5
    });

    expect(report.decision).toBe("reuse");
    expect(report.duplicateRisk).toBe("high");
    expect(report.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: "src/lib/traffic-control.ts",
        symbolName: "tokenBucket",
        kind: "helper",
        exported: true,
        confidence: "high"
      }),
      expect.objectContaining({
        filePath: "src/lib/traffic-control.ts",
        symbolName: "throttleRequests",
        exported: true
      })
    ]));
    expect(report.nextQueries).toEqual(expect.arrayContaining([
      "expand_node src/lib/traffic-control.ts:tokenBucket"
    ]));
  });
});
