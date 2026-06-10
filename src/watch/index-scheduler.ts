import type { ContextEngine } from "../core/contracts.js";
import type { IndexStatus, RepoIndex, WatcherEventOptions } from "../core/types.js";

export interface WatchIndexSchedulerOptions extends WatcherEventOptions {
  batchDelayMs?: number;
  minQuietMs?: number;
  maxBatchFiles?: number;
  maxRetryAttempts?: number;
  maxRetryDelayMs?: number;
  autoIndex?: boolean;
  onStatus?: (status: WatchIndexSchedulerStatus) => void;
}

export interface WatchIndexSchedulerStatus {
  repoRoot: string;
  running: boolean;
  scheduled: boolean;
  indexing: boolean;
  pendingFiles: number;
  indexingFiles: number;
  lastIndexedAtMs?: number;
  lastError?: string;
}

const DEFAULT_BATCH_DELAY_MS = 750;
const DEFAULT_MIN_QUIET_MS = 250;
const DEFAULT_MAX_BATCH_FILES = 1_000;
const DEFAULT_MAX_RETRY_ATTEMPTS = 5;
const DEFAULT_MAX_RETRY_DELAY_MS = 30_000;

export class WatchIndexScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private indexing = false;
  private lastIndexedAtMs: number | undefined;
  private lastError: string | undefined;
  private readonly failureAttemptsByFile = new Map<string, number>();

  constructor(
    private readonly engine: ContextEngine,
    private readonly repoRoot: string,
    private readonly options: WatchIndexSchedulerOptions = {}
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    while (this.indexing) {
      await sleep(25);
    }
    await this.emitStatus();
  }

  schedule(delayMs = this.options.batchDelayMs ?? DEFAULT_BATCH_DELAY_MS): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, delayMs);
    void this.emitStatus(true);
  }

  async flush(): Promise<RepoIndex | undefined> {
    if (!this.running || this.indexing || this.options.autoIndex === false) return undefined;
    this.indexing = true;
    try {
      const status = await this.engine.indexStatus(this.repoRoot);
      const dirtyFiles = dirtyFilesForBatch(status, this.options.maxBatchFiles ?? DEFAULT_MAX_BATCH_FILES);
      if (dirtyFiles.length === 0) {
        this.lastError = undefined;
        return undefined;
      }

      const quietMs = Date.now() - latestDirtySeenAtMs(status);
      if (quietMs < (this.options.minQuietMs ?? DEFAULT_MIN_QUIET_MS)) {
        this.schedule((this.options.minQuietMs ?? DEFAULT_MIN_QUIET_MS) - quietMs);
        return undefined;
      }

      await this.engine.markDirtyFilesIndexing(this.repoRoot, dirtyFiles);
      const index = await this.engine.refreshIndex(this.repoRoot, { affectedFiles: dirtyFiles });
      this.lastIndexedAtMs = index.indexedAtMs;
      this.lastError = undefined;
      for (const filePath of dirtyFiles) this.failureAttemptsByFile.delete(filePath);
      return index;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      await this.requeueIndexingFiles(this.lastError);
      return undefined;
    } finally {
      this.indexing = false;
      await this.emitStatus();
      if (this.running) {
        const status = await this.engine.indexStatus(this.repoRoot).catch(() => undefined);
        if (status && (status.pendingFileCount > 0 || status.indexingFileCount > 0)) this.schedule(this.retryDelayMs(status));
      }
    }
  }

  async status(): Promise<WatchIndexSchedulerStatus> {
    return this.statusFromIndex(await this.engine.indexStatus(this.repoRoot).catch(() => undefined));
  }

  private async requeueIndexingFiles(reason: string): Promise<void> {
    const status = await this.engine.indexStatus(this.repoRoot).catch(() => undefined);
    if (!status?.freshness.indexingFiles.length) return;
    const maxAttempts = this.options.maxRetryAttempts ?? DEFAULT_MAX_RETRY_ATTEMPTS;
    const retryable: string[] = [];
    const deadLetter: string[] = [];
    for (const filePath of status.freshness.indexingFiles) {
      const attempts = (this.failureAttemptsByFile.get(filePath) ?? 0) + 1;
      this.failureAttemptsByFile.set(filePath, attempts);
      if (attempts >= maxAttempts) deadLetter.push(filePath);
      else retryable.push(filePath);
    }
    if (deadLetter.length > 0) {
      await this.engine.markDirtyFilesDeadLetter(this.repoRoot, deadLetter, `background indexing failed ${maxAttempts} times: ${reason}`);
      // Drop dead-lettered files from the attempt counter so it can't grow unbounded over a long watch.
      for (const filePath of deadLetter) this.failureAttemptsByFile.delete(filePath);
    }
    if (retryable.length > 0) await this.engine.recordFileEvents(this.repoRoot, retryable, this.options);
  }

  private retryDelayMs(status: IndexStatus): number {
    const attempts = maxRetryAttemptsForFiles(this.failureAttemptsByFile, [...status.freshness.pendingFiles, ...status.freshness.indexingFiles]);
    if (attempts === 0) return this.options.batchDelayMs ?? DEFAULT_BATCH_DELAY_MS;
    const baseDelay = this.options.batchDelayMs ?? DEFAULT_BATCH_DELAY_MS;
    const delay = baseDelay * 2 ** Math.max(0, attempts - 1);
    return Math.min(delay, this.options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS);
  }

  private async emitStatus(scheduled = Boolean(this.timer)): Promise<void> {
    if (!this.options.onStatus) return;
    this.options.onStatus(await this.statusFromIndex(await this.engine.indexStatus(this.repoRoot).catch(() => undefined), scheduled));
  }

  private statusFromIndex(status: IndexStatus | undefined, scheduled = Boolean(this.timer)): WatchIndexSchedulerStatus {
    return {
      repoRoot: this.repoRoot,
      running: this.running,
      scheduled,
      indexing: this.indexing,
      pendingFiles: status?.pendingFileCount ?? 0,
      indexingFiles: status?.indexingFileCount ?? 0,
      lastIndexedAtMs: this.lastIndexedAtMs,
      lastError: this.lastError
    };
  }
}

function dirtyFilesForBatch(status: IndexStatus, maxBatchFiles: number): string[] {
  return [...new Set([...status.freshness.pendingFiles, ...status.freshness.indexingFiles])].sort().slice(0, maxBatchFiles);
}

function latestDirtySeenAtMs(status: IndexStatus): number {
  let latest = 0;
  for (const file of status.freshness.dirtyFiles) {
    if (file.lastSeenAtMs > latest) latest = file.lastSeenAtMs;
  }
  return latest;
}

function maxRetryAttemptsForFiles(attemptsByFile: Map<string, number>, filePaths: string[]): number {
  let maxAttempts = 0;
  for (const filePath of filePaths) {
    const attempts = attemptsByFile.get(filePath) ?? 0;
    if (attempts > maxAttempts) maxAttempts = attempts;
  }
  return maxAttempts;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
