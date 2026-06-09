import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RagCodeEngine } from "../src/index.js";

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ragcode-verified-subgraph-"));
  await fs.mkdir(path.join(tempRoot, "src", "app", "checkout"), { recursive: true });
  await fs.mkdir(path.join(tempRoot, "src", "app", "api", "payments"), { recursive: true });
  await fs.mkdir(path.join(tempRoot, "src", "services"), { recursive: true });

  await fs.writeFile(
    path.join(tempRoot, "src", "app", "checkout", "CheckoutButton.tsx"),
    [
      "\"use client\";",
      "",
      "export function CheckoutButton() {",
      "  async function onClick() {",
      "    await fetch('/api/payments', { method: 'POST' });",
      "  }",
      "  return <button onClick={onClick}>Pay</button>;",
      "}"
    ].join("\n")
  );
  await fs.writeFile(
    path.join(tempRoot, "src", "app", "api", "payments", "route.ts"),
    [
      "import { createPaymentIntent } from '../../../services/billing';",
      "",
      "export async function POST() {",
      "  return createPaymentIntent();",
      "}"
    ].join("\n")
  );
  await fs.writeFile(
    path.join(tempRoot, "src", "services", "billing.ts"),
    [
      "export function createPaymentIntent() {",
      "  return { clientSecret: 'verified-subgraph-secret' };",
      "}"
    ].join("\n")
  );
  await fs.writeFile(
    path.join(tempRoot, "src", "services", "billing.test.ts"),
    [
      "import { createPaymentIntent } from './billing';",
      "",
      "it('creates a payment intent', () => {",
      "  expect(createPaymentIntent().clientSecret).toContain('verified-subgraph-secret');",
      "});"
    ].join("\n")
  );
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe("verified code subgraphs", () => {
  it("returns a cited flow path from client action to route, service, and test", async () => {
    const engine = new RagCodeEngine();
    await engine.indexRepo(tempRoot);

    const subgraph = await engine.verifiedSubgraph({
      repoRoot: tempRoot,
      query: "checkout payment request flow",
      seed: "CheckoutButton",
      mode: "flow",
      budgetChars: 8_000
    });

    expect(subgraph.answerable).toBe(true);
    expect(subgraph.usedChars).toBeLessThanOrEqual(subgraph.budgetChars);
    expect(subgraph.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ filePath: "src/app/checkout/CheckoutButton.tsx", symbolName: "CheckoutButton", role: "target" }),
      expect.objectContaining({ filePath: "src/app/api/payments/route.ts", symbolName: "POST", role: "route" }),
      expect.objectContaining({ filePath: "src/services/billing.ts", symbolName: "createPaymentIntent" }),
      expect.objectContaining({ filePath: "src/services/billing.test.ts", role: "test" })
    ]));
    expect(subgraph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "calls_api",
        source: "framework_rule",
        confidence: "high",
        sourceFile: "src/app/checkout/CheckoutButton.tsx",
        targetFile: "src/app/api/payments/route.ts"
      }),
      expect.objectContaining({
        kind: "routes_to",
        source: "framework_rule",
        confidence: "high",
        sourceFile: "src/app/api/payments/route.ts",
        targetFile: "src/services/billing.ts"
      }),
      expect.objectContaining({
        kind: "tested_by",
        source: "test_import",
        confidence: "high",
        targetFile: "src/services/billing.test.ts"
      })
    ]));
    expect(subgraph.paths.some((steps) => [
      "src/app/checkout/CheckoutButton.tsx:CheckoutButton",
      "src/app/api/payments/route.ts:POST",
      "src/services/billing.ts:createPaymentIntent",
      "src/services/billing.test.ts"
    ].every((step) => steps.includes(step)))).toBe(true);
    expect(signalStatus(subgraph, "primary_owner_found")).toBe("pass");
    expect(signalStatus(subgraph, "outbound_flow_checked")).toBe("pass");
    expect(signalStatus(subgraph, "tests_checked")).toBe("pass");
    expect(signalStatus(subgraph, "unresolved_edges_present")).toBe("pass");
  });

  it("returns transitive blast-radius callers and tests for an impact seed", async () => {
    const engine = new RagCodeEngine();
    await engine.indexRepo(tempRoot);

    const subgraph = await engine.verifiedSubgraph({
      repoRoot: tempRoot,
      query: "createPaymentIntent impact",
      seed: "createPaymentIntent",
      mode: "impact",
      budgetChars: 8_000
    });

    expect(subgraph.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ filePath: "src/services/billing.ts", symbolName: "createPaymentIntent", role: "target" }),
      expect.objectContaining({ filePath: "src/app/api/payments/route.ts", symbolName: "POST", role: "caller" }),
      expect.objectContaining({ filePath: "src/app/checkout/CheckoutButton.tsx", symbolName: "CheckoutButton", role: "caller" }),
      expect.objectContaining({ filePath: "src/services/billing.test.ts", role: "test" })
    ]));
    expect(subgraph.paths.some((steps) => [
      "src/app/checkout/CheckoutButton.tsx:CheckoutButton",
      "src/app/api/payments/route.ts:POST",
      "src/services/billing.ts:createPaymentIntent"
    ].every((step) => steps.includes(step)))).toBe(true);
    expect(signalStatus(subgraph, "inbound_callers_checked")).toBe("pass");
    expect(signalStatus(subgraph, "tests_checked")).toBe("pass");
    expect(subgraph.missingEvidence).not.toContain("No indexed primary owner matched the subgraph seed.");
  });
});

function signalStatus(subgraph: Awaited<ReturnType<RagCodeEngine["verifiedSubgraph"]>>, name: string): string | undefined {
  return subgraph.coverage.find((signal) => signal.name === name)?.status;
}
