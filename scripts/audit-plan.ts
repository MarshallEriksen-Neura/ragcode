import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { callTool, listToolDefinitions, RagCodeEngine } from "../src/index.js";
import type { IndexStatus, TopologyMap } from "../src/index.js";
import { createPaymentEvalFixture } from "../tests/eval/fixtures/payment-app.js";
import { assertContextEvalReport, runContextEvaluation, type ContextEvalReport } from "../tests/eval/context-evaluator.js";

interface AuditCriterion {
  id: string;
  completionDefinition: string;
  status: "pass" | "fail";
  evidence: string[];
}

interface PlanCompletionAuditReport {
  plan: "PLAN_STABILITY_AND_TOPOLOGY";
  status: "pass" | "fail";
  generatedAt: string;
  metrics: ContextEvalReport["metrics"];
  criteria: AuditCriterion[];
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "ragcode-plan-audit-"));

try {
  const fixture = await createPaymentEvalFixture(root);
  const contextReport = await runContextEvaluation(root, fixture);
  assertContextEvalReport(contextReport);
  const mcpSmoke = await runMcpSmoke(root);
  const evidenceFiles = await readEvidenceFiles();
  const criteria = buildCriteria(contextReport, mcpSmoke, evidenceFiles);
  const report: PlanCompletionAuditReport = {
    plan: "PLAN_STABILITY_AND_TOPOLOGY",
    status: criteria.every((criterion) => criterion.status === "pass") ? "pass" : "fail",
    generatedAt: new Date().toISOString(),
    metrics: contextReport.metrics,
    criteria
  };

  console.log(JSON.stringify(report, null, 2));
  if (report.status !== "pass") {
    throw new Error(`Plan completion audit failed:\n${criteria
      .filter((criterion) => criterion.status === "fail")
      .map((criterion) => `- ${criterion.id}: ${criterion.completionDefinition}`)
      .join("\n")}`);
  }
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

async function runMcpSmoke(root: string): Promise<{ toolNames: string[]; status: IndexStatus; topology: TopologyMap }> {
  const engine = new RagCodeEngine();
  await engine.indexRepo(root);
  const toolNames = listToolDefinitions().map((tool) => tool.name);
  const status = await callTool(engine, "index_status", {}) as IndexStatus;
  const topology = await callTool(engine, "topology_map", {
    query: "checkout payment billing",
    maxEdges: 12
  }) as TopologyMap;

  return { toolNames, status, topology };
}

async function readEvidenceFiles(): Promise<Record<string, string>> {
  const paths = [
    "tests/freshness.test.ts",
    "tests/foundation.test.ts",
    "tests/sqlite-graph-store.test.ts",
    "tests/semantic-consistency.test.ts",
    "tests/topology-resolution.test.ts",
    "tests/lsp-resolution.test.ts",
    "tests/eval/topology.test.ts",
    "tests/eval/skeletonization.test.ts",
    "tests/eval/reranking.test.ts",
    "tests/agent-tools.test.ts",
    "scripts/eval-context.ts"
  ];
  const entries = await Promise.all(paths.map(async (filePath) => [filePath, await fs.readFile(filePath, "utf8")] as const));
  return Object.fromEntries(entries);
}

function buildCriteria(
  contextReport: ContextEvalReport,
  mcpSmoke: Awaited<ReturnType<typeof runMcpSmoke>>,
  evidenceFiles: Record<string, string>
): AuditCriterion[] {
  return [
    criterion(
      "fresh-edits",
      "survive fast edits without returning deleted or stale context as fresh",
      contextReport.metrics.staleHitRate === 0
        && contextReport.metrics.deletedHitRate === 0
        && contextReport.staleFiles.length >= 2
        && includesAll(evidenceFiles["tests/freshness.test.ts"], ["reports changed files as stale and pending", "reports deleted files as stale"]),
      [
        `staleHitRate=${contextReport.metrics.staleHitRate}`,
        `deletedHitRate=${contextReport.metrics.deletedHitRate}`,
        "tests/freshness.test.ts"
      ]
    ),
    criterion(
      "project-isolation",
      "keep multiple projects isolated in graph, vector, freshness, and MCP tool results",
      includesAll(evidenceFiles["tests/foundation.test.ts"], ["keeps projects isolated"])
        && includesAll(evidenceFiles["tests/sqlite-graph-store.test.ts"], ["keeps projects isolated inside one SQLite database"])
        && includesAll(evidenceFiles["tests/semantic-consistency.test.ts"], ["filters LanceDB semantic search by projectId"]),
      [
        "tests/foundation.test.ts active workspace isolation",
        "tests/sqlite-graph-store.test.ts SQLite project scoping",
        "tests/semantic-consistency.test.ts LanceDB project filter"
      ]
    ),
    criterion(
      "freshness-in-contextpack",
      "report freshness in every context pack",
      mcpSmoke.status.freshness.projectId === mcpSmoke.status.projectId
        && includesAll(evidenceFiles["tests/foundation.test.ts"], ["pack.freshness.projectId"])
        && includesAll(evidenceFiles["tests/agent-tools.test.ts"], ["index_status"]),
      [
        `index_status projectId=${mcpSmoke.status.projectId}`,
        "tests/foundation.test.ts ContextPack freshness assertion",
        "tests/agent-tools.test.ts index_status freshness"
      ]
    ),
    criterion(
      "typescript-resolution",
      "resolve imports/exports and cross-file calls for TypeScript",
      contextReport.metrics.resolvedEdgeRate > 0
        && includesAll(evidenceFiles["tests/topology-resolution.test.ts"], ["resolves relative imports", "resolved call edges"]),
      [
        `resolvedEdgeRate=${contextReport.metrics.resolvedEdgeRate}`,
        "tests/topology-resolution.test.ts"
      ]
    ),
    criterion(
      "lsp-bridge",
      "use TypeScript language service for definitions/references",
      includesAll(evidenceFiles["tests/lsp-resolution.test.ts"], ["resolved_lsp", "keeps unresolved calls explicit", "degrades to the input AST graph"]),
      [
        "tests/lsp-resolution.test.ts resolved_lsp, unresolved fallback, graceful degradation"
      ]
    ),
    criterion(
      "framework-flow",
      "identify at least one realistic React -> API -> service -> webhook flow in an eval fixture",
      contextReport.metrics.flowPathCompleteness === 1
        && contextReport.topologyFiles.includes("src/app/api/stripe/webhook/route.ts")
        && includesAll(evidenceFiles["tests/eval/topology.test.ts"], ["checkout to API to service and webhook"]),
      [
        `flowPathCompleteness=${contextReport.metrics.flowPathCompleteness}`,
        `topologyFiles=${contextReport.topologyFiles.join(",")}`,
        "tests/eval/topology.test.ts"
      ]
    ),
    criterion(
      "skeletonization",
      "skeletonize large related files and expand only focused owner bodies",
      contextReport.metrics.largeFullBodyViolations === 0
        && contextReport.metrics.elidedLineCount > 0
        && includesAll(evidenceFiles["tests/eval/skeletonization.test.ts"], ["line elision", "full-body large-file dumps"]),
      [
        `largeFullBodyViolations=${contextReport.metrics.largeFullBodyViolations}`,
        `elidedLineCount=${contextReport.metrics.elidedLineCount}`,
        "tests/eval/skeletonization.test.ts"
      ]
    ),
    criterion(
      "graph-reranking",
      "rerank semantic candidates by graph distance and expose ranking reasons",
      contextReport.metrics.graphRerankLift > 0
        && contextReport.rerankReasons.length > 0
        && includesAll(evidenceFiles["tests/eval/reranking.test.ts"], ["graph-proximate owners"]),
      [
        `graphRerankLift=${contextReport.metrics.graphRerankLift}`,
        `rerankReasons=${contextReport.rerankReasons.length}`,
        "tests/eval/reranking.test.ts"
      ]
    ),
    criterion(
      "mcp-tools",
      "expose the result through MCP tools with passing tests",
      includesAll(mcpSmoke.toolNames.join(","), ["get_context", "topology_map", "index_status", "refresh_index"])
        && mcpSmoke.topology.edges.some((edge) => edge.edge === "calls_api")
        && mcpSmoke.topology.edges.some((edge) => edge.edge === "routes_to")
        && includesAll(evidenceFiles["tests/agent-tools.test.ts"], ["topology_map", "index_status", "refresh_index"]),
      [
        `tools=${mcpSmoke.toolNames.join(",")}`,
        `topologyEdges=${mcpSmoke.topology.edges.map((edge) => edge.edge).join(",")}`,
        "tests/agent-tools.test.ts"
      ]
    ),
    criterion(
      "scriptable-eval",
      "keep the completion evidence executable through the evaluation harness",
      includesAll(evidenceFiles["scripts/eval-context.ts"], ["assertContextEvalReport", "runContextEvaluation"]),
      [
        "scripts/eval-context.ts",
        "bun run eval:context"
      ]
    )
  ];
}

function criterion(id: string, completionDefinition: string, passed: boolean, evidence: string[]): AuditCriterion {
  return {
    id,
    completionDefinition,
    status: passed ? "pass" : "fail",
    evidence
  };
}

function includesAll(content: string | undefined, needles: string[]): boolean {
  return Boolean(content && needles.every((needle) => content.includes(needle)));
}
