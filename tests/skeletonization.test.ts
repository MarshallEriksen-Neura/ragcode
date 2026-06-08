import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RagCodeEngine } from "../src/index.js";

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ragcode-skeleton-"));
  await fs.mkdir(path.join(tempRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(tempRoot, "src", "large-payment.ts"), largePaymentSource());
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe("context skeletonization", () => {
  it("returns skeletons for large implementation chunks by default", async () => {
    const engine = new RagCodeEngine();
    await engine.indexRepo(tempRoot);

    const pack = await engine.getContext({ repoRoot: tempRoot, query: "payment controller architecture", mode: "feature", budgetChars: 4000 });
    const snippet = pack.snippets.find((item) => item.filePath === "src/large-payment.ts");

    expect(snippet).toBeTruthy();
    expect(snippet?.expansionLevel).toBe("skeleton");
    expect(snippet?.content).toContain("export function largePaymentPipeline");
    expect(snippet?.content).toContain("{ ... }");
    expect(snippet?.content).not.toContain("TARGET_RECONCILIATION_MARKER");
    expect(snippet?.originalLineCount).toBeGreaterThan(100);
    expect(snippet?.returnedLineCount).toBeLessThan(10);
    expect(snippet?.elidedLineCount).toBe((snippet?.originalLineCount ?? 0) - (snippet?.returnedLineCount ?? 0));
  });

  it("returns a focused body window for precise large-chunk matches", async () => {
    const engine = new RagCodeEngine();
    await engine.indexRepo(tempRoot);

    const pack = await engine.getContext({ repoRoot: tempRoot, query: "TARGET_RECONCILIATION_MARKER largePaymentPipeline", mode: "debug", budgetChars: 5000 });
    const snippet = pack.snippets.find((item) => item.filePath === "src/large-payment.ts");

    expect(snippet).toBeTruthy();
    expect(snippet?.expansionLevel).toBe("focused_body");
    expect(snippet?.content).toContain("TARGET_RECONCILIATION_MARKER");
    expect(snippet?.content).toContain("...");
    expect(snippet?.originalLineCount).toBeGreaterThan(100);
    expect(snippet?.returnedLineCount).toBeLessThan(snippet?.originalLineCount ?? 0);
    expect(snippet?.elidedLineCount).toBeGreaterThan(0);
  });

  it("preserves existing small-chunk focused body behavior", async () => {
    await fs.writeFile(
      path.join(tempRoot, "src", "small.ts"),
      [
        "export function smallOwner() {",
        "  return 'small-owner-marker';",
        "}"
      ].join("\n")
    );
    const engine = new RagCodeEngine();
    await engine.indexRepo(tempRoot);

    const pack = await engine.getContext({ repoRoot: tempRoot, query: "small-owner-marker", budgetChars: 2000 });
    const snippet = pack.snippets.find((item) => item.filePath === "src/small.ts");

    expect(snippet?.expansionLevel).toBe("focused_body");
    expect(snippet?.content).toContain("small-owner-marker");
    expect(snippet?.elidedLineCount).toBe(0);
  });
});

function largePaymentSource(): string {
  const lines = [
    "export function largePaymentPipeline(input: { amount: number }) {",
    "  const events: string[] = [];",
    "  events.push('payment controller start');"
  ];
  for (let index = 0; index < 140; index += 1) {
    lines.push(`  events.push('payment controller architecture step ${index}');`);
    if (index === 96) lines.push("  events.push('TARGET_RECONCILIATION_MARKER');");
  }
  lines.push("  return events.join('\\n');");
  lines.push("}");
  return lines.join("\n");
}
