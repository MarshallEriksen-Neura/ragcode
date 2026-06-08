import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPaymentEvalFixture, type PaymentEvalFixture } from "./fixtures/payment-app.js";
import { runContextEvaluation } from "./context-evaluator.js";

let tempRoot: string;
let fixture: PaymentEvalFixture;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ragcode-eval-skeleton-"));
  fixture = await createPaymentEvalFixture(tempRoot);
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe("context evaluation skeletonization scenario", () => {
  it("reports line elision and rejects full-body large-file dumps", async () => {
    const report = await runContextEvaluation(tempRoot, fixture);

    expect(report.metrics.largeFullBodyViolations).toBe(0);
    expect(report.metrics.returnedLineCount).toBeGreaterThan(0);
    expect(report.metrics.elidedLineCount).toBeGreaterThan(0);
    expect(report.metrics.contextBudgetUsage).toBeGreaterThan(0);
    expect(report.metrics.contextBudgetUsage).toBeLessThanOrEqual(1);
  });
});
