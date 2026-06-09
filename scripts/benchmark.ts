import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { loadDotEnv, readGraphRuntimeConfig, readSemanticRuntimeConfig, RagCodeEngine } from "../src/index.js";
import type { ContextPack, RepoIndex, SearchHit } from "../src/index.js";

interface BenchmarkCase {
  name: string;
  query: string;
  mode: "explain" | "debug" | "feature" | "refactor" | "review";
  budgetChars: number;
  limit: number;
  expectedOwnerFiles?: string[];
}

interface Timed<T> {
  elapsedMs: number;
  value: T;
}

interface BenchmarkReport {
  schemaVersion: 1;
  benchmark: string;
  startedAt: string;
  repoRoot: string;
  env: {
    graph: ReturnType<typeof readGraphRuntimeConfig>;
    semantic: ReturnType<typeof readSemanticRuntimeConfig>;
  };
  index: {
    elapsedMs: number;
    projectId: string;
    files: number;
    chunks: number;
    symbols: number;
    edges: number;
    skippedFiles: number;
  };
  semanticProfile?: unknown;
  cases: Array<{
    name: string;
    query: string;
    mode: string;
    search: {
      elapsedMs: number;
      hitCount: number;
      topHits: Array<{
        filePath: string;
        startLine: number;
        endLine: number;
        source: SearchHit["source"];
        score: number;
        reason: string;
      }>;
      semanticReasonHitCount: number;
    };
    context: {
      elapsedMs: number;
      answerable: boolean;
      confidence: ContextPack["confidence"];
      usedChars: number;
      budgetChars: number;
      ownerCount: number;
      ownerSymbolCount: number;
      snippetCount: number;
      topologyCount: number;
      topologyDuplicateCount: number;
      relationshipCount: number;
      missingEvidence: string[];
      ownerFiles: string[];
      ownerSymbols: Array<{ filePath: string; symbols: string[] }>;
    };
    expectations: {
      expectedOwnerFiles: string[];
      missingOwnerFiles: string[];
      passed: boolean;
    };
  }>;
  summary: {
    totalElapsedMs: number;
    cases: number;
    failedCases: number;
    maxSearchElapsedMs: number;
    maxContextElapsedMs: number;
    totalTopologyDuplicates: number;
    totalOwnerSymbols: number;
    semanticReasonHitCount: number;
    passed: boolean;
  };
}

const DEFAULT_CASES: BenchmarkCase[] = [
  {
    name: "vite-plugin-config",
    query: "plugin config",
    mode: "explain",
    budgetChars: 6000,
    limit: 8,
    expectedOwnerFiles: [
      "packages/vite/src/node/server/pluginContainer.ts",
      "packages/vite/src/node/build.ts",
      "packages/plugin-legacy/src/index.ts"
    ]
  },
  {
    name: "vite-resolve-plugins",
    query: "resolve plugins build hooks",
    mode: "feature",
    budgetChars: 6000,
    limit: 8,
    expectedOwnerFiles: [
      "packages/vite/src/node/plugins/index.ts",
      "packages/vite/src/node/build.ts"
    ]
  }
];

const args = parseArgs(process.argv.slice(2));
loadDotEnv(args.cwd);

const started = Date.now();
const repoRoot = path.resolve(args.repo ?? defaultRepoRoot(args.cwd));
const outDir = path.resolve(args.out ?? path.join(args.cwd, ".ragcode", "benchmarks"));
const cases = args.caseName ? DEFAULT_CASES.filter((item) => item.name === args.caseName) : DEFAULT_CASES;
if (cases.length === 0) throw new Error(`No benchmark case matched: ${args.caseName}`);

await fs.mkdir(outDir, { recursive: true });

