import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPaymentEvalFixture } from "../tests/eval/fixtures/payment-app.js";
import { assertContextEvalReport, runContextEvaluation } from "../tests/eval/context-evaluator.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "ragcode-eval-context-"));

try {
  const fixture = await createPaymentEvalFixture(root);
  const report = await runContextEvaluation(root, fixture);
  assertContextEvalReport(report);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
