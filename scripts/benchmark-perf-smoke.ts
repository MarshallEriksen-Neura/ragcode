import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

interface MatrixReport {
  repos: Array<{
    repoName?: string;
    index: { reused: boolean };
    summary: {
      gatePassed: boolean;
      semanticFailedCases: number;
    };
  }>;
  summary: {
    totalElapsedMs: number;
    gatePassed: boolean;
    semanticFailedCases: number;
  };
}

const maxElapsedMs = Number(process.env.RAGCODE_BENCHMARK_PERF_MAX_MS ?? 15_000);
const started = Date.now();
const tsxCli = path.resolve(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
const result = spawnSync(process.execPath, [
  tsxCli,
  "scripts/benchmark.ts",
  "--repo-name",
  "hono",
  "--case",
  "hono-compose-middleware",
  "--reuse-index",
  "--assert"
], {
  cwd: process.cwd(),
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"]
});
const elapsedMs = Date.now() - started;

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.status !== 0) {
  process.exitCode = result.status ?? 1;
  const error = result.error ? `: ${result.error.message}` : "";
  throw new Error(`benchmark smoke command failed with status ${result.status ?? "unknown"}${error}`);
}

const reportPath = path.resolve(process.cwd(), ".ragcode", "benchmarks", "latest.json");
const report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as MatrixReport;
const repo = report.repos[0];
const failures: string[] = [];

if (!repo?.index.reused) failures.push("benchmark did not reuse an existing index");
if (!report.summary.gatePassed || !repo.summary.gatePassed) failures.push("gated benchmark smoke did not pass");
if (report.summary.semanticFailedCases !== 0 || repo.summary.semanticFailedCases !== 0) failures.push("semantic search had failed cases");
if (elapsedMs > maxElapsedMs) failures.push(`wall time ${elapsedMs}ms exceeded ${maxElapsedMs}ms`);
if (report.summary.totalElapsedMs > maxElapsedMs) failures.push(`reported benchmark time ${report.summary.totalElapsedMs}ms exceeded ${maxElapsedMs}ms`);

const summary = {
  ok: failures.length === 0,
  elapsedMs,
  reportedElapsedMs: report.summary.totalElapsedMs,
  maxElapsedMs,
  repoName: repo.repoName,
  indexReused: repo.index.reused,
  gatePassed: report.summary.gatePassed,
  semanticFailedCases: report.summary.semanticFailedCases,
  failures
};
console.log(JSON.stringify(summary, null, 2));

if (failures.length > 0) {
  process.exitCode = 1;
}