const engine = new RagCodeEngine({ cwd: args.cwd, env: process.env });
try {
  const indexTimed = await timed(() => engine.indexRepo(repoRoot));
  const index = indexTimed.value;
  const reportCases = [];

  for (const item of cases) {
    const search = await timed(() => engine.searchCode({ repoRoot, query: item.query, limit: item.limit, mode: item.mode }));
    const context = await timed(() => engine.getContext({ repoRoot, query: item.query, mode: item.mode, budgetChars: item.budgetChars }));
    reportCases.push(caseReport(item, search, context));
  }

  const report: BenchmarkReport = {
    schemaVersion: 1,
    benchmark: "ragcode-cli-context",
    startedAt: new Date(started).toISOString(),
    repoRoot,
    env: {
      graph: readGraphRuntimeConfig(process.env, args.cwd),
      semantic: readSemanticRuntimeConfig(process.env, args.cwd)
    },
    index: indexReport(indexTimed, index),
    semanticProfile: await readSemanticProfile(args.cwd, process.env.RAGCODE_LANCEDB_URI, process.env.RAGCODE_LANCEDB_TABLE),
    cases: reportCases,
    summary: summaryReport(started, reportCases)
  };

  const stamp = timestampForFile(new Date(started));
  const jsonPath = path.join(outDir, `${stamp}.benchmark.json`);
  const mdPath = path.join(outDir, `${stamp}.benchmark.md`);
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2));
  await fs.writeFile(mdPath, renderMarkdown(report));
  await fs.writeFile(path.join(outDir, "latest.json"), JSON.stringify(report, null, 2));
  await fs.writeFile(path.join(outDir, "latest.md"), renderMarkdown(report));

  console.log(JSON.stringify({ ok: report.summary.passed, jsonPath, mdPath, latestJson: path.join(outDir, "latest.json"), latestMarkdown: path.join(outDir, "latest.md"), summary: report.summary }, null, 2));
  if (args.assert && !report.summary.passed) process.exitCode = 1;
} finally {
  engine.close();
}

function indexReport(timedIndex: Timed<RepoIndex>, index: RepoIndex): BenchmarkReport["index"] {
  return {
    elapsedMs: timedIndex.elapsedMs,
    projectId: index.projectId,
    files: index.files.length,
    chunks: index.chunks.length,
    symbols: index.symbols.length,
    edges: index.edges.length,
    skippedFiles: index.skippedFiles.length
  };
}

function caseReport(item: BenchmarkCase, search: Timed<SearchHit[]>, context: Timed<ContextPack>): BenchmarkReport["cases"][number] {
  const pack = context.value;
  const topologyKeys = pack.topology.map((edge) => [edge.from, edge.to, edge.edge, edge.sourceFile ?? "", edge.targetFile ?? ""].join("\0"));
  const uniqueTopologyCount = new Set(topologyKeys).size;
  const ownerFiles = pack.ownerChain.map((owner) => owner.filePath);
  const expectedOwnerFiles = item.expectedOwnerFiles ?? [];
  const missingOwnerFiles = expectedOwnerFiles.filter((filePath) => !ownerFiles.includes(filePath));
  const ownerSymbols = pack.ownerChain.map((owner) => ({
    filePath: owner.filePath,
    symbols: owner.symbols.map((symbol) => `${symbol.kind}:${symbol.name}@${symbol.startLine}-${symbol.endLine}`)
  }));
  const ownerSymbolCount = ownerSymbols.reduce((sum, owner) => sum + owner.symbols.length, 0);
  const semanticReasonHitCount = search.value.filter((hit) => /LanceDB vector similarity match/i.test(hit.reason)).length;
  const topologyDuplicateCount = topologyKeys.length - uniqueTopologyCount;
  const passed = pack.answerable
    && missingOwnerFiles.length === 0
    && topologyDuplicateCount === 0
    && ownerSymbolCount > 0
    && pack.usedChars <= pack.budgetChars;

  return {
    name: item.name,
    query: item.query,
    mode: item.mode,
    search: {
      elapsedMs: search.elapsedMs,
      hitCount: search.value.length,
      topHits: search.value.slice(0, item.limit).map((hit) => ({
        filePath: hit.chunk.filePath,
        startLine: hit.chunk.startLine,
        endLine: hit.chunk.endLine,
        source: hit.source,
        score: hit.score,
        reason: hit.reason
      })),
      semanticReasonHitCount
    },
    context: {
      elapsedMs: context.elapsedMs,
      answerable: pack.answerable,
      confidence: pack.confidence,
      usedChars: pack.usedChars,
      budgetChars: pack.budgetChars,
      ownerCount: pack.ownerChain.length,
      ownerSymbolCount,
      snippetCount: pack.snippets.length,
      topologyCount: pack.topology.length,
      topologyDuplicateCount,
      relationshipCount: pack.relationships.length,
      missingEvidence: pack.missingEvidence,
      ownerFiles,
      ownerSymbols
    },
    expectations: {
      expectedOwnerFiles,
      missingOwnerFiles,
      passed
    }
  };
}

function summaryReport(started: number, cases: BenchmarkReport["cases"]): BenchmarkReport["summary"] {
  return {
    totalElapsedMs: Date.now() - started,
    cases: cases.length,
    failedCases: cases.filter((item) => !item.expectations.passed).length,
    maxSearchElapsedMs: Math.max(...cases.map((item) => item.search.elapsedMs)),
    maxContextElapsedMs: Math.max(...cases.map((item) => item.context.elapsedMs)),
    totalTopologyDuplicates: cases.reduce((sum, item) => sum + item.context.topologyDuplicateCount, 0),
    totalOwnerSymbols: cases.reduce((sum, item) => sum + item.context.ownerSymbolCount, 0),
    semanticReasonHitCount: cases.reduce((sum, item) => sum + item.search.semanticReasonHitCount, 0),
    passed: cases.every((item) => item.expectations.passed)
  };
}

