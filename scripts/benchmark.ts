import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  classifyEvidencePath,
  hasSemanticParticipation,
  loadDotEnv,
  RagCodeEngine,
  createRuntimeComponentsForRepo,
  readGraphRuntimeConfig,
  readSemanticRuntimeConfig
} from "../src/index.js";
import type { ContextPack, IndexStatus, RepoIndex, SearchHit } from "../src/index.js";

type BenchmarkMode = "explain" | "debug" | "feature" | "refactor" | "review";
type BenchmarkSuite = "core" | "observation" | "project";
type BenchmarkSuiteSelection = BenchmarkSuite | "all";

interface BenchmarkCase {
  name: string;
  query: string;
  mode: BenchmarkMode;
  budgetChars: number;
  limit: number;
  gate?: boolean;
  expectedOwnerFiles?: string[];
  maxExpectedOwnerRank?: number;
}

interface BenchmarkRepoConfig {
  name: string;
  suite: BenchmarkSuite;
  localPath: string;
  cloneUrl?: string;
  branch?: string;
  pinnedHead?: string;
  useRepoRuntime?: boolean;
  rationale?: string;
  cases: BenchmarkCase[];
}

interface BenchmarkConfig {
  schemaVersion: 1;
  sampleRoot?: string;
  defaultSuite?: BenchmarkSuiteSelection;
  repositories: BenchmarkRepoConfig[];
}

interface BenchmarkArgs {
  cwd: string;
  repo?: string;
  repoName?: string;
  suite?: BenchmarkSuiteSelection;
  config?: string;
  out?: string;
  caseName?: string;
  assert: boolean;
  all: boolean;
  gateOnly: boolean;
  reuseIndex: boolean;
  list: boolean;
}

interface Timed<T> {
  elapsedMs: number;
  value: T;
}

interface BenchmarkReport {
  schemaVersion: 2;
  benchmark: "ragcode-cli-context";
  startedAt: string;
  repoName?: string;
  suite?: BenchmarkSuite;
  repoRoot: string;
  config?: {
    configPath?: string;
    localPath?: string;
    cloneUrl?: string;
    branch?: string;
    pinnedHead?: string;
    useRepoRuntime?: boolean;
    rationale?: string;
  };
  env: {
    graph: ReturnType<typeof readGraphRuntimeConfig>;
    semantic: ReturnType<typeof readSemanticRuntimeConfig>;
  };
  index: {
    reused: boolean;
    elapsedMs: number;
    projectId: string;
    files: number;
    chunks: number;
    symbols: number;
    edges: number;
    skippedFiles: number;
    staleFiles?: number;
    pendingFiles?: number;
    indexingFiles?: number;
  };
  semanticProfile?: unknown;
  cases: Array<{
    name: string;
    query: string;
    mode: string;
    gate: boolean;
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
      semantic: {
        status: "ok" | "failed";
        rawHitCount: number;
        topNParticipation: number;
        error?: string;
      };
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
      evidenceCounts: Record<"implementation" | "test" | "docs" | "fixture", number>;
    };
    expectations: {
      expectedOwnerFiles: string[];
      missingOwnerFiles: string[];
      ownerRanks: Array<{ filePath: string; rank: number | null; maxRank: number | null; passed: boolean }>;
      passed: boolean;
    };
  }>;
  summary: {
    totalElapsedMs: number;
    cases: number;
    failedCases: number;
    gatedCases: number;
    failedGatedCases: number;
    maxSearchElapsedMs: number;
    maxContextElapsedMs: number;
    totalTopologyDuplicates: number;
    totalOwnerSymbols: number;
    semanticReasonHitCount: number;
    semanticFailedCases: number;
    semanticTopNParticipation: number;
    passed: boolean;
    gatePassed: boolean;
  };
}

interface BenchmarkMatrixReport {
  schemaVersion: 2;
  benchmark: "ragcode-cli-context-matrix";
  startedAt: string;
  configPath: string;
  sampleRoot: string;
  suite: BenchmarkSuiteSelection;
  repos: BenchmarkReport[];
  summary: BenchmarkReport["summary"] & {
    repos: number;
    failedRepos: number;
    failedGateRepos: number;
  };
}

