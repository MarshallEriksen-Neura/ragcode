import fs from "node:fs/promises";
import path from "node:path";
import type { ContextPack, RepoIndex, SearchHit } from "../../src/core/types.js";
import { RagCodeEngine } from "../../src/index.js";
import { changedStaleCacheSource, type PaymentEvalFixture } from "./fixtures/payment-app.js";

export interface ContextEvalReport {
  metrics: {
    ownerHitRate: number;
    resolvedEdgeRate: number;
    unresolvedEdgeCount: number;
    staleHitRate: number;
    deletedHitRate: number;
    contextBudgetUsage: number;
    relatedTestHitRate: number;
    flowPathCompleteness: number;
    returnedLineCount: number;
    elidedLineCount: number;
    graphRerankLift: number;
    largeFullBodyViolations: number;
  };
  ranks: Record<string, number>;
  expectedOwnerFiles: string[];
  paymentOwnerFiles: string[];
  topologyFiles: string[];
  staleFiles: string[];
  pendingFiles: string[];
  deletedQueryResultFiles: string[];
  staleQueryResultFiles: string[];
  rerankReasons: string[];
}

export async function runContextEvaluation(root: string, fixture: PaymentEvalFixture): Promise<ContextEvalReport> {
  const engine = new RagCodeEngine();
  const index = await engine.indexRepo(root);

  const paymentPack = await engine.getContext({
    repoRoot: root,
    query: "checkout payment billing webhook",
    mode: "feature",
    budgetChars: 12_000
  });
  const rerankHits = await engine.searchCode({
    repoRoot: root,
    query: "payment checkout billing",
    mode: "feature",
    limit: 16
  });
  const debugHits = await engine.searchCode({
    repoRoot: root,
    query: "payment billing",
    mode: "debug",
    limit: 16
  });
  const skeletonPack = await engine.getContext({
    repoRoot: root,
    query: "payment ledger architecture",
    mode: "feature",
    budgetChars: 5_000
  });

  await fs.writeFile(path.join(root, fixture.staleFile), changedStaleCacheSource());
  await fs.rm(path.join(root, fixture.deletedFile));

  const staleHits = await engine.searchCode({
    repoRoot: root,
    query: "indexed-stale-cache-marker",
    limit: 10
  });
  const deletedHits = await engine.searchCode({
    repoRoot: root,
    query: "obsolete-payment-cache-marker",
    limit: 10
  });
  const freshnessPack = await engine.getContext({
    repoRoot: root,
    query: "indexed-stale-cache-marker obsolete-payment-cache-marker",
    budgetChars: 4_000
  });

  return buildReport({
    index,
    paymentPack,
    rerankHits,
    debugHits,
    skeletonPack,
    freshnessPack,
    staleHits,
    deletedHits,
    fixture
  });
}

