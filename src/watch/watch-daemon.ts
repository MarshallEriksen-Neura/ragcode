import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import type { ContextEngine } from "../core/contracts.js";
import { shouldIgnoreDirectory, shouldIgnoreFile } from "../indexing/ignore-policy.js";
import { normalizeRepoPath, normalizeUserPath } from "../utils/path.js";
import { FileEventJournal, type WatchEventJournalEntry } from "./event-journal.js";
import { WatchIndexScheduler, type WatchIndexSchedulerOptions, type WatchIndexSchedulerStatus } from "./index-scheduler.js";

export interface FileWatchDaemonOptions extends Omit<WatchIndexSchedulerOptions, "onStatus"> {
  awaitWriteFinishMs?: number;
  pollIntervalMs?: number;
  usePolling?: boolean;
  flushEventsMs?: number;
  maxBufferedEvents?: number;
  maxFlushWaitMs?: number;
  flushRetryMaxDelayMs?: number;
  maxFileBytes?: number;
  indexOnStart?: boolean;
  journal?: FileEventJournal;
  onEvent?: (event: WatchEventJournalEntry) => void;
  onStatus?: (status: WatchDaemonStatus) => void;
}

export interface WatchDaemonStatus {
  repoRoot: string;
  running: boolean;
  ready: boolean;
  bufferedEvents: number;
  scheduler: WatchIndexSchedulerStatus;
}

const DEFAULT_EVENT_FLUSH_MS = 250;
const DEFAULT_AWAIT_WRITE_FINISH_MS = 500;
const DEFAULT_MAX_FILE_BYTES = 1_000_000;
const DEFAULT_MAX_BUFFERED_EVENTS = 1_000;
const DEFAULT_MAX_FLUSH_WAIT_MS = 5_000;
const DEFAULT_FLUSH_RETRY_MAX_DELAY_MS = 30_000;

export class FileWatchDaemon {
  private watcher: FSWatcher | undefined;
  private readonly journal: FileEventJournal;
  private readonly scheduler: WatchIndexScheduler;
  private readonly repoRoot: string;
  private readonly bufferedPaths = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private maxFlushTimer: ReturnType<typeof setTimeout> | undefined;
  private flushRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private journalQueue: Promise<void> = Promise.resolve();
  private pendingJournalEntries: WatchEventJournalEntry[] = [];
  private firstBufferedAtMs: number | undefined;
  private flushFailureCount = 0;
  private lastError: string | undefined;
  private running = false;
  private ready = false;

