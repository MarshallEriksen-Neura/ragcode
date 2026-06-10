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
import { WatchIndexScheduler } from "../src/watch/index-scheduler.js";
import { FileWatchDaemon } from "../src/watch/watch-daemon.js";

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

class FakeEngine implements ContextEngine {
  recordedBatches: string[][] = [];
  indexingBatches: string[][] = [];
  affectedRefreshBatches: string[][] = [];
  deadLetterBatches: string[][] = [];
  refreshCount = 0;
  failRecord = false;
  failRecordCount = 0;
  recordFailures = 0;
  failRefresh = false;
  private dirty = new Map<string, { status: "pending" | "indexing" | "dead_letter"; reason?: string; lastSeenAtMs: number; eventCount: number }>();

  constructor(private readonly root: string) {}

  seedDirty(filePaths: string[], lastSeenAtMs: number): void {
    for (const filePath of filePaths) {
      this.dirty.set(filePath, { status: "pending", lastSeenAtMs, eventCount: 1 });
    }
  }

  async indexRepo(repoRoot: string): Promise<RepoIndex> {
    return this.repoIndex(repoRoot, [...this.dirty.keys()].sort(), true);
  }

  async refreshIndex(repoRoot: string | undefined, options?: { affectedFiles?: string[] }): Promise<RepoIndex> {
    if (this.failRefresh) throw new Error("refresh failed");
    this.refreshCount += 1;
    const affectedFiles = [...new Set(options?.affectedFiles ?? [])].sort();
    this.affectedRefreshBatches.push(affectedFiles);
    const changedFiles = [...this.dirty.entries()]
      .filter(([filePath, state]) => state.status === "indexing" && (affectedFiles.length === 0 || affectedFiles.includes(filePath)))
      .map(([filePath]) => filePath)
      .sort();
    for (const filePath of changedFiles) this.dirty.delete(filePath);
    return this.repoIndex(repoRoot ?? this.root, changedFiles, false);
  }

  async indexStatus(repoRoot: string | undefined): Promise<IndexStatus> {
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
      freshness
    };
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

  private repoIndex(repoRoot: string, changedFiles: string[], fullReindex: boolean): RepoIndex {
    return {
      projectId: "project",
      repoRoot,
      indexedAtMs: Date.now(),
      indexGeneration: this.refreshCount,
      changedFiles,
      deletedFiles: [],
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