export function assertContextEvalReport(report: ContextEvalReport): void {
  const failures: string[] = [];
  if (report.metrics.deletedHitRate !== 0) failures.push(`deletedHitRate expected 0, got ${report.metrics.deletedHitRate}`);
  if (report.metrics.staleHitRate !== 0) failures.push(`staleHitRate expected 0, got ${report.metrics.staleHitRate}`);
  if (report.metrics.flowPathCompleteness < 1) failures.push(`flowPathCompleteness expected 1, got ${report.metrics.flowPathCompleteness}`);
  if (report.metrics.ownerHitRate < 1) failures.push(`ownerHitRate expected 1, got ${report.metrics.ownerHitRate}`);
  if (report.metrics.unresolvedEdgeCount < 1) failures.push("unresolvedEdgeCount expected at least 1");
  if (report.metrics.largeFullBodyViolations !== 0) failures.push(`largeFullBodyViolations expected 0, got ${report.metrics.largeFullBodyViolations}`);
  if (report.metrics.graphRerankLift <= 0) failures.push(`graphRerankLift expected positive, got ${report.metrics.graphRerankLift}`);
  if (report.metrics.relatedTestHitRate < 1) failures.push(`relatedTestHitRate expected 1, got ${report.metrics.relatedTestHitRate}`);
  if (report.metrics.elidedLineCount <= 0) failures.push("elidedLineCount expected to be positive");

  if (failures.length > 0) {
    throw new Error(`Context evaluation failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
  }
}

interface BuildReportInput {
  index: RepoIndex;
  paymentPack: ContextPack;
  rerankHits: SearchHit[];
  debugHits: SearchHit[];
  skeletonPack: ContextPack;
  freshnessPack: ContextPack;
  staleHits: SearchHit[];
  deletedHits: SearchHit[];
  fixture: PaymentEvalFixture;
}

function buildReport(input: BuildReportInput): ContextEvalReport {
  const expectedOwnerFiles = [
    input.fixture.checkoutFile,
    input.fixture.routeFile,
    input.fixture.serviceFile,
    input.fixture.webhookFile
  ];
  const paymentOwnerFiles = input.paymentPack.ownerChain.map((owner) => owner.filePath);
  const topologyFiles = topologyNodeFiles(input.paymentPack);
  const visibleFlowFiles = new Set([...paymentOwnerFiles, ...topologyFiles]);
  const ranks = rankFiles(input.rerankHits);
  const serviceRank = ranks[input.fixture.serviceFile] ?? input.rerankHits.length + 1;
  const disconnectedRank = Math.min(
    ranks[input.fixture.disconnectedDocFile] ?? input.rerankHits.length + 1,
    ranks[input.fixture.disconnectedMockFile] ?? input.rerankHits.length + 1
  );
  const largeSnippets = input.skeletonPack.snippets.filter((snippet) => snippet.filePath === input.fixture.largeFile && snippet.originalLineCount > 100);

  return {
    metrics: {
      ownerHitRate: hitRate(expectedOwnerFiles, paymentOwnerFiles),
      resolvedEdgeRate: resolvedEdgeRate(input.index),
      unresolvedEdgeCount: unresolvedEdgeCount(input.index),
      staleHitRate: staleOrDeletedHitRate(input.staleHits, input.fixture.staleFile),
      deletedHitRate: staleOrDeletedHitRate(input.deletedHits, input.fixture.deletedFile),
      contextBudgetUsage: input.paymentPack.usedChars / input.paymentPack.budgetChars,
      relatedTestHitRate: input.debugHits.some((hit) => hit.chunk.filePath === input.fixture.relatedTestFile) ? 1 : 0,
      flowPathCompleteness: hitRate(expectedOwnerFiles, [...visibleFlowFiles]),
      returnedLineCount: sumSnippetLines(input.skeletonPack, "returnedLineCount"),
      elidedLineCount: sumSnippetLines(input.skeletonPack, "elidedLineCount"),
      graphRerankLift: disconnectedRank - serviceRank,
      largeFullBodyViolations: largeSnippets.filter((snippet) => snippet.expansionLevel === "full_body").length
    },
    ranks,
    expectedOwnerFiles,
    paymentOwnerFiles,
    topologyFiles,
    staleFiles: input.freshnessPack.freshness.staleFiles,
    pendingFiles: input.freshnessPack.freshness.pendingFiles,
    deletedQueryResultFiles: input.deletedHits.map((hit) => hit.chunk.filePath),
    staleQueryResultFiles: input.staleHits.map((hit) => hit.chunk.filePath),
    rerankReasons: input.rerankHits.map((hit) => hit.reason).filter((reason) => reason.includes("graph rerank"))
  };
}

function topologyNodeFiles(pack: ContextPack): string[] {
  const files = new Set<string>();
  for (const edge of pack.topology) {
    if (edge.sourceFile) files.add(edge.sourceFile);
    if (edge.targetFile) files.add(edge.targetFile);
  }
  return [...files];
}

function rankFiles(hits: SearchHit[]): Record<string, number> {
  const ranks: Record<string, number> = {};
  hits.forEach((hit, index) => {
    ranks[hit.chunk.filePath] ??= index + 1;
  });
  return ranks;
}

function hitRate(expected: string[], actual: string[]): number {
  const actualSet = new Set(actual);
  return expected.filter((filePath) => actualSet.has(filePath)).length / expected.length;
}

function resolvedEdgeRate(index: RepoIndex): number {
  const resolutionEdges = index.edges.filter((edge) => edge.kind === "calls" || edge.kind === "imports");
  if (resolutionEdges.length === 0) return 1;
  const resolved = resolutionEdges.filter((edge) => edge.metadata?.resolution === "resolved" || edge.metadata?.resolution === "resolved_lsp").length;
  return resolved / resolutionEdges.length;
}

function unresolvedEdgeCount(index: RepoIndex): number {
  return index.edges.filter((edge) => edge.metadata?.resolution === "unresolved").length;
}

function staleOrDeletedHitRate(hits: SearchHit[], filePath: string): number {
  return hits.some((hit) => hit.chunk.filePath === filePath) ? 1 : 0;
}

function sumSnippetLines(pack: ContextPack, key: "returnedLineCount" | "elidedLineCount"): number {
  return pack.snippets.reduce((sum, snippet) => sum + snippet[key], 0);
}