  constructor(
    private readonly engine: ContextEngine,
    repoRoot: string,
    private readonly options: FileWatchDaemonOptions = {}
  ) {
    this.repoRoot = path.resolve(repoRoot);
    this.journal = options.journal ?? FileEventJournal.forRepo(this.repoRoot);
    this.scheduler = new WatchIndexScheduler(engine, this.repoRoot, {
      ...options,
      onStatus: (status) => {
        options.onStatus?.({
          repoRoot: this.repoRoot,
          running: this.running,
          ready: this.ready,
          bufferedEvents: this.bufferedPaths.size,
          scheduler: status
        });
      }
    });
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.ensureIndexed();
    await this.replayJournal();
    this.scheduler.start();
    this.watcher = chokidar.watch(this.repoRoot, {
      cwd: this.repoRoot,
      persistent: true,
      ignoreInitial: true,
      followSymlinks: false,
      usePolling: this.options.usePolling,
      interval: this.options.pollIntervalMs,
      atomic: true,
      awaitWriteFinish: {
        stabilityThreshold: this.options.awaitWriteFinishMs ?? DEFAULT_AWAIT_WRITE_FINISH_MS,
        pollInterval: Math.min(100, this.options.awaitWriteFinishMs ?? DEFAULT_AWAIT_WRITE_FINISH_MS)
      },
      ignored: (candidate, stats) => this.isIgnored(candidate, stats)
    });

    this.watcher
      .on("add", (filePath) => this.handleWatchEvent("add", filePath))
      .on("change", (filePath) => this.handleWatchEvent("change", filePath))
      .on("unlink", (filePath) => this.handleWatchEvent("unlink", filePath))
      .on("addDir", (filePath) => this.handleWatchEvent("addDir", filePath))
      .on("unlinkDir", (filePath) => this.handleWatchEvent("unlinkDir", filePath))
      .on("ready", () => {
        this.ready = true;
        void this.emitStatus();
      })
      .on("error", (error) => {
        this.options.onStatus?.({
          repoRoot: this.repoRoot,
          running: this.running,
          ready: this.ready,
          bufferedEvents: this.bufferedPaths.size,
          scheduler: {
            repoRoot: this.repoRoot,
            running: true,
            scheduled: false,
            indexing: false,
            pendingFiles: 0,
            indexingFiles: 0,
            lastError: this.setLastError(error)
          }
        });
      });
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.maxFlushTimer) clearTimeout(this.maxFlushTimer);
    if (this.flushRetryTimer) clearTimeout(this.flushRetryTimer);
    this.flushTimer = undefined;
    this.maxFlushTimer = undefined;
    this.flushRetryTimer = undefined;
    await this.watcher?.close();
    this.watcher = undefined;
    try {
      await this.flushBufferedEvents();
      await this.journalQueue;
    } finally {
      await this.scheduler.stop();
      this.ready = false;
      await this.emitStatus();
    }
  }

  async status(): Promise<WatchDaemonStatus> {
    return {
      repoRoot: this.repoRoot,
      running: this.running,
      ready: this.ready,
      bufferedEvents: this.bufferedPaths.size,
      scheduler: await this.scheduler.status()
    };
  }

  private async ensureIndexed(): Promise<void> {
    if (this.options.indexOnStart === false) {
      await this.engine.indexStatus(this.repoRoot);
      return;
    }
    try {
      await this.engine.indexStatus(this.repoRoot);
    } catch {
      await this.engine.indexRepo(this.repoRoot);
    }
  }

  private async replayJournal(): Promise<void> {
    const replayed = await this.journal.replayPaths();
    if (replayed.length === 0) return;
    await this.engine.recordFileEvents(this.repoRoot, replayed, this.options);
    await this.journal.truncate();
    this.scheduler.schedule(0);
  }

  private handleWatchEvent(event: WatchEventJournalEntry["event"], rawPath: string): void {
    void this.recordEvent(event, rawPath).catch((error: unknown) => {
      this.setLastError(error);
      void this.emitStatus();
    });
  }

  private async recordEvent(event: WatchEventJournalEntry["event"], rawPath: string): Promise<void> {
    const filePath = normalizeWatchPath(this.repoRoot, rawPath);
    if (!filePath) return;
    const entry = { event, filePath, observedAtMs: Date.now() };
    await this.enqueueJournalOperation(async () => {
      this.pendingJournalEntries.push(entry);
      await this.flushJournalEntriesLocked();
      this.options.onEvent?.(entry);
      this.bufferedPaths.add(filePath);
      this.firstBufferedAtMs ??= entry.observedAtMs;
      this.scheduleEventFlush();
    });
  }

  private scheduleEventFlush(): void {
    if (this.bufferedPaths.size >= (this.options.maxBufferedEvents ?? DEFAULT_MAX_BUFFERED_EVENTS)) {
      if (this.flushTimer) clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
      void this.flushBufferedEvents().catch((error: unknown) => {
        this.setLastError(error);
        this.scheduleFlushRetry();
        void this.emitStatus();
      });
      return;
    }
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flushBufferedEvents().catch((error: unknown) => {
        this.setLastError(error);
        this.scheduleFlushRetry();
        void this.emitStatus();
      });
    }, this.options.flushEventsMs ?? DEFAULT_EVENT_FLUSH_MS);
    if (!this.maxFlushTimer) {
      const elapsed = this.firstBufferedAtMs ? Date.now() - this.firstBufferedAtMs : 0;
      this.maxFlushTimer = setTimeout(() => {
        this.maxFlushTimer = undefined;
        if (this.flushTimer) clearTimeout(this.flushTimer);
        this.flushTimer = undefined;
        void this.flushBufferedEvents().catch((error: unknown) => {
          this.setLastError(error);
          this.scheduleFlushRetry();
          void this.emitStatus();
        });
      }, Math.max(0, (this.options.maxFlushWaitMs ?? DEFAULT_MAX_FLUSH_WAIT_MS) - elapsed));
    }
  }

  private async flushBufferedEvents(): Promise<void> {
    await this.enqueueJournalOperation(() => this.flushBufferedEventsLocked());
  }

  private async flushBufferedEventsLocked(): Promise<void> {
    await this.flushJournalEntriesLocked();
    if (this.bufferedPaths.size === 0) return;
    const paths = [...this.bufferedPaths].sort();
    await this.engine.recordFileEvents(this.repoRoot, paths, this.options);
    this.bufferedPaths.clear();
    this.firstBufferedAtMs = undefined;
    this.flushFailureCount = 0;
    if (this.maxFlushTimer) clearTimeout(this.maxFlushTimer);
    if (this.flushRetryTimer) clearTimeout(this.flushRetryTimer);
    this.maxFlushTimer = undefined;
    this.flushRetryTimer = undefined;
    await this.journal.truncate();
    this.lastError = undefined;
    this.scheduler.schedule();
    await this.emitStatus();
  }

  private async flushJournalEntriesLocked(): Promise<void> {
    if (this.pendingJournalEntries.length === 0) return;
    const entries = this.pendingJournalEntries.splice(0);
    try {
      await this.journal.appendBatch(entries);
    } catch (error) {
      this.pendingJournalEntries.unshift(...entries);
      throw error;
    }
  }

  private scheduleFlushRetry(): void {
    if (!this.running || this.flushRetryTimer) return;
    this.flushFailureCount += 1;
    const baseDelay = this.options.flushEventsMs ?? DEFAULT_EVENT_FLUSH_MS;
    const delay = Math.min(baseDelay * 2 ** Math.max(0, this.flushFailureCount - 1), this.options.flushRetryMaxDelayMs ?? DEFAULT_FLUSH_RETRY_MAX_DELAY_MS);
    this.flushRetryTimer = setTimeout(() => {
      this.flushRetryTimer = undefined;
      void this.flushBufferedEvents().catch((error: unknown) => {
        this.setLastError(error);
        this.scheduleFlushRetry();
        void this.emitStatus();
      });
    }, delay);
  }

  private isIgnored(candidate: string, stats?: { isDirectory(): boolean; isFile(): boolean; size: number }): boolean {
    const relative = normalizeWatchPath(this.repoRoot, candidate);
    if (!relative) return false;
    const parts = relative.split("/");
    if (parts.some((part) => shouldIgnoreDirectory(part).ignored)) return true;
    if (stats?.isDirectory()) return false;
    if (stats?.isFile()) return shouldIgnoreFile(relative, this.options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES, stats.size).ignored;
    return false;
  }

  private async emitStatus(): Promise<void> {
    if (!this.options.onStatus) return;
    const status = await this.status();
    if (this.lastError) status.scheduler.lastError = this.lastError;
    this.options.onStatus(status);
  }

  private enqueueJournalOperation(operation: () => Promise<void>): Promise<void> {
    const next = this.journalQueue.then(operation, operation);
    this.journalQueue = next.catch(() => undefined);
    return next;
  }

  private setLastError(error: unknown): string {
    this.lastError = error instanceof Error ? error.message : String(error);
    return this.lastError;
  }
}

function normalizeWatchPath(repoRoot: string, rawPath: string): string | undefined {
  const candidate = rawPath.trim();
  if (!candidate || candidate === ".") return undefined;
  const relative = path.isAbsolute(candidate)
    ? normalizeRepoPath(repoRoot, path.resolve(candidate))
    : normalizeUserPath(candidate);
  if (!relative || relative === "." || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  return relative;
}
