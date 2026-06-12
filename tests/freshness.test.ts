import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RagCodeEngine } from "../src/index.js";

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ragcode-freshness-"));
  await fs.mkdir(path.join(tempRoot, "src"));
  await fs.writeFile(
    path.join(tempRoot, "src", "auth.ts"),
    [
      "export function loginUser(email: string) {",
      "  return { email, authenticated: true, marker: 'indexed-login-marker' };",
      "}"
    ].join("\n")
  );
  await fs.writeFile(
    path.join(tempRoot, "src", "obsolete.ts"),
    [
      "export function obsoletePaymentCache() {",
      "  return 'obsolete-payment-cache-marker';",
      "}"
    ].join("\n")
  );
  await fs.writeFile(path.join(tempRoot, ".env"), "SECRET_TOKEN=do-not-index\n");
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe("freshness-aware retrieval", () => {
  it("reports changed files as stale and pending, and suppresses stale cache hits", async () => {
    const engine = new RagCodeEngine();
    await engine.indexRepo(tempRoot);

    await fs.writeFile(
      path.join(tempRoot, "src", "auth.ts"),
      [
        "export function logoutUser(email: string) {",
        "  return { email, authenticated: false, marker: 'changed-logout-marker' };",
        "}"
      ].join("\n")
    );

    const hits = await engine.searchCode({ repoRoot: tempRoot, query: "indexed-login-marker", limit: 10 });
    expect(hits.map((hit) => hit.chunk.filePath)).not.toContain("src/auth.ts");

    const pack = await engine.getContext({ repoRoot: tempRoot, query: "indexed-login-marker", budgetChars: 2000 });
    expect(pack.freshness.staleFiles).toContain("src/auth.ts");
    expect(pack.freshness.pendingFiles).toContain("src/auth.ts");
    expect(pack.snippets.map((snippet) => snippet.filePath)).not.toContain("src/auth.ts");
    expect(pack.missingEvidence).toEqual(expect.arrayContaining([expect.stringContaining("Stale indexed files excluded")]));
    expect(pack.missingEvidence).toEqual(expect.arrayContaining([expect.stringContaining("Pending files need indexing")]));
  });

  it("reports deleted files as stale and removes their cached chunks from results", async () => {
    const engine = new RagCodeEngine();
    await engine.indexRepo(tempRoot);

    await fs.rm(path.join(tempRoot, "src", "obsolete.ts"));

    const hits = await engine.searchCode({ repoRoot: tempRoot, query: "obsolete-payment-cache-marker", limit: 10 });
    expect(hits.map((hit) => hit.chunk.filePath)).not.toContain("src/obsolete.ts");

    const pack = await engine.getContext({ repoRoot: tempRoot, query: "obsolete-payment-cache-marker", budgetChars: 2000 });
    expect(pack.freshness.staleFiles).toContain("src/obsolete.ts");
    expect(pack.freshness.pendingFiles).not.toContain("src/obsolete.ts");
    expect(pack.snippets.map((snippet) => snippet.filePath)).not.toContain("src/obsolete.ts");
    expect(pack.missingEvidence).toEqual(expect.arrayContaining([expect.stringContaining("Stale indexed files excluded")]));
  });

  it("reports new indexable files as pending evidence gaps", async () => {
    const engine = new RagCodeEngine();
    await engine.indexRepo(tempRoot);

    await fs.writeFile(
      path.join(tempRoot, "src", "new-feature.ts"),
      [
        "export function newPendingFlow() {",
        "  return 'new-pending-flow-marker';",
        "}"
      ].join("\n")
    );

    const pack = await engine.getContext({ repoRoot: tempRoot, query: "new-pending-flow-marker", budgetChars: 2000 });
    expect(pack.freshness.pendingFiles).toContain("src/new-feature.ts");
    expect(pack.freshness.staleFiles).not.toContain("src/new-feature.ts");
    expect(pack.snippets.map((snippet) => snippet.filePath)).not.toContain("src/new-feature.ts");
    expect(pack.missingEvidence).toEqual(expect.arrayContaining([expect.stringContaining("Pending files need indexing")]));
  });

  it("keeps ignored sensitive files in skipped freshness metadata", async () => {
    const engine = new RagCodeEngine();
    await engine.indexRepo(tempRoot);

    await fs.writeFile(path.join(tempRoot, ".env"), "SECRET_TOKEN=changed-but-still-skipped\n");

    const pack = await engine.getContext({ repoRoot: tempRoot, query: "SECRET_TOKEN", budgetChars: 2000 });
    expect(pack.freshness.skippedFiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ filePath: ".env", reason: "sensitive file policy" })
    ]));
    expect(pack.freshness.pendingFiles).not.toContain(".env");
    expect(pack.freshness.staleFiles).not.toContain(".env");
    expect(pack.snippets.map((snippet) => snippet.filePath)).not.toContain(".env");
  });
});
