import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPaymentEvalFixture, type PaymentEvalFixture } from "./fixtures/payment-app.js";
import { runContextEvaluation } from "./context-evaluator.js";

let tempRoot: string;
let fixture: PaymentEvalFixture;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ragcode-eval-topology-"));
  fixture = await createPaymentEvalFixture(tempRoot);
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe("context evaluation topology scenario", () => {
  it("captures the known checkout to API to service and webhook flow", async () => {
    const report = await runContextEvaluation(tempRoot, fixture);

    expect(report.metrics.flowPathCompleteness).toBe(1);
    expect(report.metrics.ownerHitRate).toBe(1);
    expect(report.topologyFiles).toEqual(expect.arrayContaining([
      fixture.checkoutFile,
      fixture.routeFile,
      fixture.serviceFile,
      fixture.webhookFile
    ]));
    expect(report.metrics.unresolvedEdgeCount).toBeGreaterThan(0);
    expect(report.metrics.resolvedEdgeRate).toBeGreaterThan(0);
  });
});