const DEFAULT_CASES: BenchmarkCase[] = [
  {
    name: "vite-plugin-config",
    query: "plugin config",
    mode: "explain",
    budgetChars: 6000,
    limit: 8,
    gate: true,
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
    gate: true,
    expectedOwnerFiles: [
      "packages/vite/src/node/plugins/index.ts",
      "packages/vite/src/node/build.ts"
    ],
    maxExpectedOwnerRank: 4
  }
];

await main();

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  loadDotEnv(args.cwd);

  if (args.repo) {
    await runSingleRepoCli(args);
    return;
  }

  await runMatrixCli(args);
}

async function runSingleRepoCli(args: BenchmarkArgs): Promise<void> {
  const started = Date.now();
  const outDir = path.resolve(args.out ?? path.join(args.cwd, ".ragcode", "benchmarks"));
  const repoRoot = path.resolve(args.repo ?? defaultRepoRoot(args.cwd));
  const cases = selectCases(DEFAULT_CASES, args, "ad-hoc repo");
  await fs.mkdir(outDir, { recursive: true });

  const engine = createBenchmarkEngine(args.cwd, repoRoot, true);
  try {
    const report = await runRepoBenchmark(engine, {
      args,
      cases,
      repoRoot,
      repoName: path.basename(repoRoot),
      startedAtMs: started
    });
    const written = await writeReportFiles(outDir, started, report, renderMarkdown(report), "benchmark");
    console.log(JSON.stringify({
      ok: report.summary.gatePassed,
      jsonPath: written.jsonPath,
      mdPath: written.mdPath,
      latestJson: written.latestJson,
      latestMarkdown: written.latestMarkdown,
      summary: report.summary
    }, null, 2));
    if (args.assert && !report.summary.gatePassed) process.exitCode = 1;
  } finally {
    engine.close();
  }
}

async function runMatrixCli(args: BenchmarkArgs): Promise<void> {
  const started = Date.now();
  const outDir = path.resolve(args.out ?? path.join(args.cwd, ".ragcode", "benchmarks"));
  const configPath = resolveConfigPath(args);
  const config = await loadBenchmarkConfig(configPath);
  const sampleRoot = resolveSampleRoot(args.cwd, config);
  const suite = selectedSuite(args, config);
  const repos = selectRepos(config, args, suite);

  if (args.list) {
    console.log(JSON.stringify({
      configPath,
      sampleRoot,
      suite,
      repositories: repos.map((repo) => ({
        name: repo.name,
        suite: repo.suite,
        localPath: path.resolve(sampleRoot, repo.localPath),
        cases: selectCases(repo.cases, args, repo.name).map((item) => ({
          name: item.name,
          gate: item.gate ?? true
        }))
      }))
    }, null, 2));
    return;
  }

  await fs.mkdir(outDir, { recursive: true });
  const reports: BenchmarkReport[] = [];
  for (const repo of repos) {
    const repoRoot = path.resolve(sampleRoot, repo.localPath);
    await fs.access(repoRoot).catch(() => {
      throw new Error(`Benchmark repo '${repo.name}' is missing at ${repoRoot}. Clone ${repo.cloneUrl ?? repo.name} or set RAGCODE_BENCHMARK_SAMPLE_ROOT.`);
    });
    const engine = createBenchmarkEngine(args.cwd, repoRoot, repo.useRepoRuntime ?? false);
    try {
      reports.push(await runRepoBenchmark(engine, {
        args,
        cases: selectCases(repo.cases, args, repo.name),
        repoRoot,
        repoName: repo.name,
        suite: repo.suite,
        repoConfig: repo,
        configPath,
        startedAtMs: Date.now()
      }));
    } finally {
      engine.close();
    }
  }

  const matrix = matrixReport(started, configPath, sampleRoot, suite, reports);
  const written = await writeReportFiles(outDir, started, matrix, renderMatrixMarkdown(matrix), "matrix");
  console.log(JSON.stringify({
    ok: matrix.summary.gatePassed,
    jsonPath: written.jsonPath,
    mdPath: written.mdPath,
    latestJson: written.latestJson,
    latestMarkdown: written.latestMarkdown,
    summary: matrix.summary
  }, null, 2));
  if (args.assert && !matrix.summary.gatePassed) process.exitCode = 1;
}

