import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RagCodeEngine } from "../src/core/engine.js";
import { InMemorySemanticStore } from "../src/semantic/in-memory-semantic-store.js";
import type { EmbeddingProvider } from "../src/core/contracts.js";
import type { RepoIndex } from "../src/core/types.js";

interface ScenarioMetrics {
  name: string;
  changedFiles: string[];
  refreshedFiles: string[];
  refreshedFileCount: number;
  scannedFiles: string[];
  scannedFileCount: number;
  elapsedMs: number;
  heapDeltaBytes: number;
  embeddingCalls: number;
  maxRefreshedFiles: number;
  maxScannedFiles: number;
  ok: boolean;
  failures: string[];
}

interface StressReport {
  ok: boolean;
  assertMode: boolean;
  repo: {
    totalFiles: number;
    routeCount: number;
    clientCount: number;
    leafCount: number;
  };
  initialIndex: {
    files: number;
    chunks: number;
    symbols: number;
    edges: number;
    elapsedMs: number;
  };
  scenarios: ScenarioMetrics[];
  failures: string[];
}

const assertMode = process.argv.includes("--assert");
const routeCount = positiveInteger(process.env.RAGCODE_STRESS_ROUTE_COUNT, 24);
const clientCount = positiveInteger(process.env.RAGCODE_STRESS_CLIENT_COUNT, 96);
const leafCount = positiveInteger(process.env.RAGCODE_STRESS_LEAF_COUNT, 240);
const maxRouteRefresh = positiveInteger(process.env.RAGCODE_STRESS_MAX_ROUTE_REFRESH, 8);
const maxMiddlewareRefresh = positiveInteger(process.env.RAGCODE_STRESS_MAX_MIDDLEWARE_REFRESH, routeCount + 3);
const maxLeafRefresh = positiveInteger(process.env.RAGCODE_STRESS_MAX_LEAF_REFRESH, 1);
const maxAffectedScan = positiveInteger(process.env.RAGCODE_STRESS_MAX_AFFECTED_SCAN, 1);
const maxScenarioMs = positiveInteger(process.env.RAGCODE_STRESS_MAX_SCENARIO_MS, 7_500);

