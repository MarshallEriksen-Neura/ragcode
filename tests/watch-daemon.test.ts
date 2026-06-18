import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContextEngine } from "../src/core/contracts.js";
import type {
  CodeChunk,
  CodeFile,
  ContextPack,
  ContextRequest,
  DiffReview,
  FreshnessReport,
  GraphEdge,
  ImpactAnalysis,
  IndexRefreshOptions,
  IndexStatus,
  OwnerCandidate,
  RelatedTests,
  RepoIndex,
  SearchHit,
  SearchQuery,
  SymbolNode,
  TopologyMap,
  TopologyMapRequest,
  TraceFlow,
  VerifiedCodeSubgraph,
  VerifiedSubgraphRequest,
  WatcherEventOptions,
  WatcherState
} from "../src/core/types.js";
import { FileEventJournal, type WatchEventJournalEntry } from "../src/watch/event-journal.js";
import { coalesceFileEvents } from "../src/watch/file-event-coalescer.js";
import { WatchIndexScheduler } from "../src/watch/index-scheduler.js";
import { FileWatchDaemon } from "../src/watch/watch-daemon.js";
import {
  readWatcherLiveness,
  watcherHeartbeatPath,
  watcherLockPath,
  writeHeartbeat,
  type WatcherHeartbeat,
  type WatcherLockInfo
} from "../src/watch/watcher-liveness.js";

