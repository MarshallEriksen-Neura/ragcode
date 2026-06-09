import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPaymentEvalFixture, type PaymentEvalFixture } from "./fixtures/payment-app.js";
import { runContextEvaluation } from "./context-evaluator.js";

let tempRoot: string;
let fixture: PaymentEvalFixture;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ragcode-eval-structured-"));
  fixture = await createPaymentEvalFixture(tempRoot);
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe("structured relation retrieval evaluation", () => {
  it("separates grep-solvable lookup from graph-only flow and reuse wins", async () => {
    const report = await runContextEvaluation(tempRoot, fixture);

    expect(report.metrics.grepKnownSymbolHitRate).toBe(1);
    expect(report.metrics.grepLexicalGapHitRate).toBe(0);
    expect(report.metrics.grepFlowPathCompleteness).toBeLessThan(1);
    expect(report.metrics.verifiedSubgraphPathCompleteness).toBe(1);
    expect(report.metrics.verifiedImpactCallerRecall).toBe(1);
    expect(report.metrics.reuseCandidateRecall).toBe(1);
    expect(report.metrics.duplicateFalseNegativeRate).toBe(0);
    expect(report.reuseCandidates).toContain(`${fixture.reuseFile}:tokenBucket`);
  });
});
