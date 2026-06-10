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
  await fs.writeFile(
    path.join(tempRoot, "src", "lib", "token-parts.ts"),
    [
      "export function normalizeSubject(value: string) {",
      "  return value.trim().toLowerCase();",
      "}",
      "",
      "export function buildToken(subject: string, ttl: number) {",
      "  return `${subject}:${ttl}`;",
      "}"
    ].join("\n")
  );
  await fs.writeFile(
    path.join(tempRoot, "src", "lib", "token-store.ts"),
    [
      "import { buildToken, normalizeSubject } from './token-parts';",
      "",
      "export function issueKey(subject: string, ttl = 60) {",
      "  const normalized = normalizeSubject(subject);",
      "  return buildToken(normalized, ttl);",
      "}",
      "",
      "export function unrelatedCounter(items: string[]) {",
      "  return items.length;",
      "}"
    ].join("\n")
  );
  await fs.writeFile(
    path.join(tempRoot, "src", "lib", "session-cache.ts"),
    [
      "import { buildToken, normalizeSubject } from './token-parts';",
      "",
      "export function createSessionKey(userId: string, ttl = 60) {",
      "  const cleaned = normalizeSubject(userId);",
      "  return buildToken(cleaned, ttl);",
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
    expect(report.reuseGuard.status).toBe("review_required");
    expect(report.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: "src/lib/traffic-control.ts",
        symbolName: "tokenBucket",
        kind: "helper",
        exported: true,
        confidence: "high",
        structuralSignals: expect.objectContaining({
          bodyDuplicateCount: 0
        })
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

  it("uses normalized body fingerprints plus signature and overlap signals for same-body different-name duplicates", async () => {
    const engine = new RagCodeEngine();
    await engine.indexRepo(tempRoot);

    const report = await engine.findReuseCandidates({
      repoRoot: tempRoot,
      query: "add session token key helper",
      limit: 8,
      reuseGuard: true
    });

    expect(report.duplicateRisk).toBe("high");
    expect(report.reuseGuard).toEqual(expect.objectContaining({
      status: "block_new",
      candidates: expect.arrayContaining([
        expect.objectContaining({ filePath: "src/lib/session-cache.ts", symbolName: "createSessionKey" }),
        expect.objectContaining({ filePath: "src/lib/token-store.ts", symbolName: "issueKey" })
      ])
    }));
    expect(report.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: "src/lib/session-cache.ts",
        symbolName: "createSessionKey",
        structuralSignals: expect.objectContaining({
          bodyDuplicateCount: 1,
          signatureSimilarity: expect.any(Number),
          importOverlap: 1,
          calleeOverlap: 1
        }),
        whyReuse: expect.arrayContaining([expect.stringContaining("Normalized body fingerprint")])
      }),
      expect.objectContaining({
        filePath: "src/lib/token-store.ts",
        symbolName: "issueKey",
        structuralSignals: expect.objectContaining({
          bodyDuplicateCount: 1,
          importOverlap: 1,
          calleeOverlap: 1
        })
      })
    ]));
  });

  it("does not raise body duplicate risk for different implementations in the same file", async () => {
    const engine = new RagCodeEngine();
    await engine.indexRepo(tempRoot);

    const report = await engine.findReuseCandidates({
      repoRoot: tempRoot,
      query: "count unrelated token store items",
      limit: 5,
      reuseGuard: true
    });
    const counter = report.candidates.find((candidate) => candidate.symbolName === "unrelatedCounter");

    expect(counter).toEqual(expect.objectContaining({
      structuralSignals: expect.objectContaining({
        bodyDuplicateCount: 0
      })
    }));
    expect(report.reuseGuard.candidates).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ symbolName: "unrelatedCounter" })
    ]));
  });

  it("does not flag same-shaped functions with different callees as body duplicates", async () => {
    await fs.writeFile(
      path.join(tempRoot, "src", "lib", "user-actions.ts"),
      [
        "export function activateUser(id: string) {",
        "  return registry.enable(id);",
        "}",
        "",
        "export function archiveUser(id: string) {",
        "  return registry.remove(id);",
        "}"
      ].join("\n")
    );

    const engine = new RagCodeEngine();
    await engine.indexRepo(tempRoot);

    const report = await engine.findReuseCandidates({
      repoRoot: tempRoot,
      query: "activate archive user account",
      limit: 8,
      reuseGuard: true
    });
    const activate = report.candidates.find((candidate) => candidate.symbolName === "activateUser");
    const archive = report.candidates.find((candidate) => candidate.symbolName === "archiveUser");

    // Same AST shape, different callees (enable vs remove): a shared fingerprint alone must
    // not raise duplicate risk, or reuseGuard would wrongly block legitimate new code.
    expect(activate).toBeDefined();
    expect(archive).toBeDefined();
    expect(activate?.structuralSignals.bodyDuplicateCount).toBe(0);
    expect(archive?.structuralSignals.bodyDuplicateCount).toBe(0);
    expect(report.reuseGuard.candidates).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ symbolName: "activateUser" })
    ]));
  });
});
