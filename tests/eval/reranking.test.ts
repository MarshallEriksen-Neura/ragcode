import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPaymentEvalFixture, type PaymentEvalFixture } from "./fixtures/payment-app.js";
import { runContextEvaluation } from "./context-evaluator.js";

let tempRoot: string;
let fixture: PaymentEvalFixture;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ragcode-eval-rerank-"));
  fixture = await createPaymentEvalFixture(tempRoot);
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe("context evaluation reranking scenario", () => {
  it("keeps graph-proximate owners ahead of disconnected semantic matches", async () => {
    const report = await runContextEvaluation(tempRoot, fixture);

    expect(report.metrics.graphRerankLift).toBeGreaterThan(0);
    expect(report.ranks[fixture.serviceFile]).toBeLessThan(report.ranks[fixture.disconnectedDocFile]);
    expect(report.ranks[fixture.routeFile]).toBeLessThan(report.ranks[fixture.disconnectedDocFile]);
    expect(report.rerankReasons.length).toBeGreaterThan(0);
    expect(report.metrics.relatedTestHitRate).toBe(1);
  });
});
