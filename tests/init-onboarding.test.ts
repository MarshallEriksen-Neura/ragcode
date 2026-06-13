import { describe, expect, it } from "vitest";
import path from "node:path";
import type { ContextEngine } from "../src/core/contracts.js";
import type { IndexRefreshOptions, IndexStatus, RepoIndex, WatcherState } from "../src/core/types.js";
import { runInitOnboarding } from "../src/cli/init-onboarding.js";

describe("init onboarding", () => {
  it("runs a bounded initial index batch and installs a verified watcher service", async () => {
    const engine = new FakeOnboardingEngine();
    const installed: Array<{ repoRoot: string; extraArgs?: string[]; indexOnStart?: boolean }> = [];
    const repoRoot = path.resolve("/repo");

    const result = await runInitOnboarding({
      repoRoot,
      indexNow: true,
      installWatcher: true,
      poll: true,
      maxBatchFiles: 25,
      maxAnalysisMemoryMb: 512,
      watcherWaitMs: 1,
      deps: {
        createEngine: () => ({ engine: engine as unknown as ContextEngine, close: () => { engine.closed = true; } }),
        indexRepoWithBootstrapBatch: async (receivedEngine, repoRoot, options) => {
          expect(receivedEngine).toBe(engine);
          expect(repoRoot).toBe(path.resolve("/repo"));
          expect(options.maxBatchFiles).toBe(25);
          expect(options.maxAnalysisMemoryMb).toBe(512);
          expect(options.disableSemanticOnBootstrap).toBe(true);
          return engine.indexRepo(repoRoot, { affectedFiles: ["src/a.ts"] });
        },
        installWatcherService: async (repoRoot, options) => {
          installed.push({ repoRoot, extraArgs: options.extraArgs, indexOnStart: options.indexOnStart });
          return { ok: true, platform: "schtasks", serviceName: "svc", repoRoot, message: "started" };
        },
        readWatcherLiveness: async (repoRoot) => ({
          state: "running",
          processAlive: true,
          heartbeatFresh: true,
          diagnostic: "live_watcher",
          heartbeat: {
            pid: 1,
            hostname: "host",
            repoRoot,
            startedAtMs: 1,
            lastHeartbeatMs: Date.now(),
            pendingFiles: 0,
            indexingFiles: 0,
            ready: true
          }
        })
      }
    });

    expect(result.index).toMatchObject({ files: 1, chunks: 1, pendingFiles: 7 });
    expect(result.liveness?.state).toBe("running");
    expect(installed).toEqual([{ repoRoot, extraArgs: ["--poll", "--max-batch-files", "25", "--max-analysis-memory-mb", "512"], indexOnStart: false }]);
    expect(engine.closed).toBe(true);
  });

  it("can skip index and watcher setup explicitly", async () => {
    const engine = new FakeOnboardingEngine();
    let installed = false;

    const result = await runInitOnboarding({
      repoRoot: "/repo",
      indexNow: false,
      installWatcher: false,
      deps: {
        createEngine: () => ({ engine: engine as unknown as ContextEngine, close: () => { engine.closed = true; } }),
        installWatcherService: async () => {
          installed = true;
          return { ok: true, platform: "schtasks", serviceName: "svc", repoRoot: "/repo", message: "started" };
        }
      }
    });

    expect(result).toEqual({});
    expect(engine.closed).toBe(false);
    expect(installed).toBe(false);
  });
});

class FakeOnboardingEngine implements Pick<ContextEngine, "indexStatus" | "indexRepo" | "recordFileEvents"> {
  closed = false;

  async indexRepo(repoRoot: string, options?: IndexRefreshOptions): Promise<RepoIndex> {
    return {
      projectId: "project",
      repoRoot,
      indexedAtMs: Date.now(),
      indexGeneration: 1,
      changedFiles: options?.affectedFiles ?? [],
      deletedFiles: [],
      affectedFiles: options?.affectedFiles,
      fullReindex: false,
      files: [{ path: "src/a.ts", language: "typescript", sizeBytes: 1, contentHash: "hash", indexedAtMs: 1 }],
      chunks: [{ id: "chunk", filePath: "src/a.ts", startLine: 1, endLine: 1, content: "export const a = 1;", tokenCount: 4, symbols: [] }],
      symbols: [],
      edges: [],
      skippedFiles: [],
      partialBootstrap: true,
      semanticDeferred: true
    };
  }

  async indexStatus(repoRoot: string): Promise<IndexStatus> {
    return {
      repoRoot,
      projectId: "project",
      indexedAtMs: 1,
      fileCount: 1,
      chunkCount: 1,
      symbolCount: 0,
      edgeCount: 0,
      freshFileCount: 1,
      staleFileCount: 0,
      pendingFileCount: 7,
      indexingFileCount: 0,
      skippedFileCount: 0,
      burstMode: false,
      droppedEventCount: 0,
      graphFresh: false,
      semanticGeneration: 1,
      semanticFresh: false,
      semanticCoverage: "indexed_graph",
      semanticRebuildNeeded: true,
      freshness: {
        projectId: "project",
        indexGeneration: 1,
        indexedAtMs: 1,
        graphFresh: false,
        semanticGeneration: 1,
        semanticFresh: false,
        semanticCoverage: "indexed_graph",
        semanticRebuildNeeded: true,
        staleFiles: [],
        pendingFiles: ["src/pending.ts"],
        indexingFiles: [],
        skippedFiles: [],
        dirtyFiles: [],
        burstMode: false,
        droppedEvents: 0
      }
    };
  }

  async recordFileEvents(): Promise<WatcherState> {
    throw new Error("not used");
  }
}
