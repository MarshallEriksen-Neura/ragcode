import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { IndexProgressApp } from "../src/cli/tui/index-progress.js";
import { WatchStatusApp } from "../src/cli/tui/watch-status.js";
import type { RepoIndex } from "../src/core/types.js";

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
