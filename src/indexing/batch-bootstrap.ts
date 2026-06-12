import type { ContextEngine } from "../core/contracts.js";
import type { IndexProgressEvent, IndexRefreshOptions, RepoIndex } from "../core/types.js";
import { listIndexableFilePaths } from "./scanner.js";

export const DEFAULT_BOOTSTRAP_BATCH_FILES = 1_000;

export interface BatchBootstrapOptions extends Pick<IndexRefreshOptions, "maxAnalysisMemoryMb" | "disableSemanticOnBootstrap"> {
  maxBatchFiles?: number;
  maxFileBytes?: number;
  onProgress?: (event: IndexProgressEvent) => void;
}

export async function indexRepoWithBootstrapBatch(
  engine: ContextEngine,
  repoRoot: string,
  options: BatchBootstrapOptions = {}
): Promise<RepoIndex> {
  const existing = await engine.indexStatus(repoRoot).catch(() => undefined);
  if (existing && existing.fileCount > 0) {
    if (existing.pendingFileCount > 0) {
      const batchSize = options.maxBatchFiles ?? DEFAULT_BOOTSTRAP_BATCH_FILES;
      const pendingBatch = existing.freshness.pendingFiles.slice(0, batchSize);
      if (pendingBatch.length > 0) {
        return engine.indexRepo(repoRoot, {
          ...indexOptions(options),
          affectedFiles: pendingBatch
        });
      }
    }
    return engine.indexRepo(repoRoot, indexOptions(options));
  }

  options.onProgress?.({ phase: "scanning_inventory", message: "Scanning repository inventory", ...memoryStats() });
  const inventory = await listIndexableFilePaths(repoRoot, { maxFileBytes: options.maxFileBytes });
  const batchSize = options.maxBatchFiles ?? DEFAULT_BOOTSTRAP_BATCH_FILES;
  const firstBatch = inventory.filePaths.slice(0, batchSize);
  const remaining = inventory.filePaths.slice(batchSize);

  if (firstBatch.length === 0) return engine.indexRepo(repoRoot, indexOptions(options));

  const index = await engine.indexRepo(repoRoot, {
    ...indexOptions(options),
    affectedFiles: firstBatch
  });
  if (remaining.length > 0) await engine.recordFileEvents(repoRoot, remaining, { maxDirtyFiles: remaining.length });
  return index;
}

function indexOptions(options: BatchBootstrapOptions): IndexRefreshOptions {
  return {
    onProgress: options.onProgress,
    maxAnalysisMemoryMb: options.maxAnalysisMemoryMb,
    disableSemanticOnBootstrap: options.disableSemanticOnBootstrap
  };
}

function memoryStats(): Pick<IndexProgressEvent, "heapUsedMb" | "rssMb"> {
  const usage = process.memoryUsage();
  return {
    heapUsedMb: Math.round(usage.heapUsed / 1024 / 1024),
    rssMb: Math.round(usage.rss / 1024 / 1024)
  };
}
