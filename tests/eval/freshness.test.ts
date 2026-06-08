import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPaymentEvalFixture, type PaymentEvalFixture } from "./fixtures/payment-app.js";
import { runContextEvaluation } from "./context-evaluator.js";

let tempRoot: string;
let fixture: PaymentEvalFixture;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ragcode-eval-freshness-"));
  fixture = await createPaymentEvalFixture(tempRoot);
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe("context evaluation freshness scenario", () => {
  it("fails when stale or deleted cache hits leak into retrieval", async () => {
    const report = await runContextEvaluation(tempRoot, fixture);

    expect(report.metrics.deletedHitRate).toBe(0);
    expect(report.metrics.staleHitRate).toBe(0);
    expect(report.deletedQueryResultFiles).not.toContain(fixture.deletedFile);
    expect(report.staleQueryResultFiles).not.toContain(fixture.staleFile);
    expect(report.staleFiles).toEqual(expect.arrayContaining([fixture.deletedFile, fixture.staleFile]));
    expect(report.pendingFiles).toContain(fixture.staleFile);
  });
});
