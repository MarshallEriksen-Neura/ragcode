# TODO: Large-Repository Indexing Hardening

This list records issues exposed while trying to start RagCode for `D:\20260302170616\jizhichuangsi`, a repository root that recursively included the large `lobehub` tree.

## Observed Evidence

- `jizhichuangsi` had roughly 11.6k RagCode-indexable files, with about 11.5k under `lobehub`.
- The repository started from an empty RagCode index: `fileCount: 0`, `chunkCount: 0`, `symbolCount: 0`, `edgeCount: 0`, and about 11.5k pending files.
- `ragcode index` and watcher-triggered indexing hit Node heap failures around the default 4 GB heap limit.
- Directly launching Node with `--max-old-space-size=8192` allowed the process to exceed the default limit, but the first full index still made no durable progress in `graph.sqlite` before stalling.
- Non-TTY logs were mostly empty, making it hard to tell whether indexing was in scan, analysis, graph write, or semantic write.
- OOM watcher attempts left stale watcher state files (`.ragcode/watcher.lock`, `.ragcode/watcher-heartbeat.json`).

## Validated Corrections

- The empty-index batch failure is real: `src/indexing/indexer.ts` sets `fullReindex = existingFiles.length === 0` and then drops `affectedFiles`, so watcher `maxBatchFiles` cannot help during first bootstrap.
- The memory problem is broader than SQLite writes. `src/indexing/indexer.ts` builds a full `RepoIndex` in memory before `graphStore.upsertIndex(index)`. `src/graph/sqlite-graph-store.ts` then writes that full index in one transaction, which is another risk, but the observed run did not prove SQLite write was the only OOM point.
- Existing `upsertIndex` already has an incremental path for `fullReindex: false` plus affected/refreshed files. First implementation should try to reuse that path before adding new graph-store batch APIs.
- `watch --poll` has a concrete low-cost bug: `src/watch/watch-daemon.ts` passes `pollIntervalMs` to chokidar without guaranteeing a numeric value.
- Watcher liveness is partially hardened already: `acquireWatcherLock(...)` can reclaim dead locks on next acquisition, but read-only status does not clean stale state and normal `stop()` is not reached after OOM/fatal exits.

## Revised Implementation Order

| Order | Task | Rationale |
| --- | --- | --- |
| 1 | Fix watcher polling defaults and stale-state diagnostics | Small, high-confidence fix; makes watcher usable and status less misleading. |
| 2 | Implement batch bootstrap MVP for empty indexes | Core fix: empty indexes must honor file batches instead of forcing full reindex. |
| 3 | Add memory guardrails and JSONL progress | Makes batch bootstrap observable and prevents silent OOM loops. |
| 4 | Decouple service install from full indexing | Avoids turning service setup into a blocking large-repo bootstrap. |
| 5 | Add `ragcode estimate` and root-selection warnings | Prevents bad root choices; useful UX, but not the crash root cause. |
| 6 | Decouple graph and semantic generations | Important robustness follow-up after batch graph bootstrap is stable. |
| 7 | Add configurable include/exclude policy | Useful once bootstrap and status semantics are solid. |

## P0: Fix Watcher Polling And Stale-State Diagnostics

- Give polling mode a numeric default interval instead of passing `undefined` to chokidar.
- Validate `pollIntervalMs`, `awaitWriteFinishMs`, and related timing options at the CLI/options boundary.
- Keep `watch_status` read-only, but surface actionable stale-state diagnostics:
  - live watcher
  - stale heartbeat
  - dead lock holder
  - heartbeat without lock
  - next acquisition will reclaim stale lock
- Consider a separate explicit cleanup command for stale watcher state; do not mutate status reads unexpectedly.
- Ensure OOM/fatal exits leave a useful death reason or last progress record when possible.

Owner notes:

- `src/watch/watch-daemon.ts` passes `interval: this.options.pollIntervalMs` directly to chokidar.
- `src/watch/watch-daemon.ts` clears heartbeat/lock only on normal `stop()` with an owned `lockHandle`.
- `src/watch/watcher-liveness.ts` has stale lock reclaim logic in `acquireWatcherLock(...)`, but `readWatcherLiveness(...)` is read-only.

## P0: Batch Bootstrap MVP For Empty Indexes

- Allow `affectedFiles` to work even when `existingFiles.length === 0`.
- Introduce an explicit partial-bootstrap mode instead of treating empty indexes as all-or-nothing full reindex.
- Bootstrap flow should be batch-scoped end to end:
  - scan or select a file inventory
  - split file paths into bounded batches
  - scan/analyze/chunk one batch
  - write that batch with existing incremental `upsertIndex` semantics where possible
  - leave unprocessed files pending