async function runRepoBenchmark(
  engine: RagCodeEngine,
  options: {
    args: BenchmarkArgs;
    cases: BenchmarkCase[];
    repoRoot: string;
    repoName?: string;
    suite?: BenchmarkSuite;
    repoConfig?: BenchmarkRepoConfig;
    configPath?: string;
    startedAtMs: number;
  }
): Promise<BenchmarkReport> {
  const indexTimed = options.args.reuseIndex
    ? await timed(() => engine.indexStatus(options.repoRoot))
    : await timed(() => engine.indexRepo(options.repoRoot));
  const index = indexTimed.value;
  const reportCases = [];

  for (const item of options.cases) {
    const search = await timed(() => engine.searchCodeWithDiagnostics({
      repoRoot: options.repoRoot,
      query: item.query,
      limit: item.limit,
      mode: item.mode
    }));
    const context = await timed(() => engine.getContext({
      repoRoot: options.repoRoot,
      query: item.query,
      mode: item.mode,
      budgetChars: item.budgetChars
    }));
    reportCases.push(caseReport(item, search, context));
  }

  return {
    schemaVersion: 2,
    benchmark: "ragcode-cli-context",
    startedAt: new Date(options.startedAtMs).toISOString(),
    repoName: options.repoName,
    suite: options.suite,
    repoRoot: options.repoRoot,
    config: options.repoConfig ? {
      configPath: options.configPath,
      localPath: options.repoConfig.localPath,
      cloneUrl: options.repoConfig.cloneUrl,
      branch: options.repoConfig.branch,
      pinnedHead: options.repoConfig.pinnedHead,
      useRepoRuntime: options.repoConfig.useRepoRuntime,
      rationale: options.repoConfig.rationale
    } : undefined,
    env: {
      graph: readGraphRuntimeConfig(process.env, options.args.cwd),
      semantic: readSemanticRuntimeConfig(process.env, options.args.cwd)
    },
    index: indexReport(indexTimed, index, options.args.reuseIndex),
    semanticProfile: await readSemanticProfile(options.args.cwd, process.env.RAGCODE_LANCEDB_URI, process.env.RAGCODE_LANCEDB_TABLE),
    cases: reportCases,
    summary: summaryReport(options.startedAtMs, reportCases)
  };
}

function indexReport(timedIndex: Timed<RepoIndex | IndexStatus>, index: RepoIndex | IndexStatus, reused: boolean): BenchmarkReport["index"] {
  if (isIndexStatus(index)) {
    return {
      reused,
      elapsedMs: timedIndex.elapsedMs,
      projectId: index.projectId,
      files: index.fileCount,
      chunks: index.chunkCount,
      symbols: index.symbolCount,
      edges: index.edgeCount,
      skippedFiles: index.skippedFileCount,
      staleFiles: index.staleFileCount,
      pendingFiles: index.pendingFileCount,
      indexingFiles: index.indexingFileCount
    };
  }
  return {
    reused,
    elapsedMs: timedIndex.elapsedMs,
    projectId: index.projectId,
    files: index.files.length,
    chunks: index.chunks.length,
    symbols: index.symbols.length,
    edges: index.edges.length,
    skippedFiles: index.skippedFiles.length
  };
}

function isIndexStatus(index: RepoIndex | IndexStatus): index is IndexStatus {
  return "fileCount" in index;
}

