import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RagCodeEngine } from "../src/index.js";
import { applySubgraphOutputPreset } from "../src/subgraph/output-preset.js";
import { SubgraphBuilder } from "../src/subgraph/subgraph-builder.js";
import type { CodeChunk, GraphEdge, SymbolNode, VerifiedCodeSubgraph } from "../src/core/types.js";

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
        targetFile: "src/app/api/payments/route.ts",
        metadata: expect.objectContaining({
          framework: "nextjs",
          route: "/api/payments",
          requestPath: "/api/payments",
          resolution: "framework_static"
        })
      }),
      expect.objectContaining({
        kind: "routes_to",
        source: "framework_rule",
        confidence: "high",
        sourceFile: "src/app/api/payments/route.ts",
        targetFile: "src/services/billing.ts",
        metadata: expect.objectContaining({
          framework: "nextjs",
          route: "/api/payments",
          resolution: "framework_call_graph"
        })
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
    expect(subgraph.coverageSummary).toEqual(expect.objectContaining({
      verdict: "safe_to_edit_after_reading",
      failed: 0
    }));
    expect(subgraph.coverageSummary.summary).toContain("Edit-ready");
    expect(subgraph.whyTheseFiles).toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: "src/app/checkout/CheckoutButton.tsx",
        roles: expect.arrayContaining(["target"]),
        reasons: expect.arrayContaining([expect.stringContaining("Matched primary seed symbol")])
      }),
      expect.objectContaining({
        filePath: "src/app/api/payments/route.ts",
        roles: expect.arrayContaining(["route"]),
        evidence: expect.arrayContaining([expect.objectContaining({
          kind: "calls_api",
          source: "framework_rule",
          metadata: expect.objectContaining({ route: "/api/payments" })
        })])
      })
    ]));
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

  it("prefers high-confidence weighted paths over lower-confidence short paths", () => {
    const symbols: SymbolNode[] = [
      symbol("seed", "src/seed.ts", "seed"),
      symbol("weak", "src/weak.ts", "weak"),
      symbol("route", "src/route.ts", "route"),
      symbol("service", "src/service.ts", "service"),
      symbol("strong", "src/strong.ts", "strong")
    ];
    const edges: GraphEdge[] = [
      edge("seed", "weak", "references", { sourceFile: "src/seed.ts", targetFile: "src/weak.ts" }),
      edge("weak", "strong", "references", { sourceFile: "src/weak.ts", targetFile: "src/strong.ts" }),
      edge("seed", "route", "calls_api", { sourceFile: "src/seed.ts", targetFile: "src/route.ts", framework: "nextjs", resolution: "framework_static" }),
      edge("route", "service", "routes_to", { sourceFile: "src/route.ts", targetFile: "src/service.ts", framework: "nextjs", resolution: "framework_call_graph" }),
      edge("service", "strong", "calls", { sourceFile: "src/service.ts", targetFile: "src/strong.ts", resolution: "resolved_lsp" })
    ];

    const subgraph = new SubgraphBuilder().build({
      query: "weighted path",
      repoRoot: "/repo",
      projectId: "project",
      mode: "flow",
      seedSymbols: [symbols[0]!],
      symbols,
      edges,
      chunks: chunksFor(symbols),
      budgetChars: 20_000,
      maxHops: 4
    });

    const pathToStrong = subgraph.paths.find((steps) => steps.at(-1) === "src/strong.ts:strong");
    expect(pathToStrong).toEqual([
      "src/seed.ts:seed",
      "src/route.ts:route",
      "src/service.ts:service",
      "src/strong.ts:strong"
    ]);
  });

  it("returns differentiated output preset contracts", async () => {
    const engine = new RagCodeEngine();
    await engine.indexRepo(tempRoot);

    const subgraph = await engine.verifiedSubgraph({
      repoRoot: tempRoot,
      query: "checkout payment request flow",
      seed: "CheckoutButton",
      mode: "flow",
      budgetChars: 8_000
    });

    const agentEdit = applySubgraphOutputPreset(subgraph, "agent_edit") as Partial<VerifiedCodeSubgraph>;
    const debugTrace = applySubgraphOutputPreset(subgraph, "debug_trace") as Partial<VerifiedCodeSubgraph>;
    const reviewRisk = applySubgraphOutputPreset(subgraph, "review_risk") as Partial<VerifiedCodeSubgraph> & { riskEvidence?: unknown[] };

    expect(agentEdit).toEqual(expect.objectContaining({
      coverageSummary: subgraph.coverageSummary,
      whyTheseFiles: subgraph.whyTheseFiles,
      snippets: subgraph.snippets
    }));
    expect(agentEdit.nodes).toBeUndefined();
    expect(debugTrace).toEqual(expect.objectContaining({
      paths: subgraph.paths,
      edges: subgraph.edges,
      coverage: subgraph.coverage
    }));
    expect(debugTrace.snippets).toBeUndefined();
    expect(reviewRisk).toEqual(expect.objectContaining({
      coverageSummary: subgraph.coverageSummary,
      whyTheseFiles: subgraph.whyTheseFiles,
      riskEvidence: expect.any(Array)
    }));
    expect(reviewRisk.snippets).toBeUndefined();
    expect(reviewRisk.edges).toBeUndefined();
  });

  it("treats truncated subgraphs as investigate-only rather than safe to edit", () => {
    const symbols: SymbolNode[] = [symbol("seed", "src/seed.ts", "seed")];
    const edges: GraphEdge[] = [];
    const chunks: CodeChunk[] = [
      {
        id: "chunk:seed",
        projectId: "project",
        repoRoot: "/repo",
        filePath: "src/seed.ts",
        language: "typescript",
        kind: "function",
        symbolName: "seed",
        startLine: 1,
        endLine: 3,
        content: "export function seed() { return true; }",
        contentHash: "hash:seed"
      }
    ];

    const subgraph = new SubgraphBuilder().build({
      query: "truncated budget",
      repoRoot: "/repo",
      projectId: "project",
      mode: "flow",
      seedSymbols: symbols,
      symbols,
      edges,
      chunks,
      budgetChars: 1,
      maxHops: 1
    });

    expect(subgraph.coverageSummary.verdict).toBe("investigate_only");
  });
});

function signalStatus(subgraph: Awaited<ReturnType<RagCodeEngine["verifiedSubgraph"]>>, name: string): string | undefined {
  return subgraph.coverage.find((signal) => signal.name === name)?.status;
}

function symbol(id: string, filePath: string, name: string): SymbolNode {
  return {
    id,
    projectId: "project",
    filePath,
    name,
    kind: "function",
    language: "typescript",
    startLine: 1,
    endLine: 3,
    exported: true
  };
}

function edge(sourceId: string, targetId: string, kind: GraphEdge["kind"], metadata: Record<string, unknown>): GraphEdge {
  return { projectId: "project", sourceId, targetId, kind, metadata };
}

function chunksFor(symbols: SymbolNode[]): CodeChunk[] {
  return symbols.map((item) => ({
    id: `chunk:${item.id}`,
    projectId: item.projectId,
    repoRoot: "/repo",
    filePath: item.filePath,
    language: "typescript",
    kind: "function",
    symbolName: item.name,
    startLine: item.startLine,
    endLine: item.endLine,
    content: `export function ${item.name}() { return true; }`,
    contentHash: `hash:${item.id}`
  }));
}