function renderMarkdown(report: BenchmarkReport): string {
  const lines = [
    "# RagCode Benchmark",
    "",
    `- startedAt: ${report.startedAt}`,
    `- repoRoot: ${report.repoRoot}`,
    `- passed: ${report.summary.passed}`,
    `- totalElapsedMs: ${report.summary.totalElapsedMs}`,
    "",
    "## Index",
    "",
    `- elapsedMs: ${report.index.elapsedMs}`,
    `- files/chunks/symbols/edges: ${report.index.files}/${report.index.chunks}/${report.index.symbols}/${report.index.edges}`,
    `- skippedFiles: ${report.index.skippedFiles}`,
    "",
    "## Runtime",
    "",
    `- graphStore: ${report.env.graph.graphStore}`,
    `- semanticStore: ${report.env.semantic.semanticStore}`,
    `- embeddingProvider: ${report.env.semantic.embeddingProvider}`,
    `- embeddingModel: ${report.env.semantic.embeddingModel ?? "<none>"}`,
    `- semanticMaxChunks: ${report.env.semantic.semanticMaxChunks ?? "all"}`,
    "",
    "## Summary",
    "",
    `- failedCases: ${report.summary.failedCases}/${report.summary.cases}`,
    `- maxSearchElapsedMs: ${report.summary.maxSearchElapsedMs}`,
    `- maxContextElapsedMs: ${report.summary.maxContextElapsedMs}`,
    `- totalTopologyDuplicates: ${report.summary.totalTopologyDuplicates}`,
    `- totalOwnerSymbols: ${report.summary.totalOwnerSymbols}`,
    `- semanticReasonHitCount: ${report.summary.semanticReasonHitCount}`,
    "",
    "## Cases",
    ""
  ];

  for (const item of report.cases) {
    lines.push(
      `### ${item.name}`,
      "",
      `- query: ${item.query}`,
      `- passed: ${item.expectations.passed}`,
      `- searchElapsedMs: ${item.search.elapsedMs}`,
      `- contextElapsedMs: ${item.context.elapsedMs}`,
      `- ownerFiles: ${item.context.ownerFiles.join(", ")}`,
      `- missingOwnerFiles: ${item.expectations.missingOwnerFiles.join(", ") || "none"}`,
      `- ownerSymbolCount: ${item.context.ownerSymbolCount}`,
      `- topologyDuplicateCount: ${item.context.topologyDuplicateCount}`,
      `- usedChars: ${item.context.usedChars}/${item.context.budgetChars}`,
      "",
      "Top hits:",
      ""
    );
    for (const hit of item.search.topHits.slice(0, 5)) {
      lines.push(`- ${hit.filePath}:${hit.startLine} [${hit.source}] ${hit.score.toFixed(2)}`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

async function timed<T>(fn: () => Promise<T>): Promise<Timed<T>> {
  const started = performance.now();
  const value = await fn();
  return { elapsedMs: Math.round(performance.now() - started), value };
}

async function readSemanticProfile(cwd: string, uri: string | undefined, table: string | undefined): Promise<unknown> {
  const profilePath = path.resolve(cwd, uri ?? path.join(".ragcode", "lancedb"), `${table ?? "code_chunks"}.embedding-profile.json`);
  const content = await fs.readFile(profilePath, "utf8").catch(() => undefined);
  return content ? JSON.parse(content) : undefined;
}

function defaultRepoRoot(cwd: string): string {
  const sibling = path.resolve(cwd, "..", "ragcode-samples", "vite");
  return process.env.RAGCODE_BENCHMARK_REPO ?? sibling;
}

function parseArgs(argv: string[]): { cwd: string; repo?: string; out?: string; caseName?: string; assert: boolean } {
  const parsed = { cwd: process.cwd(), assert: false } as { cwd: string; repo?: string; out?: string; caseName?: string; assert: boolean };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo") parsed.repo = requireValue(argv, ++index, arg);
    else if (arg === "--out") parsed.out = requireValue(argv, ++index, arg);
    else if (arg === "--case") parsed.caseName = requireValue(argv, ++index, arg);
    else if (arg === "--cwd") parsed.cwd = path.resolve(requireValue(argv, ++index, arg));
    else if (arg === "--assert") parsed.assert = true;
    else throw new Error(`Unknown benchmark argument: ${arg}`);
  }
  return parsed;
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) throw new Error(`Missing value for ${flag}`);
  return value;
}

function timestampForFile(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}