function caseReport(
  item: BenchmarkCase,
  search: Timed<Awaited<ReturnType<RagCodeEngine["searchCodeWithDiagnostics"]>>>,
  context: Timed<ContextPack>
): BenchmarkReport["cases"][number] {
  const pack = context.value;
  const topologyKeys = pack.topology.map((edge) => [edge.from, edge.to, edge.edge, edge.sourceFile ?? "", edge.targetFile ?? ""].join("\0"));
  const uniqueTopologyCount = new Set(topologyKeys).size;
  const ownerFiles = pack.ownerChain.map((owner) => owner.filePath);
  const expectedOwnerFiles = item.expectedOwnerFiles ?? [];
  const missingOwnerFiles = expectedOwnerFiles.filter((filePath) => !ownerFiles.includes(filePath));
  const ownerRanks = expectedOwnerFiles.map((filePath) => {
    const rank = ownerFiles.indexOf(filePath);
    const oneBasedRank = rank >= 0 ? rank + 1 : null;
    const maxRank = item.maxExpectedOwnerRank ?? null;
    return {
      filePath,
      rank: oneBasedRank,
      maxRank,
      passed: oneBasedRank !== null && (maxRank === null || oneBasedRank <= maxRank)
    };
  });
  const ownerSymbols = pack.ownerChain.map((owner) => ({
    filePath: owner.filePath,
    symbols: owner.symbols.map((symbol) => `${symbol.kind}:${symbol.name}@${symbol.startLine}-${symbol.endLine}`)
  }));
  const ownerSymbolCount = ownerSymbols.reduce((sum, owner) => sum + owner.symbols.length, 0);
  const semanticReasonHitCount = search.value.hits.filter(hasSemanticParticipation).length;
  const topologyDuplicateCount = topologyKeys.length - uniqueTopologyCount;
  const evidenceCounts = evidenceCountsFor(ownerFiles);
  const passed = pack.answerable
    && missingOwnerFiles.length === 0
    && ownerRanks.every((rank) => rank.passed)
    && search.value.diagnostics.semantic.status === "ok"
    && topologyDuplicateCount === 0
    && ownerSymbolCount > 0
    && pack.usedChars <= pack.budgetChars;

  return {
    name: item.name,
    query: item.query,
    mode: item.mode,
    gate: item.gate ?? true,
    search: {
      elapsedMs: search.elapsedMs,
      hitCount: search.value.hits.length,
      topHits: search.value.hits.slice(0, item.limit).map((hit) => ({
        filePath: hit.chunk.filePath,
        startLine: hit.chunk.startLine,
        endLine: hit.chunk.endLine,
        source: hit.source,
        score: hit.score,
        reason: hit.reason
      })),
      semanticReasonHitCount,
      semantic: {
        status: search.value.diagnostics.semantic.status,
        rawHitCount: search.value.diagnostics.semantic.hitCount,
        topNParticipation: search.value.diagnostics.fusion.semanticTopNParticipation,
        error: search.value.diagnostics.semantic.error
      }
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
      ownerSymbols,
      evidenceCounts
    },
    expectations: {
      expectedOwnerFiles,
      missingOwnerFiles,
      ownerRanks,
      passed
    }
  };
}

function summaryReport(started: number, cases: BenchmarkReport["cases"]): BenchmarkReport["summary"] {
  const failedCases = cases.filter((item) => !item.expectations.passed).length;
  const gatedCases = cases.filter((item) => item.gate).length;
  const failedGatedCases = cases.filter((item) => item.gate && !item.expectations.passed).length;
  return {
    totalElapsedMs: Date.now() - started,
    cases: cases.length,
    failedCases,
    gatedCases,
    failedGatedCases,
    maxSearchElapsedMs: Math.max(0, ...cases.map((item) => item.search.elapsedMs)),
    maxContextElapsedMs: Math.max(0, ...cases.map((item) => item.context.elapsedMs)),
    totalTopologyDuplicates: cases.reduce((sum, item) => sum + item.context.topologyDuplicateCount, 0),
    totalOwnerSymbols: cases.reduce((sum, item) => sum + item.context.ownerSymbolCount, 0),
    semanticReasonHitCount: cases.reduce((sum, item) => sum + item.search.semanticReasonHitCount, 0),
    semanticFailedCases: cases.filter((item) => item.search.semantic.status === "failed").length,
    semanticTopNParticipation: cases.reduce((sum, item) => sum + item.search.semantic.topNParticipation, 0),
    passed: failedCases === 0,
    gatePassed: failedGatedCases === 0
  };
}

function matrixReport(
  started: number,
  configPath: string,
  sampleRoot: string,
  suite: BenchmarkSuiteSelection,
  repos: BenchmarkReport[]
): BenchmarkMatrixReport {
  const cases = repos.flatMap((repo) => repo.cases);
  const summary = summaryReport(started, cases);
  return {
    schemaVersion: 2,
    benchmark: "ragcode-cli-context-matrix",
    startedAt: new Date(started).toISOString(),
    configPath,
    sampleRoot,
    suite,
    repos,
    summary: {
      ...summary,
      repos: repos.length,
      failedRepos: repos.filter((repo) => !repo.summary.passed).length,
      failedGateRepos: repos.filter((repo) => !repo.summary.gatePassed).length
    }
  };
}

