import type { ContextEngine } from "../core/contracts.js";
import type { IndexStatus, RepoIndex, WatcherEventOptions } from "../core/types.js";

export interface WatchIndexSchedulerOptions extends WatcherEventOptions {
  batchDelayMs?: number;
  minQuietMs?: number;
  maxBatchFiles?: number;
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

export class WatchIndexScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private indexing = false;
  private lastIndexedAtMs: number | undefined;
  private lastError: string | undefined;

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

      const quietMs = Date.now() - Math.max(...status.freshness.dirtyFiles.map((file) => file.lastSeenAtMs), 0);
      if (quietMs < (this.options.minQuietMs ?? DEFAULT_MIN_QUIET_MS)) {
        this.schedule((this.options.minQuietMs ?? DEFAULT_MIN_QUIET_MS) - quietMs);
        return undefined;
      }

      await this.engine.markDirtyFilesIndexing(this.repoRoot, dirtyFiles);
      const index = await this.engine.refreshIndex(this.repoRoot);
      this.lastIndexedAtMs = index.indexedAtMs;
      this.lastError = undefined;
      return index;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      await this.requeueIndexingFiles();
      return undefined;
    } finally {
      this.indexing = false;
      await this.emitStatus();
      if (this.running) {
        const status = await this.engine.indexStatus(this.repoRoot).catch(() => undefined);
        if (status && (status.pendingFileCount > 0 || status.indexingFileCount > 0)) this.schedule();
      }
    }
  }

  async status(): Promise<WatchIndexSchedulerStatus> {
    return this.statusFromIndex(await this.engine.indexStatus(this.repoRoot).catch(() => undefined));
  }

  private async requeueIndexingFiles(): Promise<void> {
    const status = await this.engine.indexStatus(this.repoRoot).catch(() => undefined);
    if (!status?.freshness.indexingFiles.length) return;
    await this.engine.recordFileEvents(this.repoRoot, status.freshness.indexingFiles, this.options);
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