const tempRoots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const root of tempRoots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe("file watch daemon", () => {
  it("replays a durable event journal into dirty state on startup", async () => {
    const root = await createTempRepo("ragcode-watch-replay-");
    const journal = FileEventJournal.forRepo(root);
    await journal.append({ event: "change", filePath: "src/a.ts", observedAtMs: 100 });
    await journal.append({ event: "add", filePath: path.join(root, "src", "b.ts"), observedAtMs: 200 });

    const engine = new FakeEngine(root);
    const daemon = new FileWatchDaemon(engine, root, {
      autoIndex: false,
      indexOnStart: false,
      journal
    });

    await daemon.start();
    await daemon.stop();

    expect(engine.recordedBatches).toEqual([["src/a.ts", "src/b.ts"]]);
    expect(await journal.replay()).toEqual([]);
  });

  it("records chokidar file events, flushes them as one dirty batch, and clears the journal", async () => {
    const root = await createTempRepo("ragcode-watch-chokidar-");
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "watched.ts"), "export const value = 1;\n");

    const journal = FileEventJournal.forRepo(root);
    const engine = new FakeEngine(root);
    const events: WatchEventJournalEntry[] = [];
    const daemon = new FileWatchDaemon(engine, root, {
      autoIndex: false,
      indexOnStart: false,
      flushEventsMs: 20,
      awaitWriteFinishMs: 10,
      pollIntervalMs: 20,
      usePolling: true,
      journal,
      onEvent: (event) => events.push(event)
    });

    await daemon.start();
    await waitFor(async () => (await daemon.status()).ready);
    await fs.writeFile(path.join(root, "src", "watched.ts"), "export const value = 2;\n");

    await waitFor(() => engine.recordedBatches.some((batch) => batch.includes("src/watched.ts")), 3_000);
    await daemon.stop();

    expect(events.map((event) => event.filePath)).toContain("src/watched.ts");
    expect(engine.recordedBatches.flat()).toContain("src/watched.ts");
    expect(await journal.replay()).toEqual([]);
  });

  it("does not record file events ignored by the repository .gitignore", async () => {
    const root = await createTempRepo("ragcode-watch-gitignore-");
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.mkdir(path.join(root, ".omc"), { recursive: true });
    await fs.writeFile(path.join(root, ".gitignore"), ".omc/\n");
    await fs.writeFile(path.join(root, "src", "tracked.ts"), "export const value = 1;\n");

    const engine = new FakeEngine(root);
    const daemon = new FileWatchDaemon(engine, root, {
      autoIndex: false,
      indexOnStart: false,
      flushEventsMs: 20,
      awaitWriteFinishMs: 10,
      pollIntervalMs: 20,
      usePolling: true
    });

    await daemon.start();
    await waitFor(async () => (await daemon.status()).ready);
    await fs.writeFile(path.join(root, ".omc", "session.json"), "{\"runtime\":true}\n");
    await fs.writeFile(path.join(root, "src", "tracked.ts"), "export const value = 2;\n");

    await waitFor(() => engine.recordedBatches.some((batch) => batch.includes("src/tracked.ts")), 3_000);
    await daemon.stop();

    expect(engine.recordedBatches.flat()).toContain("src/tracked.ts");
    expect(engine.recordedBatches.flat()).not.toContain(".omc/session.json");
  });

  it("filters gitignored paths before writing the dirty-file queue", async () => {
    const root = await createTempRepo("ragcode-watch-record-gitignore-");
    await fs.writeFile(path.join(root, ".gitignore"), ".omc/\n");
    await fs.mkdir(path.join(root, ".omc"), { recursive: true });
    await fs.mkdir(path.join(root, "src"), { recursive: true });

    const coalesced = coalesceFileEvents(root, [".omc/session.json", "src/tracked.ts"]);

    expect(coalesced.dirtyFiles).toEqual(["src/tracked.ts"]);
  });

  it("uses a numeric polling interval default when polling is enabled", async () => {
    const root = await createTempRepo("ragcode-watch-poll-default-");
    await fs.writeFile(path.join(root, "watched.ts"), "export const value = 1;\n");
    const engine = new FakeEngine(root);
    const daemon = new FileWatchDaemon(engine, root, {
      autoIndex: false,
      indexOnStart: false,
      usePolling: true,
      flushEventsMs: 20,
      awaitWriteFinishMs: 10
    });

    await daemon.start();
    await waitFor(async () => (await daemon.status()).ready);
    await fs.writeFile(path.join(root, "watched.ts"), "export const value = 2;\n");
    await waitFor(() => engine.recordedBatches.some((batch) => batch.includes("watched.ts")), 3_000);
    await daemon.stop();

    expect(engine.recordedBatches.flat()).toContain("watched.ts");
  });

  it("starts the native watcher without an explicit polling interval", async () => {
    const root = await createTempRepo("ragcode-watch-native-default-");
    await fs.writeFile(path.join(root, "watched.ts"), "export const value = 1;\n");
    const engine = new FakeEngine(root);
    const daemon = new FileWatchDaemon(engine, root, {
      autoIndex: false,
      indexOnStart: false,
      flushEventsMs: 20,
      awaitWriteFinishMs: 10
    });

    await daemon.start();
    await waitFor(async () => (await daemon.status()).ready);
    await fs.writeFile(path.join(root, "watched.ts"), "export const value = 2;\n");
    await waitFor(() => engine.recordedBatches.some((batch) => batch.includes("watched.ts")), 3_000);
    await daemon.stop();

    expect(engine.recordedBatches.flat()).toContain("watched.ts");
  });

  it("publishes a heartbeat even when startup status reads are slow", async () => {
    const root = await createTempRepo("ragcode-watch-start-heartbeat-");
    await fs.writeFile(path.join(root, "watched.ts"), "export const value = 1;\n");
    const engine = new FakeEngine(root);
    engine.blockIndexStatus = true;
    const daemon = new FileWatchDaemon(engine, root, {
      autoIndex: false,
      indexOnStart: false,
      heartbeatIntervalMs: 20,
      awaitWriteFinishMs: 10
    });

    const startPromise = daemon.start();
    await waitFor(async () => (await readWatcherLiveness(root)).state === "running", 1_000);
    engine.releaseIndexStatus();
    await startPromise;
    await daemon.stop();

    expect((await readWatcherLiveness(root)).state).toBe("not_running");
  });

  it("stops itself when it loses ownership of the watcher lock", async () => {
    const root = await createTempRepo("ragcode-watch-lock-lost-");
    const engine = new FakeEngine(root);
    const daemon = new FileWatchDaemon(engine, root, {
      autoIndex: false,
      indexOnStart: false,
      heartbeatIntervalMs: 20,
      awaitWriteFinishMs: 10
    });

    await daemon.start();
    await waitFor(async () => (await readWatcherLiveness(root)).state === "running", 1_000);

    const replacement = replacementLockInfo(root);
    await fs.writeFile(watcherLockPath(root), `${JSON.stringify(replacement, null, 2)}\n`, "utf8");

    await waitFor(async () => !(await daemon.status()).running, 1_000);

    expect((await daemon.status()).running).toBe(false);
  });

  it("does not clear the replacement watcher's heartbeat after losing lock ownership", async () => {
    const root = await createTempRepo("ragcode-watch-lock-lost-heartbeat-");
    const engine = new FakeEngine(root);
    const daemon = new FileWatchDaemon(engine, root, {
      autoIndex: false,
      indexOnStart: false,
      heartbeatIntervalMs: 20,
      awaitWriteFinishMs: 10
    });

    await daemon.start();
    await waitFor(async () => (await readWatcherLiveness(root)).state === "running", 1_000);

    const replacement = replacementLockInfo(root);
    await fs.writeFile(watcherLockPath(root), `${JSON.stringify(replacement, null, 2)}\n`, "utf8");
    await writeHeartbeat(root, heartbeatForReplacement(root, replacement));

    await waitFor(async () => !(await daemon.status()).running, 1_000);

    const heartbeat = JSON.parse(await fs.readFile(watcherHeartbeatPath(root), "utf8")) as WatcherHeartbeat;
    expect(heartbeat.pid).toBe(replacement.pid);
    expect(heartbeat.startedAtMs).toBe(replacement.startedAtMs);
    expect(heartbeat.ready).toBe(true);
  });

  it("bootstraps an unindexed repo with one bounded batch and queues the remainder", async () => {
    const root = await createTempRepo("ragcode-watch-bootstrap-start-");
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "a.ts"), "export const a = 1;\n");
    await fs.writeFile(path.join(root, "src", "b.ts"), "export const b = 1;\n");
    await fs.writeFile(path.join(root, "src", "c.ts"), "export const c = 1;\n");

    const engine = new FakeEngine(root);
    engine.missingUntilIndexed = true;
    const daemon = new FileWatchDaemon(engine, root, {
      autoIndex: false,
      maxBatchFiles: 2,
      flushEventsMs: 20,
      awaitWriteFinishMs: 10
    });

    await daemon.start();
    await daemon.stop();

    expect(engine.indexRepoBatches).toEqual([["src/a.ts", "src/b.ts"]]);
    expect(engine.recordedBatches).toContainEqual(["src/c.ts"]);
  });

  it("does not read every bootstrap file before choosing the first watcher batch", async () => {
    const root = await createTempRepo("ragcode-watch-bootstrap-inventory-");
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "a.ts"), "export const a = 1;\n");
    await fs.writeFile(path.join(root, "src", "b.ts"), "export const b = 1;\n");
    await fs.writeFile(path.join(root, "src", "c.ts"), "export const c = 1;\n");
    const readFile = vi.spyOn(fs, "readFile");

    const engine = new FakeEngine(root);
    engine.missingUntilIndexed = true;
    const daemon = new FileWatchDaemon(engine, root, {
      autoIndex: false,
      maxBatchFiles: 2,
      flushEventsMs: 20,
      awaitWriteFinishMs: 10
    });

    await daemon.start();
    await daemon.stop();

    expect(engine.indexRepoBatches).toEqual([["src/a.ts", "src/b.ts"]]);
    const readPaths = readFile.mock.calls.map(([file]) => String(file).replaceAll("\\", "/"));
    expect(readPaths.some((file) => file.includes("/src/"))).toBe(false);
  });

  it("keeps journaled events recoverable when dirty-state recording fails", async () => {
    const root = await createTempRepo("ragcode-watch-recover-");
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "recover.ts"), "export const value = 1;\n");

    const journal = FileEventJournal.forRepo(root);
    const failingEngine = new FakeEngine(root);
    failingEngine.failRecord = true;
    const daemon = new FileWatchDaemon(failingEngine, root, {
      autoIndex: false,
      indexOnStart: false,
      flushEventsMs: 20,
      awaitWriteFinishMs: 10,
      pollIntervalMs: 20,
      usePolling: true,
      journal
    });

    await daemon.start();
    await waitFor(async () => (await daemon.status()).ready);
    await fs.writeFile(path.join(root, "src", "recover.ts"), "export const value = 2;\n");
    await waitFor(async () => (await journal.replay()).some((entry) => entry.filePath === "src/recover.ts"), 3_000);
    await daemon.stop().catch(() => undefined);

    expect((await journal.replay()).map((entry) => entry.filePath)).toContain("src/recover.ts");

    const recoveringEngine = new FakeEngine(root);
    const restarted = new FileWatchDaemon(recoveringEngine, root, {
      autoIndex: false,
      indexOnStart: false,
      journal
    });
    await restarted.start();
    await restarted.stop();

    expect(recoveringEngine.recordedBatches.flat()).toContain("src/recover.ts");
    expect(await journal.replay()).toEqual([]);
  });

  it("retries a failed dirty-state flush without waiting for another event", async () => {
    const root = await createTempRepo("ragcode-watch-flush-retry-");
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "retry.ts"), "export const value = 1;\n");

    const journal = FileEventJournal.forRepo(root);
    const engine = new FakeEngine(root);
    engine.failRecordCount = 1;
    const daemon = new FileWatchDaemon(engine, root, {
      autoIndex: false,
      indexOnStart: false,
      flushEventsMs: 20,
      flushRetryMaxDelayMs: 20,
      awaitWriteFinishMs: 10,
      pollIntervalMs: 20,
      usePolling: true,
      journal
    });

    await daemon.start();
    await waitFor(async () => (await daemon.status()).ready);
    await fs.writeFile(path.join(root, "src", "retry.ts"), "export const value = 2;\n");

    await waitFor(() => engine.recordedBatches.some((batch) => batch.includes("src/retry.ts")), 3_000);
    await daemon.stop();

    expect(engine.recordFailures).toBe(1);
    expect(engine.recordedBatches.flat()).toContain("src/retry.ts");
    expect(await journal.replay()).toEqual([]);
  });
});