function evidenceCountsFor(filePaths: string[]): Record<"implementation" | "test" | "docs" | "fixture", number> {
  const counts = { implementation: 0, test: 0, docs: 0, fixture: 0 };
  for (const filePath of filePaths) counts[classifyEvidencePath(filePath)] += 1;
  return counts;
}

function renderMarkdown(report: BenchmarkReport): string {
  const lines = [
    "# RagCode Benchmark",
    "",
    `- startedAt: ${report.startedAt}`,
    `- repoName: ${report.repoName ?? "<ad-hoc>"}`,
    `- suite: ${report.suite ?? "<none>"}`,
    `- repoRoot: ${report.repoRoot}`,
    `- passed: ${report.summary.passed}`,
    `- gatePassed: ${report.summary.gatePassed}`,
    ""
  ];

  if (report.config) {
    lines.push(
      "## Config",
      "",
      `- configPath: ${report.config.configPath ?? "<none>"}`,
      `- cloneUrl: ${report.config.cloneUrl ?? "<none>"}`,
      `- branch: ${report.config.branch ?? "<none>"}`,
      `- pinnedHead: ${report.config.pinnedHead ?? "<none>"}`,
      `- useRepoRuntime: ${report.config.useRepoRuntime ?? false}`,
      `- rationale: ${report.config.rationale ?? "<none>"}`,
      ""
    );
  }

  lines.push(
    "## Index",
    "",
    `- reused: ${report.index.reused}`,
    `- elapsedMs: ${report.index.elapsedMs}`,
    `- files/chunks/symbols/edges: ${report.index.files}/${report.index.chunks}/${report.index.symbols}/${report.index.edges}`,
    `- skippedFiles: ${report.index.skippedFiles}`,
    ...(report.index.reused ? [
      `- staleFiles: ${report.index.staleFiles ?? 0}`,
      `- pendingFiles: ${report.index.pendingFiles ?? 0}`,
      `- indexingFiles: ${report.index.indexingFiles ?? 0}`
    ] : []),
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
    `- failedGatedCases: ${report.summary.failedGatedCases}/${report.summary.gatedCases}`,
    `- maxSearchElapsedMs: ${report.summary.maxSearchElapsedMs}`,
    `- maxContextElapsedMs: ${report.summary.maxContextElapsedMs}`,
    `- totalTopologyDuplicates: ${report.summary.totalTopologyDuplicates}`,
    `- totalOwnerSymbols: ${report.summary.totalOwnerSymbols}`,
    `- semanticReasonHitCount: ${report.summary.semanticReasonHitCount}`,
    `- semanticFailedCases: ${report.summary.semanticFailedCases}`,
    `- semanticTopNParticipation: ${report.summary.semanticTopNParticipation}`,
    "",
    "## Cases",
    ""
  );

  appendCaseMarkdown(lines, report.cases);
  return `${lines.join("\n")}\n`;
}

function renderMatrixMarkdown(report: BenchmarkMatrixReport): string {
  const lines = [
    "# RagCode Benchmark Matrix",
    "",
    `- startedAt: ${report.startedAt}`,
    `- configPath: ${report.configPath}`,
    `- sampleRoot: ${report.sampleRoot}`,
    `- suite: ${report.suite}`,
    `- passed: ${report.summary.passed}`,
    `- gatePassed: ${report.summary.gatePassed}`,
    "",
    "## Summary",
    "",
    `- repos: ${report.summary.repos}`,
    `- failedRepos: ${report.summary.failedRepos}`,
    `- failedGateRepos: ${report.summary.failedGateRepos}`,
    `- failedCases: ${report.summary.failedCases}/${report.summary.cases}`,
    `- failedGatedCases: ${report.summary.failedGatedCases}/${report.summary.gatedCases}`,
    `- maxSearchElapsedMs: ${report.summary.maxSearchElapsedMs}`,
    `- maxContextElapsedMs: ${report.summary.maxContextElapsedMs}`,
    `- totalTopologyDuplicates: ${report.summary.totalTopologyDuplicates}`,
    `- totalOwnerSymbols: ${report.summary.totalOwnerSymbols}`,
    `- semanticReasonHitCount: ${report.summary.semanticReasonHitCount}`,
    `- semanticFailedCases: ${report.summary.semanticFailedCases}`,
    `- semanticTopNParticipation: ${report.summary.semanticTopNParticipation}`,
    "",
    "## Repositories",
    ""
  ];

  for (const repo of report.repos) {
    lines.push(
      `### ${repo.repoName ?? repo.repoRoot}`,
      "",
      `- suite: ${repo.suite ?? "<none>"}`,
      `- repoRoot: ${repo.repoRoot}`,
      `- indexReused: ${repo.index.reused}`,
      `- files/chunks/symbols/edges: ${repo.index.files}/${repo.index.chunks}/${repo.index.symbols}/${repo.index.edges}`,
      `- failedCases: ${repo.summary.failedCases}/${repo.summary.cases}`,
      `- failedGatedCases: ${repo.summary.failedGatedCases}/${repo.summary.gatedCases}`,
      `- gatePassed: ${repo.summary.gatePassed}`,
      ""
    );
    appendCaseMarkdown(lines, repo.cases);
  }

  return `${lines.join("\n")}\n`;
}