- First try reusing `graphStore.upsertIndex(...)` with `fullReindex: false` and batch `affectedFiles`; add new graph-store batch APIs only if current semantics are insufficient.
- Define status semantics for partial bootstrap so retrieval can know what is trustworthy.

Owner notes:

- `src/indexing/indexer.ts` currently sets `affectedPaths = fullReindex ? undefined : normalizedAffectedFiles(...)`.
- `src/watch/index-scheduler.ts` already chooses dirty batches via `dirtyFilesForBatch(...)`, but the indexer discards the batch during empty-index bootstrap.
- Do not merely slice `files` after full `chunkFiles(...)`; the scan/analyze/chunk stages must also be batch-scoped or memory pressure remains.

## P0: Memory Guardrails And Durable Progress

- Track heap and RSS during scan, analyze, graph write, and semantic write phases.
- Abort gracefully before OOM with an actionable error and a resumable checkpoint.
- Emit JSONL progress in non-TTY mode for `ragcode index`, watcher, and service contexts.
- Persist last progress to `.ragcode/index-state.json` so crashed background runs can be diagnosed after exit.
- Support graph-only bootstrap or semantic deferral when semantic indexing would exceed memory limits.

Candidate settings:

- `RAGCODE_MAX_INDEX_FILES_PER_BATCH`
- `RAGCODE_MAX_ANALYSIS_MEMORY_MB`
- `RAGCODE_DISABLE_SEMANTIC_ON_BOOTSTRAP`
- `RAGCODE_BOOTSTRAP_GRAPH_ONLY`

Suggested progress phases:

- `loading_existing_index`
- `scanning_inventory`
- `scanning_batch`
- `analyzing_batch`
- `writing_graph_batch`
- `writing_semantic_batch`
- `complete`
- `failed`

## P1: Decouple Service Install From Full Indexing

- `ragcode service install` should register/start the service without synchronously doing a full index by default.
- Add explicit flags such as `--index-now`, `--no-index-now`, and `--bootstrap-batch-size <n>`.
- Start the service quickly, then let watcher bootstrap batches run in the background.
- Preserve `--no-index-on-start` for boot safety, but do not make install depend on a successful full index.

Owner notes:

- `src/cli/index.ts` currently indexes once up front during service installation so the service can start with `--no-index-on-start`.

## P1: Add Preflight Estimation And Root Selection

- Add a read-only command such as `ragcode estimate <repoRoot>`.
- Report indexable file count, extension distribution, top directories, largest files, nested git roots, and whether the selected root looks suspicious.
- Warn when the selected root has no tracked files but contains a large nested project.
- Suggest safer roots or exclude patterns before starting a large first index.

Useful output fields:

- `indexableFiles`
- `skippedFiles`
- `topDirectories`
- `extensions`
- `nestedGitRoots`
- `estimatedChunks`
- `recommendedMode`
- `recommendedCommand`

## P2: Decouple Graph And Semantic Generations

- Treat graph index as the durable source of truth.
- Treat semantic index as a rebuildable cache with its own generation, freshness, and last error.
- Write semantic rebuilds to temporary tables/directories and atomically swap on success.
- Keep graph search usable when semantic indexing fails.

Status fields to add:

- `graphFresh`
- `semanticFresh`
- `semanticGeneration`
- `semanticRebuildNeeded`
- `semanticLastError`

## P2: Add Project-Level Include/Exclude Configuration

- Support project-local ignore rules in `.ragcode/config.json`.
- Allow excluding large generated, locale, snapshot, migration-meta, fixture, or documentation-heavy subtrees.
- Allow separate switches for tests, docs, JSON, generated files, and max file size.

Candidate config fields:

- `includeGlobs`
- `excludeGlobs`
- `excludeDirs`
- `maxFileBytes`
- `indexTests`
- `indexDocs`
- `indexJson`

## Acceptance Criteria

- A repository with 10k+ indexable files can complete first bootstrap without exceeding configured memory limits.
- Empty-index bootstrap can index in batches and produce usable partial results before the whole repo is complete.
- `watch --max-batch-files` works for both empty and non-empty indexes.
- Existing incremental `upsertIndex` is reused where possible; new graph-store batch APIs are introduced only if the existing contract cannot represent partial bootstrap safely.
- Background indexing emits enough progress to identify the failing phase.
- Service install returns quickly and does not hide a long full-index operation.
- OOM/fatal exits leave clear diagnostic state and no misleading live watcher status.
