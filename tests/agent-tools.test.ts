import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RagCodeEngine, callTool, listToolDefinitions } from "../src/index.js";
import type { ExpandNodeResult, ExplainImpactReport, IndexStatus, RepoIndex, TopologyMap, VerifiedCodeSubgraph } from "../src/index.js";

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ragcode-agent-tools-"));
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
      "  return { clientSecret: 'agent-tools-secret' };",
      "}"
    ].join("\n")
  );
  await fs.writeFile(
    path.join(tempRoot, "src", "services", "billing.test.ts"),
    [
      "import { createPaymentIntent } from './billing';",
      "",
      "it('creates a payment intent', () => {",
      "  expect(createPaymentIntent().clientSecret).toContain('agent-tools-secret');",
      "});"
    ].join("\n")
  );
  await fs.writeFile(path.join(tempRoot, ".env"), "SECRET_TOKEN=do-not-index\n");
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe("agent tool upgrades", () => {
  it("exposes index_status, refresh_index, and topology_map through MCP definitions", () => {
    const names = listToolDefinitions().map((tool) => tool.name);

    expect(names).toEqual(expect.arrayContaining(["index_status", "refresh_index", "topology_map", "explain_impact", "trace_request_flow", "expand_node", "find_reuse_candidates"]));
  });

  it("reports freshness status and clears stale/pending state after refresh_index", async () => {
    const engine = new RagCodeEngine();
    await engine.indexRepo(tempRoot);

    await fs.writeFile(
      path.join(tempRoot, "src", "services", "billing.ts"),
      [
        "export function createPaymentIntent() {",
        "  return { clientSecret: 'changed-agent-tools-secret' };",
        "}"
      ].join("\n")
    );
    await fs.writeFile(path.join(tempRoot, "src", "services", "receipt.ts"), "export const receiptMarker = 'pending-receipt';\n");

    const staleStatus = await callTool(engine, "index_status", {}) as IndexStatus;
    expect(staleStatus.staleFileCount).toBe(1);
    expect(staleStatus.pendingFileCount).toBe(2);
    expect(staleStatus.freshness.staleFiles).toContain("src/services/billing.ts");
    expect(staleStatus.freshness.pendingFiles).toEqual(expect.arrayContaining(["src/services/billing.ts", "src/services/receipt.ts"]));
    expect(staleStatus.skippedFileCount).toBe(1);

    const refreshed = await callTool(engine, "refresh_index", {}) as RepoIndex;
    expect(refreshed.files.map((file) => file.path)).toContain("src/services/receipt.ts");

    const freshStatus = await callTool(engine, "index_status", {}) as IndexStatus;
    expect(freshStatus.staleFileCount).toBe(0);
    expect(freshStatus.pendingFileCount).toBe(0);
    expect(freshStatus.fileCount).toBe(refreshed.files.length);
  }, 15_000);

  it("returns owner-chain and topology evidence through topology_map", async () => {
    const engine = new RagCodeEngine();
    await engine.indexRepo(tempRoot);

    const map = await callTool(engine, "topology_map", {
      query: "checkout payment billing",
      maxEdges: 8
    }) as TopologyMap;

    expect(map.owners.map((owner) => owner.filePath)).toEqual(expect.arrayContaining([
      "src/app/checkout/CheckoutButton.tsx",
      "src/services/billing.ts"
    ]));
    expect(map.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        edge: "calls_api",
        sourceFile: "src/app/checkout/CheckoutButton.tsx",
        targetFile: "src/app/api/payments/route.ts"
      }),
      expect.objectContaining({
        edge: "routes_to",
        sourceFile: "src/app/api/payments/route.ts",
        targetFile: "src/services/billing.ts"
      })
    ]));
    expect(map.freshness.pendingFiles).toEqual([]);
  });

  it("returns verified blast-radius subgraphs through explain_impact", async () => {
    const engine = new RagCodeEngine();
    await engine.indexRepo(tempRoot);

    const report = await callTool(engine, "explain_impact", {
      target: "createPaymentIntent",
      budgetChars: 8_000
    }) as ExplainImpactReport;

    expect(report.target).toBe("createPaymentIntent");
    expect(report.riskLevel).toMatch(/low|medium|high/);
    expect(report.editReadiness).not.toBe("not_enough_context");
    expect(report.subgraph.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ filePath: "src/services/billing.ts", symbolName: "createPaymentIntent", role: "target" }),
      expect.objectContaining({ filePath: "src/app/api/payments/route.ts", symbolName: "POST", role: "caller" }),
      expect.objectContaining({ filePath: "src/app/checkout/CheckoutButton.tsx" })
    ]));
    expect(report.subgraph.coverage).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "primary_owner_found", status: "pass" }),
      expect.objectContaining({ name: "inbound_callers_checked", status: "pass" })
    ]));
  });

  it("returns ordered request-flow subgraphs through trace_request_flow", async () => {
    const engine = new RagCodeEngine();
    await engine.indexRepo(tempRoot);

    const subgraph = await callTool(engine, "trace_request_flow", {
      entry: "CheckoutButton",
      query: "checkout to payment route and billing service",
      budgetChars: 8_000
    }) as VerifiedCodeSubgraph;

    expect(subgraph.mode).toBe("flow");
    expect(subgraph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "calls_api",
        sourceFile: "src/app/checkout/CheckoutButton.tsx",
        targetFile: "src/app/api/payments/route.ts"
      }),
      expect.objectContaining({
        kind: "routes_to",
        sourceFile: "src/app/api/payments/route.ts",
        targetFile: "src/services/billing.ts"
      })
    ]));
    expect(subgraph.paths.some((steps) => [
      "src/app/checkout/CheckoutButton.tsx:CheckoutButton",
      "src/app/api/payments/route.ts:POST",
      "src/services/billing.ts:createPaymentIntent"
    ].every((step) => steps.includes(step)))).toBe(true);
  });

  it("supports compact output presets for subgraph tools", async () => {
    const engine = new RagCodeEngine();
    await engine.indexRepo(tempRoot);

    const compact = await callTool(engine, "trace_request_flow", {
      entry: "CheckoutButton",
      preset: "compact",
      budgetChars: 8_000
    }) as Record<string, unknown>;

    expect(compact.mode).toBe("flow");
    expect(compact.paths).toEqual(expect.any(Array));
    expect(compact.snippets).toBeUndefined();
  });

  it("expands one compact subgraph node under budget through expand_node", async () => {
    const engine = new RagCodeEngine();
    await engine.indexRepo(tempRoot);

    const expanded = await callTool(engine, "expand_node", {
      nodeRef: "src/services/billing.ts:createPaymentIntent",
      expansionLevel: "focused_body",
      budgetChars: 2_000
    }) as ExpandNodeResult;

    expect(expanded.filePath).toBe("src/services/billing.ts");
    expect(expanded.symbolName).toBe("createPaymentIntent");
    expect(expanded.usedChars).toBeLessThanOrEqual(expanded.budgetChars);
    expect(expanded.snippets).toEqual([
      expect.objectContaining({
        filePath: "src/services/billing.ts",
        expansionLevel: "focused_body",
        content: expect.stringContaining("agent-tools-secret")
      })
    ]);
  });
});