async function main(): Promise<void> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ragcode-incremental-stress-"));
  try {
    await createSyntheticRepo(tempRoot, { routeCount, clientCount, leafCount });
    const embeddingProvider = new CountingEmbeddingProvider();
    const engine = new RagCodeEngine({
      cwd: tempRoot,
      semanticStore: new InMemorySemanticStore(),
      embeddingProvider
    });

    const initialStarted = Date.now();
    const initialIndex = await engine.indexRepo(tempRoot);
    const initialElapsedMs = Date.now() - initialStarted;

    const scenarios: ScenarioMetrics[] = [];
    scenarios.push(await runScenario({
      name: "route-change",
      root: tempRoot,
      engine,
      embeddingProvider,
      affectedFiles: ["src/app/api/resource-0/route.ts"],
      maxRefreshedFiles: maxRouteRefresh,
      maxScannedFiles: maxAffectedScan,
      mutate: () => writeRepoFile(tempRoot, "src/app/api/resource-0/route.ts", routeFileContent(0, "changed"))
    }));
    scenarios.push(await runScenario({
      name: "middleware-change",
      root: tempRoot,
      engine,
      embeddingProvider,
      affectedFiles: ["src/middleware.ts"],
      maxRefreshedFiles: maxMiddlewareRefresh,
      maxScannedFiles: maxAffectedScan,
      mutate: () => writeRepoFile(tempRoot, "src/middleware.ts", [
        "export function middleware() {",
        "  return new Response('changed');",
        "}"
      ].join("\n"))
    }));
    scenarios.push(await runScenario({
      name: "leaf-change",
      root: tempRoot,
      engine,
      embeddingProvider,
      affectedFiles: ["src/lib/leaf-0.ts"],
      maxRefreshedFiles: maxLeafRefresh,
      maxScannedFiles: maxAffectedScan,
      mutate: () => writeRepoFile(tempRoot, "src/lib/leaf-0.ts", leafFileContent(0, "changed"))
    }));
    scenarios.push(await runScenario({
      name: "route-added",
      root: tempRoot,
      engine,
      embeddingProvider,
      affectedFiles: ["src/app/api/new-resource/route.ts"],
      maxRefreshedFiles: maxRouteRefresh,
      maxScannedFiles: maxAffectedScan,
      mutate: () => writeRepoFile(tempRoot, "src/app/api/new-resource/route.ts", routeFileContent(999, "added"))
    }));
    scenarios.push(await runScenario({
      name: "middleware-added",
      root: tempRoot,
      engine,
      embeddingProvider,
      affectedFiles: ["src/middleware.ts"],
      maxRefreshedFiles: maxMiddlewareRefresh,
      maxScannedFiles: maxAffectedScan,
      mutate: async () => {
        await fs.rm(path.join(tempRoot, "src/middleware.ts"));
        await new Promise((resolve) => setTimeout(resolve, 100));
        await writeRepoFile(tempRoot, "src/middleware.ts", [
          "export function middleware() {",
          "  return Response.next();",
          "}"
        ].join("\n"));
      }
    }));

    engine.close();

    const failures = scenarios.flatMap((scenario) => scenario.failures.map((failure) => `${scenario.name}: ${failure}`));
    const report: StressReport = {
      ok: failures.length === 0,
      assertMode,
      repo: {
        totalFiles: initialIndex.files.length,
        routeCount,
        clientCount,
        leafCount
      },
      initialIndex: {
        files: initialIndex.files.length,
        chunks: initialIndex.chunks.length,
        symbols: initialIndex.symbols.length,
        edges: initialIndex.edges.length,
        elapsedMs: initialElapsedMs
      },
      scenarios,
      failures
    };

    console.log(JSON.stringify(report, null, 2));
    if (assertMode && failures.length > 0) process.exitCode = 1;
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

async function runScenario(input: {
  name: string;
  root: string;
  engine: RagCodeEngine;
  embeddingProvider: CountingEmbeddingProvider;
  affectedFiles: string[];
  maxRefreshedFiles: number;
  maxScannedFiles: number;
  mutate: () => Promise<void>;
}): Promise<ScenarioMetrics> {
  input.embeddingProvider.reset();
  const heapBefore = process.memoryUsage().heapUsed;
  await input.mutate();
  const started = Date.now();
  const index = await input.engine.indexRepo(input.root, { affectedFiles: input.affectedFiles });
  const elapsedMs = Date.now() - started;
  const heapDeltaBytes = Math.max(0, process.memoryUsage().heapUsed - heapBefore);
  const refreshedFiles = [...(index.refreshedFiles ?? index.changedFiles)].sort();
  const scannedFiles = [...(index.scannedFiles ?? [])].sort();
  const failures = scenarioFailures(index, refreshedFiles, scannedFiles, input.maxRefreshedFiles, input.maxScannedFiles, elapsedMs);
  return {
    name: input.name,
    changedFiles: index.changedFiles,
    refreshedFiles,
    refreshedFileCount: refreshedFiles.length,
    scannedFiles,
    scannedFileCount: scannedFiles.length,
    elapsedMs,
    heapDeltaBytes,
    embeddingCalls: input.embeddingProvider.callCount,
    maxRefreshedFiles: input.maxRefreshedFiles,
    maxScannedFiles: input.maxScannedFiles,
    ok: failures.length === 0,
    failures
  };
}

function scenarioFailures(index: RepoIndex, refreshedFiles: string[], scannedFiles: string[], maxRefreshedFiles: number, maxScannedFiles: number, elapsedMs: number): string[] {
  const failures: string[] = [];
  if (index.changedFiles.length !== 1) failures.push(`expected exactly one changed file, got ${index.changedFiles.length}`);
  if (refreshedFiles.length > maxRefreshedFiles) failures.push(`refreshed ${refreshedFiles.length} files, max ${maxRefreshedFiles}`);
  if (scannedFiles.length > maxScannedFiles) failures.push(`scanned ${scannedFiles.length} files, max ${maxScannedFiles}`);
  if (elapsedMs > maxScenarioMs) failures.push(`elapsed ${elapsedMs}ms exceeded ${maxScenarioMs}ms`);
  if (refreshedFiles.length > Math.max(1, Math.ceil(index.files.length * 0.1))) failures.push(`refreshed set ${refreshedFiles.length}/${index.files.length} looks like broad invalidation`);
  return failures;
}

async function createSyntheticRepo(root: string, options: { routeCount: number; clientCount: number; leafCount: number }): Promise<void> {
  await writeFile("src/middleware.ts", [
    "export function middleware() {",
    "  return Response.next();",
    "}"
  ].join("\n"));

  for (let index = 0; index < options.routeCount; index += 1) {
    await writeFile(`src/app/api/resource-${index}/route.ts`, routeFileContent(index, "initial"));
  }

  for (let index = 0; index < options.clientCount; index += 1) {
    const routeIndex = index % options.routeCount;
    await writeFile(`src/app/client/Client${index}.tsx`, [
      "\"use client\";",
      "",
      `export function Client${index}() {`,
      `  async function load() {`,
      `    await fetch('/api/resource-${routeIndex}', { method: 'POST' });`,
      "  }",
      `  return <button onClick={load}>Load ${index}</button>;`,
      "}"
    ].join("\n"));
  }

  for (let index = 0; index < options.leafCount; index += 1) {
    await writeFile(`src/lib/leaf-${index}.ts`, leafFileContent(index, "initial"));
  }

  async function writeFile(relativePath: string, content: string): Promise<void> {
    await writeRepoFile(root, relativePath, content);
  }
}

async function writeRepoFile(root: string, relativePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
  await fs.writeFile(path.join(root, relativePath), `${content}\n`);
}

function routeFileContent(index: number, marker: string): string {
  return [
    `export async function POST() {`,
    `  return Response.json({ resource: ${index}, marker: '${marker}' });`,
    "}"
  ].join("\n");
}

function leafFileContent(index: number, marker: string): string {
  return [
    `export function leaf${index}() {`,
    `  return '${marker}-${index}';`,
    "}"
  ].join("\n");
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Invalid positive integer: ${value}`);
  return parsed;
}

class CountingEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = 8;
  callCount = 0;

  reset(): void {
    this.callCount = 0;
  }

  async embed(text: string): Promise<number[]> {
    this.callCount += 1;
    return vectorFor(text, this.dimensions);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    this.callCount += texts.length;
    return texts.map((text) => vectorFor(text, this.dimensions));
  }
}

function vectorFor(text: string, dimensions: number): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  for (let index = 0; index < text.length; index += 1) {
    vector[index % dimensions]! += text.charCodeAt(index) / 255;
  }
  return vector;
}

await main();
