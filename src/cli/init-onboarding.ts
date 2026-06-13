import path from "node:path";
import { createRuntimeComponentsForRepo } from "../config/runtime-config.js";
import type { ContextEngine } from "../core/contracts.js";
import { RagCodeEngine } from "../core/engine.js";
import type { IndexProgressEvent, IndexStatus, RepoIndex } from "../core/types.js";
import { DEFAULT_BOOTSTRAP_BATCH_FILES, indexRepoWithBootstrapBatch } from "../indexing/batch-bootstrap.js";
import { installWatcherService, type ServiceActionResult } from "../service/service-manager.js";
import { readWatcherLiveness, type WatcherLiveness } from "../watch/watcher-liveness.js";

export const DEFAULT_INIT_WATCHER_WAIT_MS = 15_000;
export const DEFAULT_INIT_WATCHER_POLL_MS = 500;

export interface InitOnboardingOptions {
  repoRoot: string;
  indexNow: boolean;
  installWatcher: boolean;
  maxBatchFiles?: number;
  maxAnalysisMemoryMb?: number;
  poll?: boolean;
  watcherWaitMs?: number;
  watcherPollMs?: number;
  onProgress?: (event: IndexProgressEvent) => void;
  deps?: InitOnboardingDeps;
}

export interface InitOnboardingDeps {
  createEngine?: (repoRoot: string) => { engine: ContextEngine; close: () => void };
  indexRepoWithBootstrapBatch?: typeof indexRepoWithBootstrapBatch;
  installWatcherService?: typeof installWatcherService;
  readWatcherLiveness?: typeof readWatcherLiveness;
  sleep?: (ms: number) => Promise<void>;
}

export interface InitOnboardingResult {
  index?: {
    files: number;
    chunks: number;
    partialBootstrap: boolean;
    semanticDeferred: boolean;
    pendingFiles?: number;
  };
  service?: ServiceActionResult;
  liveness?: WatcherLiveness;
}

export async function runInitOnboarding(options: InitOnboardingOptions): Promise<InitOnboardingResult> {
  const repoRoot = path.resolve(options.repoRoot);
  const deps = options.deps ?? {};
  const result: InitOnboardingResult = {};

  if (options.indexNow) {
    result.index = await runBoundedInitialIndex(repoRoot, options, deps);
  }

  if (options.installWatcher) {
    const install = deps.installWatcherService ?? installWatcherService;
    result.service = await install(repoRoot, {
      extraArgs: watcherExtraArgs(options),
      indexOnStart: false
    });
    if (result.service.ok) {
      result.liveness = await waitForLiveWatcher(repoRoot, options, deps);
    }
  }

  return result;
}

export function printInitOnboardingSummary(result: InitOnboardingResult): void {
  if (result.index) {
    const pending = result.index.pendingFiles === undefined ? "unknown" : String(result.index.pendingFiles);
    console.log(`✅ Initial index batch complete: files=${result.index.files} chunks=${result.index.chunks} pending=${pending}`);
  }

  if (result.service) {
    console.log(result.service.ok ? `👁  ${result.service.message}` : `⚠️  ${result.service.message}`);
  }

  if (result.liveness) {
    const pending = result.liveness.heartbeat?.pendingFiles ?? 0;
    const indexing = result.liveness.heartbeat?.indexingFiles ?? 0;
    console.log(`✅ Watcher liveness: ${result.liveness.state} (${result.liveness.diagnostic}), pending=${pending}, indexing=${indexing}`);
  }
}

async function runBoundedInitialIndex(
  repoRoot: string,
  options: InitOnboardingOptions,
  deps: InitOnboardingDeps
): Promise<NonNullable<InitOnboardingResult["index"]>> {
  const factory = deps.createEngine ?? createDefaultEngine;
  const { engine, close } = factory(repoRoot);
  try {
    const runIndex = deps.indexRepoWithBootstrapBatch ?? indexRepoWithBootstrapBatch;
    const index = await runIndex(engine, repoRoot, {
      maxBatchFiles: options.maxBatchFiles ?? DEFAULT_BOOTSTRAP_BATCH_FILES,
      maxAnalysisMemoryMb: options.maxAnalysisMemoryMb,
      disableSemanticOnBootstrap: true,
      onProgress: options.onProgress
    });
    const status = await engine.indexStatus(repoRoot).catch(() => undefined);
    return indexSummary(index, status);
  } finally {
    close();
  }
}

function createDefaultEngine(repoRoot: string): { engine: RagCodeEngine; close: () => void } {
  const components = createRuntimeComponentsForRepo({ cwd: repoRoot, overrides: { repoRoot } });
  const engine = new RagCodeEngine({
    cwd: repoRoot,
    graphStore: components.graphStore,
    semanticStore: components.semanticStore,
    embeddingProvider: components.embeddingProvider
  });
  return { engine, close: () => engine.close() };
}

function indexSummary(index: RepoIndex, status: IndexStatus | undefined): NonNullable<InitOnboardingResult["index"]> {
  return {
    files: index.files.length,
    chunks: index.chunks.length,
    partialBootstrap: index.partialBootstrap ?? false,
    semanticDeferred: index.semanticDeferred ?? false,
    pendingFiles: status?.pendingFileCount
  };
}

function watcherExtraArgs(options: InitOnboardingOptions): string[] | undefined {
  const args: string[] = [];
  if (options.poll) args.push("--poll");
  if (options.maxBatchFiles !== undefined) args.push("--max-batch-files", String(options.maxBatchFiles));
  if (options.maxAnalysisMemoryMb !== undefined) args.push("--max-analysis-memory-mb", String(options.maxAnalysisMemoryMb));
  return args.length > 0 ? args : undefined;
}

async function waitForLiveWatcher(repoRoot: string, options: InitOnboardingOptions, deps: InitOnboardingDeps): Promise<WatcherLiveness> {
  const read = deps.readWatcherLiveness ?? readWatcherLiveness;
  const sleep = deps.sleep ?? defaultSleep;
  const timeoutMs = options.watcherWaitMs ?? DEFAULT_INIT_WATCHER_WAIT_MS;
  const pollMs = options.watcherPollMs ?? DEFAULT_INIT_WATCHER_POLL_MS;
  const startedAt = Date.now();
  let latest = await read(repoRoot);
  while (latest.state !== "running" && Date.now() - startedAt < timeoutMs) {
    await sleep(pollMs);
    latest = await read(repoRoot);
  }
  return latest;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
