import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RagCodeEngine } from "../src/index.js";

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ragcode-tested-by-"));
  await fs.mkdir(path.join(tempRoot, "src", "services"), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, "src", "services", "billing.ts"),
    [
      "export function chargeCustomer(customerId: string) {",
      "  return `charged:${customerId}`;",
      "}"
    ].join("\n")
  );
  await fs.writeFile(
    path.join(tempRoot, "src", "services", "payments.integration.test.ts"),
    [
      "import { chargeCustomer } from './billing';",
      "",
      "it('charges through billing', () => {",
      "  expect(chargeCustomer('cus_123')).toBe('charged:cus_123');",
      "});"
    ].join("\n")
  );
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe("tested_by topology", () => {
  it("indexes import-based tested_by edges from source symbols to colocated tests", async () => {
    const engine = new RagCodeEngine();
    const index = await engine.indexRepo(tempRoot);

    const chargeCustomer = index.symbols.find((symbol) => symbol.name === "chargeCustomer");
    const testFile = index.symbols.find((symbol) => symbol.kind === "file" && symbol.filePath === "src/services/payments.integration.test.ts");
    const testedBy = index.edges.find((edge) => edge.kind === "tested_by");

    expect(testedBy).toMatchObject({
      sourceId: chargeCustomer?.id,
      targetId: testFile?.id,
      metadata: {
        sourceFile: "src/services/billing.ts",
        targetFile: "src/services/payments.integration.test.ts",
        importedName: "chargeCustomer",
        resolution: "test_import"
      }
    });
  });

  it("exposes tested_by evidence through related tests, impact, trace, and topology map", async () => {
    const engine = new RagCodeEngine();
    await engine.indexRepo(tempRoot);

    const related = await engine.relatedTests(tempRoot, "src/services/billing.ts");
    expect(related.tests.map((file) => file.path)).toEqual(["src/services/payments.integration.test.ts"]);
    expect(related.references).toEqual([
      expect.objectContaining({
        edge: "tested_by",
        sourceFile: "src/services/billing.ts",
        targetFile: "src/services/payments.integration.test.ts",
        confidence: "high"
      })
    ]);
    expect(related.missingLikelyTests).toEqual([]);

    const impact = await engine.impactAnalysis(tempRoot, "chargeCustomer");
    expect(impact.impactedFiles).toEqual(expect.arrayContaining([
      "src/services/billing.ts",
      "src/services/payments.integration.test.ts"
    ]));
    expect(impact.minimalPack).toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: "src/services/billing.ts",
        role: "target"
      }),
      expect.objectContaining({
        filePath: "src/services/payments.integration.test.ts",
        role: "test"
      })
    ]));
    expect(impact.references).toEqual(expect.arrayContaining([
      expect.objectContaining({
        edge: "tested_by",
        sourceFile: "src/services/billing.ts",
        targetFile: "src/services/payments.integration.test.ts"
      })
    ]));
    expect(impact.nextQueries).toEqual(expect.arrayContaining([
      "related_tests chargeCustomer",
      "trace_flow chargeCustomer"
    ]));
    expect(impact.outgoingEdges.some((edge) => edge.kind === "tested_by")).toBe(true);

    const flow = await engine.traceFlow(tempRoot, "chargeCustomer");
    expect(flow.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: "src/services/billing.ts",
        kind: "tested_by",
        targetFile: "src/services/payments.integration.test.ts"
      })
    ]));

    const topology = await engine.topologyMap({
      repoRoot: tempRoot,
      query: "chargeCustomer billing",
      maxEdges: 12
    });
    expect(topology.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        edge: "tested_by",
        sourceFile: "src/services/billing.ts",
        targetFile: "src/services/payments.integration.test.ts",
        confidence: "high"
      })
    ]));
  });
});