describe("watch index scheduler", () => {
  it("marks only a bounded quiet dirty batch as indexing before refreshing", async () => {
    const root = await createTempRepo("ragcode-watch-scheduler-");
    const engine = new FakeEngine(root);
    engine.seedDirty(["src/a.ts", "src/b.ts", "src/c.ts"], Date.now() - 10_000);
    const statuses: Array<{ pendingFiles: number; indexingFiles: number; indexing: boolean }> = [];
    const scheduler = new WatchIndexScheduler(engine, root, {
      maxBatchFiles: 2,
      minQuietMs: 0,
      onStatus: (status) => statuses.push({
        pendingFiles: status.pendingFiles,
        indexingFiles: status.indexingFiles,
        indexing: status.indexing
      })
    });

    scheduler.start();
    const index = await scheduler.flush();
    await scheduler.stop();

    expect(index?.changedFiles).toEqual(["src/a.ts", "src/b.ts"]);
    expect(engine.indexingBatches).toEqual([["src/a.ts", "src/b.ts"]]);
    expect(engine.refreshCount).toBe(1);
    expect(statuses.some((status) => status.indexingFiles === 2 || status.indexing)).toBe(true);
  });

  it("requeues indexing files when a background refresh fails", async () => {
    const root = await createTempRepo("ragcode-watch-scheduler-fail-");
    const engine = new FakeEngine(root);
    engine.seedDirty(["src/a.ts", "src/b.ts"], Date.now() - 10_000);
    engine.failRefresh = true;
    const scheduler = new WatchIndexScheduler(engine, root, {
      minQuietMs: 0,
      batchDelayMs: 10
    });

    scheduler.start();
    const index = await scheduler.flush();
    await scheduler.stop();

    expect(index).toBeUndefined();
    expect(engine.indexingBatches).toEqual([["src/a.ts", "src/b.ts"]]);
    expect(engine.recordedBatches).toContainEqual(["src/a.ts", "src/b.ts"]);
    expect((await engine.indexStatus(root)).freshness.pendingFiles).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("passes the bounded dirty batch as affected refresh files", async () => {
    const root = await createTempRepo("ragcode-watch-scheduler-affected-");
    const engine = new FakeEngine(root);
    engine.seedDirty(["src/a.ts", "src/b.ts", "src/c.ts"], Date.now() - 10_000);
    const scheduler = new WatchIndexScheduler(engine, root, { maxBatchFiles: 2, minQuietMs: 0 });

    scheduler.start();
    await scheduler.flush();
    await scheduler.stop();

    expect(engine.affectedRefreshBatches).toEqual([["src/a.ts", "src/b.ts"]]);
    expect((await engine.indexStatus(root)).freshness.pendingFiles).toEqual(["src/c.ts"]);
  });

  it("passes memory guard options to background refresh batches", async () => {
    const root = await createTempRepo("ragcode-watch-scheduler-memory-guard-");
    const engine = new FakeEngine(root);
    engine.seedDirty(["src/a.ts"], Date.now() - 10_000);
    const scheduler = new WatchIndexScheduler(engine, root, { maxAnalysisMemoryMb: 128, minQuietMs: 0 });

    scheduler.start();
    await scheduler.flush();
    await scheduler.stop();

    expect(engine.refreshOptions[0]).toMatchObject({
      affectedFiles: ["src/a.ts"],
      maxAnalysisMemoryMb: 128
    });
  });

  it("keeps empty-index bootstrap bounded to scheduler batches", async () => {
    const root = await createTempRepo("ragcode-watch-scheduler-bootstrap-");
    const engine = new FakeEngine(root);
    engine.seedDirty(["src/a.ts", "src/b.ts", "src/c.ts"], Date.now() - 10_000);
    const scheduler = new WatchIndexScheduler(engine, root, { maxBatchFiles: 2, minQuietMs: 0 });

    scheduler.start();
    const index = await scheduler.flush();
    await scheduler.stop();

    expect(index?.fullReindex).toBe(false);
    expect(index?.affectedFiles).toEqual(["src/a.ts", "src/b.ts"]);
    expect(engine.affectedRefreshBatches).toEqual([["src/a.ts", "src/b.ts"]]);
    expect((await engine.indexStatus(root)).freshness.pendingFiles).toEqual(["src/c.ts"]);
  });

  it("computes quiet time for very large dirty queues without spreading into Math.max", async () => {
    const root = await createTempRepo("ragcode-watch-scheduler-large-");
    const engine = new FakeEngine(root);
    engine.seedDirty(Array.from({ length: 20_000 }, (_, index) => `src/file-${index}.ts`), Date.now() - 10_000);
    const scheduler = new WatchIndexScheduler(engine, root, { maxBatchFiles: 1, minQuietMs: 0 });

    scheduler.start();
    await expect(scheduler.flush()).resolves.toBeDefined();
    await scheduler.stop();

    expect(engine.affectedRefreshBatches[0]).toEqual(["src/file-0.ts"]);
  });

  it("dead-letters poison files after bounded retry attempts", async () => {
    const root = await createTempRepo("ragcode-watch-scheduler-deadletter-");
    const engine = new FakeEngine(root);
    engine.seedDirty(["src/poison.ts"], Date.now() - 10_000);
    engine.failRefresh = true;
    const scheduler = new WatchIndexScheduler(engine, root, { minQuietMs: 0, maxRetryAttempts: 2 });

    scheduler.start();
    await scheduler.flush();
    await scheduler.flush();
    await scheduler.stop();

    expect(engine.deadLetterBatches).toEqual([["src/poison.ts"]]);
    expect((await engine.indexStatus(root)).freshness.dirtyFiles[0]?.status).toBe("dead_letter");
  });
});

async function createTempRepo(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for condition.");
}

function replacementLockInfo(root: string): WatcherLockInfo {
  return {
    pid: process.pid,
    hostname: os.hostname(),
    repoRoot: path.resolve(root),
    startedAtMs: Date.now() + 60_000
  };
}

function heartbeatForReplacement(root: string, owner: WatcherLockInfo): WatcherHeartbeat {
  return {
    pid: owner.pid,
    hostname: owner.hostname,
    repoRoot: path.resolve(root),
    startedAtMs: owner.startedAtMs,
    lastHeartbeatMs: Date.now(),
    pendingFiles: 0,
    indexingFiles: 0,
    ready: true
  };
}

class FakeEngine implements ContextEngine {
  recordedBatches: string[][] = [];
  indexingBatches: string[][] = [];
  affectedRefreshBatches: string[][] = [];
  deadLetterBatches: string[][] = [];
  indexRepoBatches: string[][] = [];
  refreshOptions: IndexRefreshOptions[] = [];
  refreshCount = 0;
  missingUntilIndexed = false;
  failRecord = false;
  failRecordCount = 0;
  recordFailures = 0;
  failRefresh = false;
  blockIndexStatus = false;
  private readonly releaseBlockedIndexStatus: Array<() => void> = [];
  private dirty = new Map<string, { status: "pending" | "indexing" | "dead_letter"; reason?: string; lastSeenAtMs: number; eventCount: number }>();

  constructor(private readonly root: string) {}

  seedDirty(filePaths: string[], lastSeenAtMs: number): void {
    for (const filePath of filePaths) {
      this.dirty.set(filePath, { status: "pending", lastSeenAtMs, eventCount: 1 });
    }
  }

  async indexRepo(repoRoot: string, options?: IndexRefreshOptions): Promise<RepoIndex> {
    this.missingUntilIndexed = false;
    const affectedFiles = [...new Set(options?.affectedFiles ?? [])].sort();
    this.indexRepoBatches.push(affectedFiles);
    return this.repoIndex(repoRoot, affectedFiles, affectedFiles.length === 0, affectedFiles.length > 0 ? affectedFiles : undefined);
  }

  async refreshIndex(repoRoot: string | undefined, options?: IndexRefreshOptions): Promise<RepoIndex> {
    if (this.failRefresh) throw new Error("refresh failed");
    this.refreshCount += 1;
    this.refreshOptions.push({ ...options });
    const affectedFiles = [...new Set(options?.affectedFiles ?? [])].sort();
    this.affectedRefreshBatches.push(affectedFiles);
    const changedFiles = [...this.dirty.entries()]
      .filter(([filePath, state]) => state.status === "indexing" && (affectedFiles.length === 0 || affectedFiles.includes(filePath)))
      .map(([filePath]) => filePath)
      .sort();
    for (const filePath of changedFiles) this.dirty.delete(filePath);
    return this.repoIndex(repoRoot ?? this.root, changedFiles, false, affectedFiles);
  }

  async indexStatus(repoRoot: string | undefined): Promise<IndexStatus> {
    if (this.blockIndexStatus) {
      await new Promise<void>((resolve) => {
        this.releaseBlockedIndexStatus.push(resolve);
      });
    }
    if (this.missingUntilIndexed) throw new Error("Workspace is not indexed");
    const dirtyFiles = [...this.dirty.entries()].map(([filePath, state]) => ({
      projectId: "project",
      filePath,
      status: state.status,
      reason: state.reason ?? (state.status === "indexing" ? "background batch indexing" : "watcher file event"),
      firstSeenAtMs: state.lastSeenAtMs,
      lastSeenAtMs: state.lastSeenAtMs,
      eventCount: state.eventCount
    })).sort((a, b) => a.filePath.localeCompare(b.filePath));
    const freshness: FreshnessReport = {
      projectId: "project",
      indexGeneration: this.refreshCount,
      indexedAtMs: 1,
      graphFresh: dirtyFiles.length === 0,
      semanticGeneration: this.refreshCount,
      semanticFresh: true,
      semanticCoverage: dirtyFiles.length === 0 ? "complete_repo" : "indexed_graph",
      semanticRebuildNeeded: false,
      staleFiles: dirtyFiles.map((file) => file.filePath),
      pendingFiles: dirtyFiles.filter((file) => file.status === "pending").map((file) => file.filePath),
      indexingFiles: dirtyFiles.filter((file) => file.status === "indexing").map((file) => file.filePath),
      skippedFiles: [],
      dirtyFiles,
      burstMode: false,
      droppedEvents: 0
    };
    return {
      repoRoot: repoRoot ?? this.root,
      projectId: "project",
      indexedAtMs: 1,
      fileCount: 0,
      chunkCount: 0,
      symbolCount: 0,
      edgeCount: 0,
      freshFileCount: 0,
      staleFileCount: freshness.staleFiles.length,
      pendingFileCount: freshness.pendingFiles.length,
      indexingFileCount: freshness.indexingFiles.length,
      skippedFileCount: 0,
      burstMode: false,
      droppedEventCount: 0,
      graphFresh: freshness.graphFresh,
      semanticGeneration: freshness.semanticGeneration,
      semanticFresh: freshness.semanticFresh,
      semanticCoverage: freshness.semanticCoverage,
      semanticRebuildNeeded: freshness.semanticRebuildNeeded,
      freshness
    };
  }

  releaseIndexStatus(): void {
    this.blockIndexStatus = false;
    for (const release of this.releaseBlockedIndexStatus.splice(0)) release();
  }

  async recordFileEvents(_repoRoot: string | undefined, filePaths: string[], _options?: WatcherEventOptions): Promise<WatcherState> {
    if (this.failRecord || this.failRecordCount > 0) {
      if (this.failRecordCount > 0) this.failRecordCount -= 1;
      this.recordFailures += 1;
      throw new Error("record failed");
    }
    const batch = [...new Set(filePaths)].sort();
    this.recordedBatches.push(batch);
    const now = Date.now();
    for (const filePath of batch) {
      const current = this.dirty.get(filePath);
      this.dirty.set(filePath, {
        status: "pending",
        lastSeenAtMs: now,
        eventCount: (current?.eventCount ?? 0) + 1
      });
    }
    return this.watcherState();
  }

  async markDirtyFilesIndexing(_repoRoot: string | undefined, filePaths: string[]): Promise<WatcherState> {
    const batch = [...new Set(filePaths)].sort();
    this.indexingBatches.push(batch);
    for (const filePath of batch) {
      const current = this.dirty.get(filePath);
      if (!current) continue;
      this.dirty.set(filePath, { ...current, status: "indexing", lastSeenAtMs: Date.now() });
    }
    return this.watcherState();
  }

  async markDirtyFilesDeadLetter(_repoRoot: string | undefined, filePaths: string[], reason: string): Promise<WatcherState> {
    const batch = [...new Set(filePaths)].sort();
    this.deadLetterBatches.push(batch);
    for (const filePath of batch) {
      const current = this.dirty.get(filePath);
      if (!current) continue;
      this.dirty.set(filePath, { ...current, status: "dead_letter", reason, lastSeenAtMs: Date.now() });
    }
    return this.watcherState();
  }

  async searchCode(_query: SearchQuery): Promise<SearchHit[]> { return []; }
  async getContext(request: ContextRequest): Promise<ContextPack> { throw new Error(`not implemented ${request.query}`); }
  async verifiedSubgraph(request: VerifiedSubgraphRequest): Promise<VerifiedCodeSubgraph> { throw new Error(`not implemented ${request.query}`); }
  async topologyMap(request: TopologyMapRequest): Promise<TopologyMap> { throw new Error(`not implemented ${request.query}`); }
  async findSymbol(_repoRoot: string | undefined, _name: string): Promise<SymbolNode[]> { return []; }
  async explainFile(_repoRoot: string | undefined, _filePath: string): Promise<{ file?: CodeFile; chunks: CodeChunk[]; symbols: SymbolNode[] }> { return { chunks: [], symbols: [] }; }
  async findOwner(_repoRoot: string | undefined, _query: string, _limit?: number): Promise<OwnerCandidate[]> { return []; }
  async findReuseCandidates(): Promise<never> { throw new Error("not implemented"); }
  async impactAnalysis(_repoRoot: string | undefined, target: string): Promise<ImpactAnalysis> { throw new Error(`not implemented ${target}`); }
  async relatedTests(_repoRoot: string | undefined, target: string): Promise<RelatedTests> { throw new Error(`not implemented ${target}`); }
  async traceFlow(_repoRoot: string | undefined, entry: string): Promise<TraceFlow> { throw new Error(`not implemented ${entry}`); }
  async reviewDiff(): Promise<DiffReview> { return { changedFiles: [], relatedTests: [], riskLevel: "low", findings: [] }; }

  private repoIndex(repoRoot: string, changedFiles: string[], fullReindex: boolean, affectedFiles?: string[]): RepoIndex {
    return {
      projectId: "project",
      repoRoot,
      indexedAtMs: Date.now(),
      indexGeneration: this.refreshCount,
      changedFiles,
      deletedFiles: [],
      affectedFiles,
      fullReindex,
      files: [],
      chunks: [],
      symbols: [],
      edges: [],
      skippedFiles: []
    };
  }

  private watcherState(): WatcherState {
    const dirtyFiles = [...this.dirty.entries()].map(([filePath, state]) => ({
      projectId: "project",
      filePath,
      status: state.status,
      reason: state.reason ?? (state.status === "indexing" ? "background batch indexing" : "watcher file event"),
      firstSeenAtMs: state.lastSeenAtMs,
      lastSeenAtMs: state.lastSeenAtMs,
      eventCount: state.eventCount
    })).sort((a, b) => a.filePath.localeCompare(b.filePath));
    return {
      projectId: "project",
      dirtyFiles,
      pendingFiles: dirtyFiles.filter((file) => file.status === "pending").map((file) => file.filePath),
      indexingFiles: dirtyFiles.filter((file) => file.status === "indexing").map((file) => file.filePath),
      burstMode: false,
      droppedEvents: 0,
      lastEventAtMs: Date.now(),
      updatedAtMs: Date.now()
    };
  }
}
