import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import type { ContextEngine } from "../core/contracts.js";
import { shouldIgnoreDirectory, shouldIgnoreFile } from "../indexing/ignore-policy.js";
import { createIndexProgressRecorder } from "../indexing/index-progress-state.js";
import { indexRepoWithBootstrapBatch } from "../indexing/batch-bootstrap.js";
import { normalizeRepoPath, normalizeUserPath } from "../utils/path.js";
import { FileEventJournal, type WatchEventJournalEntry } from "./event-journal.js";
import { WatchIndexScheduler, type WatchIndexSchedulerOptions, type WatchIndexSchedulerStatus } from "./index-scheduler.js";
import {
  acquireWatcherLock,
  clearHeartbeat,
  isWatcherLockOwner,
  startHeartbeatKeepalive,
  writeHeartbeat,
  type HeartbeatKeepaliveHandle,
  type WatcherHeartbeat,
  type WatcherLockHandle
} from "./watcher-liveness.js";

export interface FileWatchDaemonOptions extends Omit<WatchIndexSchedulerOptions, "onStatus"> {
  awaitWriteFinishMs?: number;
  pollIntervalMs?: number;
  usePolling?: boolean;
  flushEventsMs?: number;
  maxBufferedEvents?: number;
  maxFlushWaitMs?: number;
  flushRetryMaxDelayMs?: number;
  maxFileBytes?: number;
  maxAnalysisMemoryMb?: number;
  indexOnStart?: boolean;
  /** Interval for refreshing the on-disk heartbeat even when idle. Defaults to 10s. */
  heartbeatIntervalMs?: number;
  /**
   * Acquire the per-repo watcher lock on start (refusing if another live watcher holds it) and
   * publish a heartbeat file. Defaults to true. Set false for embedded/in-process usage where
   * no cross-process coordination is needed (e.g. the dashboard's observation daemon).
   */
  manageLifecycleFiles?: boolean;
  /**
   * Pre-acquired lifecycle lock. Used by CLI entrypoints that must reject duplicate launches
   * before opening SQLite/LanceDB handles.
   */
  lifecycleLockHandle?: WatcherLockHandle;
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
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 100;

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
  private lockHandle: WatcherLockHandle | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private heartbeatKeepalive: HeartbeatKeepaliveHandle | undefined;
  private readonly heartbeatWrites = new Set<Promise<void>>();
  private heartbeatEpoch = 0;
  private lastIndexedAtMs: number | undefined;

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
        if (status.lastIndexedAtMs) this.lastIndexedAtMs = status.lastIndexedAtMs;
        options.onStatus?.({
          repoRoot: this.repoRoot,
          running: this.running,
          ready: this.ready,
          bufferedEvents: this.bufferedPaths.size,
          scheduler: status
        });
        // Refresh the heartbeat on every scheduler tick so an actively-indexing daemon publishes
        // freshness faster than the idle interval, and so pending/indexing counts stay current.
        if (this.running && this.options.manageLifecycleFiles !== false) this.queueHeartbeat();
      }
    });
  }

  async start(): Promise<void> {
    if (this.running) return;
    // Acquire the per-repo lock first, before any indexing work, so a second watcher on the same
    // repo fails fast (throwing WatcherLockError) instead of racing the live one as a second writer.
    if (this.options.manageLifecycleFiles !== false) {
      this.lockHandle = this.options.lifecycleLockHandle ?? acquireWatcherLock(this.repoRoot);
    }
    this.running = true;
    this.heartbeatEpoch += 1;
    this.startHeartbeat();
    await this.ensureIndexed();
    await this.replayJournal();
    this.scheduler.start();
    this.watcher = chokidar.watch(this.repoRoot, {
      cwd: this.repoRoot,
      persistent: true,
      ignoreInitial: true,
      followSymlinks: false,
      usePolling: this.options.usePolling,
      ...(this.options.usePolling
        ? { interval: this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS }
        : this.options.pollIntervalMs !== undefined
          ? { interval: this.options.pollIntervalMs }
          : {}),
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
    this.heartbeatEpoch += 1;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.maxFlushTimer) clearTimeout(this.maxFlushTimer);
    if (this.flushRetryTimer) clearTimeout(this.flushRetryTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatKeepalive?.stop();
    this.flushTimer = undefined;
    this.maxFlushTimer = undefined;
    this.flushRetryTimer = undefined;
    this.heartbeatTimer = undefined;
    this.heartbeatKeepalive = undefined;
    await this.watcher?.close();
    this.watcher = undefined;
    try {
      await this.flushBufferedEvents();
      await this.journalQueue;
    } finally {
      await this.scheduler.stop();
      this.ready = false;
      await this.emitStatus();
      // Tear down lifecycle files last, after the scheduler has drained, so a reader never sees
      // a cleared heartbeat while the daemon is still writing the index. Clear the heartbeat
      // before releasing the lock so the window where the lock exists without a heartbeat
      // (which a reader would classify as "dead") is as small as possible.
      //
      // Only touch lifecycle files if WE own the lock. A second watcher that failed to acquire the
      // lock (start() threw) reaches stop() via the CLI's shutdown path with lockHandle undefined —
      // it must NOT clear the live watcher's heartbeat or release its lock. Likewise, a formerly
      // live watcher that lost ownership must not clear the newer owner's heartbeat.
      if (this.options.manageLifecycleFiles !== false && this.lockHandle) {
        await Promise.allSettled([...this.heartbeatWrites]);
        if (isWatcherLockOwner(this.repoRoot, this.lockHandle.info)) {
          await clearHeartbeat(this.repoRoot).catch(() => undefined);
        }
        this.lockHandle.release();
        this.lockHandle = undefined;
      }
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

  // Publish a fresh heartbeat immediately, then on a fixed interval so doctor/dashboard/MCP can
  // distinguish a live-but-idle daemon from a dead one even when no file events are flowing. The
  // scheduler's own onStatus callback also refreshes the heartbeat on every tick (see constructor),
  // so an actively-indexing daemon heartbeats more often than the interval.
  private startHeartbeat(): void {
    if (this.options.manageLifecycleFiles === false) return;
    if (this.lockHandle) {
      this.heartbeatKeepalive = startHeartbeatKeepalive(
        this.repoRoot,
        this.lockHandle.info,
        this.options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
      );
    }
    this.queueHeartbeat();
    const interval = this.options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.heartbeatTimer = setInterval(() => {
      this.queueHeartbeat();
    }, interval);
    this.heartbeatTimer.unref?.();
  }

  private queueHeartbeat(): void {
    const epoch = this.heartbeatEpoch;
    const write = this.publishHeartbeat(epoch).finally(() => {
      this.heartbeatWrites.delete(write);
    });
    this.heartbeatWrites.add(write);
  }

  private async publishHeartbeat(epoch: number): Promise<void> {
    const lockHandle = this.lockHandle;
    if (this.options.manageLifecycleFiles === false || !lockHandle || !this.running || epoch !== this.heartbeatEpoch) return;
    if (!isWatcherLockOwner(this.repoRoot, lockHandle.info)) {
      this.setLastError("Watcher lock ownership lost; shutting down this stale watcher.");
      void this.stop().catch((error: unknown) => {
        this.setLastError(error);
      });
      return;
    }
    const baseHeartbeat: WatcherHeartbeat = {
      pid: lockHandle.info.pid,
      hostname: lockHandle.info.hostname,
      repoRoot: this.repoRoot,
      startedAtMs: lockHandle.info.startedAtMs,
      lastHeartbeatMs: Date.now(),
      lastIndexedAtMs: this.lastIndexedAtMs,
      pendingFiles: 0,
      indexingFiles: 0,
      ready: this.ready,
      lastError: this.lastError
    };
    await writeHeartbeat(this.repoRoot, baseHeartbeat).catch((error: unknown) => {
      this.setLastError(error);
    });
    const scheduler = await withTimeout(this.scheduler.status(), 500).catch(() => undefined);
    if (!this.running || epoch !== this.heartbeatEpoch || this.lockHandle !== lockHandle) return;
    if (!isWatcherLockOwner(this.repoRoot, lockHandle.info)) {
      this.setLastError("Watcher lock ownership lost; shutting down this stale watcher.");
      void this.stop().catch((error: unknown) => {
        this.setLastError(error);
      });
      return;
    }
    if (scheduler?.lastIndexedAtMs) this.lastIndexedAtMs = scheduler.lastIndexedAtMs;
    const heartbeat: WatcherHeartbeat = {
      pid: lockHandle.info.pid,
      hostname: lockHandle.info.hostname,
      repoRoot: this.repoRoot,
      startedAtMs: lockHandle.info.startedAtMs,
      lastHeartbeatMs: Date.now(),
      lastIndexedAtMs: this.lastIndexedAtMs,
      pendingFiles: scheduler?.pendingFiles ?? 0,
      indexingFiles: scheduler?.indexingFiles ?? 0,
      ready: this.ready,
      lastError: this.lastError ?? scheduler?.lastError
    };
    await writeHeartbeat(this.repoRoot, heartbeat).catch((error: unknown) => {
      // A heartbeat write failure shouldn't take down the watcher; surface it as lastError.
      this.setLastError(error);
    });
  }

  private async ensureIndexed(): Promise<void> {
    if (this.options.indexOnStart === false) {
      await this.engine.indexStatus(this.repoRoot);
      return;
    }
    try {
      await this.engine.indexStatus(this.repoRoot);
    } catch {
      await this.bootstrapInitialIndexBatch();
    }
  }

  private async bootstrapInitialIndexBatch(): Promise<void> {
    const progress = createIndexProgressRecorder(this.repoRoot);
    try {
      await indexRepoWithBootstrapBatch(this.engine, this.repoRoot, {
        maxBatchFiles: this.options.maxBatchFiles,
        maxFileBytes: this.options.maxFileBytes,
        maxAnalysisMemoryMb: this.options.maxAnalysisMemoryMb,
        disableSemanticOnBootstrap: true,
        onProgress: progress.onProgress
      });
      await progress.flush();
    } catch (error) {
      await progress.recordFailure(error);
      throw error;
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

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