function appendCaseMarkdown(lines: string[], cases: BenchmarkReport["cases"]): void {
  for (const item of cases) {
    lines.push(
      `#### ${item.name}`,
      "",
      `- query: ${item.query}`,
      `- gate: ${item.gate}`,
      `- passed: ${item.expectations.passed}`,
      `- searchElapsedMs: ${item.search.elapsedMs}`,
      `- contextElapsedMs: ${item.context.elapsedMs}`,
      `- ownerFiles: ${item.context.ownerFiles.join(", ")}`,
      `- missingOwnerFiles: ${item.expectations.missingOwnerFiles.join(", ") || "none"}`,
      `- ownerRanks: ${item.expectations.ownerRanks.map((rank) => `${rank.filePath}=${rank.rank ?? "missing"}${rank.maxRank ? `<=${rank.maxRank}` : ""}`).join(", ") || "none"}`,
      `- evidenceCounts: implementation=${item.context.evidenceCounts.implementation}, test=${item.context.evidenceCounts.test}, docs=${item.context.evidenceCounts.docs}, fixture=${item.context.evidenceCounts.fixture}`,
      `- semantic: ${item.search.semantic.status}, rawHits=${item.search.semantic.rawHitCount}, topN=${item.search.semantic.topNParticipation}${item.search.semantic.error ? `, error=${item.search.semantic.error}` : ""}`,
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
}

async function writeReportFiles(
  outDir: string,
  started: number,
  report: BenchmarkReport | BenchmarkMatrixReport,
  markdown: string,
  suffix: "benchmark" | "matrix"
): Promise<{ jsonPath: string; mdPath: string; latestJson: string; latestMarkdown: string }> {
  const stamp = timestampForFile(new Date(started));
  const jsonPath = path.join(outDir, `${stamp}.${suffix}.json`);
  const mdPath = path.join(outDir, `${stamp}.${suffix}.md`);
  const latestJson = path.join(outDir, "latest.json");
  const latestMarkdown = path.join(outDir, "latest.md");
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2));
  await fs.writeFile(mdPath, markdown);
  await fs.writeFile(latestJson, JSON.stringify(report, null, 2));
  await fs.writeFile(latestMarkdown, markdown);
  return { jsonPath, mdPath, latestJson, latestMarkdown };
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

async function loadBenchmarkConfig(configPath: string): Promise<BenchmarkConfig> {
  const content = await fs.readFile(configPath, "utf8");
  const config = JSON.parse(content) as BenchmarkConfig;
  if (config.schemaVersion !== 1) throw new Error(`Unsupported benchmark config schemaVersion: ${config.schemaVersion}`);
  if (!Array.isArray(config.repositories) || config.repositories.length === 0) {
    throw new Error(`Benchmark config has no repositories: ${configPath}`);
  }
  return config;
}

function selectRepos(config: BenchmarkConfig, args: BenchmarkArgs, suite: BenchmarkSuiteSelection): BenchmarkRepoConfig[] {
  let repos = config.repositories;
  if (args.repoName) repos = repos.filter((repo) => repo.name === args.repoName);
  if (suite !== "all") repos = repos.filter((repo) => repo.suite === suite);
  if (repos.length === 0) {
    const repoHint = args.repoName ? ` repoName=${args.repoName}` : "";
    throw new Error(`No benchmark repositories matched suite=${suite}${repoHint}`);
  }
  return repos;
}

function selectCases(cases: BenchmarkCase[], args: BenchmarkArgs, scope: string): BenchmarkCase[] {
  let selected = cases;
  if (args.caseName) selected = selected.filter((item) => item.name === args.caseName);
  if (args.gateOnly) selected = selected.filter((item) => item.gate ?? true);
  if (selected.length === 0) {
    const caseHint = args.caseName ? ` case=${args.caseName}` : "";
    const gateHint = args.gateOnly ? " gateOnly=true" : "";
    throw new Error(`No benchmark cases matched ${scope}.${caseHint}${gateHint}`);
  }
  return selected;
}

function selectedSuite(args: BenchmarkArgs, config: BenchmarkConfig): BenchmarkSuiteSelection {
  if (args.all) return "all";
  if (args.suite) return args.suite;
  if (args.repoName) return "all";
  return config.defaultSuite ?? "core";
}

function resolveConfigPath(args: BenchmarkArgs): string {
  const configPath = args.config ?? path.join("benchmarks", "benchmark-repos.json");
  return path.isAbsolute(configPath) ? configPath : path.resolve(args.cwd, configPath);
}

function resolveSampleRoot(cwd: string, config: BenchmarkConfig): string {
  const sampleRoot = process.env.RAGCODE_BENCHMARK_SAMPLE_ROOT ?? config.sampleRoot ?? path.join("..", "ragcode-samples");
  return path.isAbsolute(sampleRoot) ? sampleRoot : path.resolve(cwd, sampleRoot);
}

function createBenchmarkEngine(cwd: string, repoRoot: string, useRepoRuntime: boolean): RagCodeEngine {
  if (!useRepoRuntime) return new RagCodeEngine({ cwd, env: process.env });
  const components = createRuntimeComponentsForRepo({
    cwd: repoRoot,
    env: process.env,
    overrides: { repoRoot }
  });
  return new RagCodeEngine({
    cwd: repoRoot,
    graphStore: components.graphStore,
    semanticStore: components.semanticStore,
    embeddingProvider: components.embeddingProvider
  });
}

function defaultRepoRoot(cwd: string): string {
  const sibling = path.resolve(cwd, "..", "ragcode-samples", "vite");
  return process.env.RAGCODE_BENCHMARK_REPO ?? sibling;
}

function parseArgs(argv: string[]): BenchmarkArgs {
  const parsed: BenchmarkArgs = {
    cwd: process.cwd(),
    assert: false,
    all: false,
    gateOnly: false,
    reuseIndex: false,
    list: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo") parsed.repo = requireValue(argv, ++index, arg);
    else if (arg === "--repo-name") parsed.repoName = requireValue(argv, ++index, arg);
    else if (arg === "--suite") parsed.suite = parseSuite(requireValue(argv, ++index, arg));
    else if (arg === "--config") parsed.config = requireValue(argv, ++index, arg);
    else if (arg === "--out") parsed.out = requireValue(argv, ++index, arg);
    else if (arg === "--case") parsed.caseName = requireValue(argv, ++index, arg);
    else if (arg === "--cwd") parsed.cwd = path.resolve(requireValue(argv, ++index, arg));
    else if (arg === "--assert") parsed.assert = true;
    else if (arg === "--all") parsed.all = true;
    else if (arg === "--gate-only") parsed.gateOnly = true;
    else if (arg === "--reuse-index") parsed.reuseIndex = true;
    else if (arg === "--skip-index") parsed.reuseIndex = true;
    else if (arg === "--list") parsed.list = true;
    else throw new Error(`Unknown benchmark argument: ${arg}`);
  }
  return parsed;
}

function parseSuite(value: string): BenchmarkSuiteSelection {
  if (value === "core" || value === "observation" || value === "project" || value === "all") return value;
  throw new Error(`Invalid --suite value: ${value}. Expected core, observation, project, or all.`);
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) throw new Error(`Missing value for ${flag}`);
  return value;
}

function timestampForFile(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}
