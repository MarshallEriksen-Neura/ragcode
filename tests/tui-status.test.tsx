import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { HumanStatusApp, renderHumanStatusText } from "../src/cli/tui/human-status.js";
import { IndexProgressApp } from "../src/cli/tui/index-progress.js";
import { WatchStatusApp } from "../src/cli/tui/watch-status.js";
import type { IndexStatus, RepoIndex } from "../src/core/types.js";
import type { WatcherLiveness } from "../src/watch/watcher-liveness.js";

describe("terminal status TUI", () => {
  it("renders real index progress phases and final counts", () => {
    const { lastFrame } = render(
      <IndexProgressApp
        repoRoot="/repo"
        events={[
          { phase: "scanning", message: "Scanning repository" },
          { phase: "analyzing", message: "Analyzing full repository", scannedFiles: 3, changedFiles: 2, deletedFiles: 0, refreshedFiles: 2 },
          { phase: "writing_graph", message: "Writing graph index", chunks: 4, symbols: 5, edges: 6 }
        ]}
        result={repoIndex({ files: 3, chunks: 4, changedFiles: 2, refreshedFiles: 2 })}
      />
    );

    expect(lastFrame()).toContain("RagCode Index");
    expect(lastFrame()).toContain("Scanning repository");
    expect(lastFrame()).toContain("Analyzing full repository");
    expect(lastFrame()).toContain("Writing graph index");
    expect(lastFrame()).toContain("Indexed 3 files, 4 chunks.");
    expect(lastFrame()).toContain("changed 2, deleted 0, refreshed 2, skipped 1");
    expect(lastFrame()).toContain("parser_fallback: 2");
  });

  it("renders watch daemon and scheduler state", () => {
    const { lastFrame } = render(
      <WatchStatusApp
        status={{
          repoRoot: "/repo",
          running: true,
          ready: true,
          bufferedEvents: 1,
          scheduler: {
            repoRoot: "/repo",
            running: true,
            scheduled: true,
            indexing: true,
            pendingFiles: 2,
            indexingFiles: 1,
            lastIndexedAtMs: 1_700_000_000_000
          }
        }}
      />
    );

    expect(lastFrame()).toContain("RagCode Watch");
    expect(lastFrame()).toContain("Status:");
    expect(lastFrame()).toContain("ready");
    expect(lastFrame()).toContain("buffered 1, pending 2, indexing 1");
    expect(lastFrame()).toContain("scheduled");
    expect(lastFrame()).toContain("indexing");
  });

  it("renders human status for people instead of JSON", () => {
    const status = indexStatus();
    const watcher = watcherLiveness();
    const { lastFrame } = render(<HumanStatusApp status={status} watcher={watcher} />);

    expect(lastFrame()).toContain("RagCode Status");
    expect(lastFrame()).toContain("Watch:");
    expect(lastFrame()).toContain("running, fresh heartbeat");
    expect(lastFrame()).toContain("Files: indexed 8/10, pending 3, stale 2, skipped 1");
    expect(lastFrame()).toContain("Embedding:");
    expect(lastFrame()).toContain("failed");
    expect(lastFrame()).toContain("Embedding error: fetch failed");
    expect(lastFrame()).toContain("Dirty files: src/a.ts (pending)");
  });

  it("renders human status to a deterministic non-TTY text frame", () => {
    const output = renderHumanStatusText(indexStatus(), watcherLiveness());

    expect(output).toContain("RagCode Status");
    expect(output).not.toContain('"fileCount"');
    expect(output).toContain("Chunks/Symbols/Edges: 20 / 12 / 7");
  });
});

function repoIndex(counts: { files: number; chunks: number; changedFiles: number; refreshedFiles: number }): RepoIndex {
  return {
    projectId: "project",
    repoRoot: "/repo",
    indexedAtMs: Date.now(),
    indexGeneration: 1,
    changedFiles: Array.from({ length: counts.changedFiles }, (_, index) => `src/changed-${index}.ts`),
    deletedFiles: [],
    refreshedFiles: Array.from({ length: counts.refreshedFiles }, (_, index) => `src/refreshed-${index}.ts`),
    fullReindex: true,
    files: Array.from({ length: counts.files }, (_, index) => ({
      projectId: "project",
      path: `src/file-${index}.ts`,
      absolutePath: `/repo/src/file-${index}.ts`,
      language: "typescript",
      sizeBytes: 1,
      contentHash: String(index),
      modifiedAtMs: 1
    })),
    chunks: Array.from({ length: counts.chunks }, (_, index) => ({
      id: `chunk-${index}`,
      projectId: "project",
      repoRoot: "/repo",
      filePath: `src/file-${index}.ts`,
      language: "typescript",
      kind: "file",
      startLine: 1,
      endLine: 1,
      content: "x",
      contentHash: String(index)
    })),
    symbols: [],
    edges: [],
    skippedFiles: [{ filePath: "dist", reason: "ignored directory: dist", classification: { role: "build", reason: "build output" } }],
    analysisWarnings: [{ kind: "parser_fallback", message: "tree-sitter rust analysis skipped: Invalid argument", count: 2, samples: ["src/a.rs", "src/b.rs"] }]
  };
}

function indexStatus(): IndexStatus {
  return {
    repoRoot: "/repo",
    projectId: "project",
    indexedAtMs: 1_700_000_000_000,
    fileCount: 10,
    chunkCount: 20,
    symbolCount: 12,
    edgeCount: 7,
    freshFileCount: 8,
    staleFileCount: 2,
    pendingFileCount: 3,
    indexingFileCount: 0,
    skippedFileCount: 1,
    burstMode: false,
    droppedEventCount: 0,
    graphFresh: false,
    semanticGeneration: 4,
    semanticFresh: false,
    semanticCoverage: "indexed_graph",
    semanticRebuildNeeded: true,
    semanticLastError: "fetch failed",
    freshness: {
      projectId: "project",
      indexGeneration: 5,
      indexedAtMs: 1_700_000_000_000,
      graphFresh: false,
      semanticGeneration: 4,
      semanticFresh: false,
      semanticCoverage: "indexed_graph",
      semanticRebuildNeeded: true,
      semanticLastError: "fetch failed",
      staleFiles: ["src/a.ts", "src/b.ts"],
      pendingFiles: ["src/a.ts", "src/b.ts", "src/c.ts"],
      indexingFiles: [],
      skippedFiles: [{ filePath: "dist", reason: "ignored directory: dist" }],
      dirtyFiles: [{
        projectId: "project",
        filePath: "src/a.ts",
        status: "pending",
        reason: "watcher file event",
        firstSeenAtMs: 1,
        lastSeenAtMs: 2,
        eventCount: 1
      }],
      burstMode: false,
      droppedEvents: 0
    }
  };
}

function watcherLiveness(): WatcherLiveness {
  return {
    state: "running",
    processAlive: true,
    heartbeatFresh: true,
    diagnostic: "live_watcher",
    heartbeatAgeMs: 1_200,
    lock: {
      pid: 123,
      hostname: "host",
      repoRoot: "/repo",
      startedAtMs: 1_700_000_000_000
    },
    heartbeat: {
      pid: 123,
      hostname: "host",
      repoRoot: "/repo",
      startedAtMs: 1_700_000_000_000,
      lastHeartbeatMs: 1_700_000_001_000,
      lastIndexedAtMs: 1_700_000_000_000,
      pendingFiles: 3,
      indexingFiles: 0,
      ready: true
    }
  };
}
