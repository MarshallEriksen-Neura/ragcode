# Next Phase: Structured Relation Retrieval

## Positioning

Do not sell what grep already solves.

- Stale context is foundation hygiene. It makes persistent SQLite/LanceDB indexes safe to trust, but it is not the sharp product wedge.
- Known-symbol lookup is table stakes. Grep and LSP are already good here.
- Semantic recall is useful for lexical gaps, but it should feed structure, not become the product by itself.

The wedge is structured, multi-hop relation retrieval:

```text
What breaks if I change this?
How does this request/data move from A to B?
Do I have enough verified context to edit safely?
Is there already code I should reuse instead of implementing a duplicate?
```

The product answer should be a verified minimal code subgraph, not ten similar chunks.

## Current Reality Audit

This audit reflects the current code after the readiness pass, not the earlier scaffold snapshot.

Already implemented or no longer accurate:

- SQLite is wired into runtime selection through `RAGCODE_GRAPH_STORE=sqlite` and `createGraphRuntimeFromEnv`. It is no longer test-only.
- `package.json` now requires Node `>=24.0.0`, matching the direct `node:sqlite` import.
- SQLite keyword search now uses `chunks_fts MATCH` and `bm25`; FTS is no longer write-only.
- MCP has a real stdio server entrypoint and runtime Zod schemas via `createMcpServer` / `startStdioMcpServer`.
- `tested_by` is now produced by `buildTestTopologyEdges` and is surfaced in related tests, impact, trace, and topology map.
- Runtime topology has an initial TS/JS pass for `reads_from`, `writes_to`, `handles_event`, and `uses_middleware`.

Still true or partially true after the base implementation:

- The default deterministic embedding is not semantic; it is an offline smoke-test signal. Real embedding model evals still need separate calibration.
- File watching now has a long-running `chokidar` daemon, event journal replay, and background batch indexing as a base implementation. It is not yet production-hardened for stress, supervision, dropped-event reconciliation, or embedding-rate control.
- Incremental indexing avoids rewriting unchanged persisted rows and vectors, but the analysis pass still rebuilds a full in-memory file/chunk/symbol/edge snapshot to preserve cross-file relationship quality.
- Framework topology remains mostly Next.js and static-pattern based. Dynamic URLs, axios/API wrappers, other frameworks, and richer repository/ORM patterns are incomplete.
- `related` remains an unused edge kind and should either gain a producer or be removed from the public contract.
- `impact_analysis` and `trace_flow` remain legacy flat tools for compatibility. The path-shaped contract is now `explain_impact` / `trace_request_flow` over `VerifiedCodeSubgraph`.
- Python, Go, Rust, and Java now use tree-sitter-backed syntax analyzers for symbols/imports/exports/calls. They are not yet LSP-backed or cross-file resolver-backed language analyzers.
- `find_reuse_candidates` exists and catches basic naming gaps, but duplicate detection is still heuristic and should be deepened before treating it as a hard gate.

## Current Completion Marker

Checked on 2026-06-09.

`NEXT_PHASE_STRUCTURED_RELATION_RETRIEVAL` is complete as a base slice, not complete as final-form relation intelligence. The base slice means the engine has durable indexing, freshness, verified subgraph contracts, impact/flow/reuse tools, compact expansion, analyzer seams, and an executable eval/audit gate.

Completion evidence:

- `npm run audit:plan` passes with `ownerHitRate=1`, `flowPathCompleteness=1`, `verifiedSubgraphPathCompleteness=1`, `reuseCandidateRecall=1`, `staleHitRate=0`, and `deletedHitRate=0`.
- The historical stability/topology audit is closed in `docs/PLAN_STABILITY_AND_TOPOLOGY_COMPLETION_AUDIT.md`.
- Performance goals completed on 2026-06-09:
  - `benchmark-reuse-index`: warmed benchmark smoke can reuse persisted indexes.
  - `incremental-index-analysis`: changed/deleted-file incremental persistence behavior is covered by tests and typecheck.
  - `vite-owner-quality`: Vite `plugin config` warmed retrieval now includes `build.ts`, `pluginContainer.ts`, and `plugin-legacy`.

Current boundary:

- Do not keep treating this phase as unfinished foundation work.
- Do treat the deferred sections below as hardening work driven by benchmark and dogfooding evidence.
- The next optimization stream should be `core-owner-quality`: make real multi-repo owner recall stable before adding deeper framework/dataflow claims.

## Implementation Self-Audit

This section marks which delivered pieces are base slices rather than final-form implementations. The current goal is a strong working foundation; the next quality jump is replacing heuristics with resolver-backed, continuously evaluated behavior.

| Area | Current usable capability | Simple/base-slice part | Future hardening |
| --- | --- | --- | --- |
| SQLite persistence | Runtime can select SQLite, persist project/files/chunks/symbols/edges/dirty state, and support no-reindex reads across processes. | Schema is intentionally compact; migrations are inline; relationship rows still use JSON metadata for many source-specific fields. | Add versioned migrations, richer edge evidence columns, query indexes for subgraph traversal, and stress tests on large repos. |
| Incremental indexing | Changed/deleted files update graph/FTS/vector rows without re-embedding unchanged chunks. | Analysis still reads/analyzes the full scanned file set before selecting changed rows to write. | Add dependency-aware affected-file analysis, neighbor invalidation, and partial resolver passes so huge repos do not rebuild full snapshots. |
| Watcher/burst state | `record_file_events` coalesces noisy events, persists dirty files, reports burst mode, and retrieval excludes dirty indexed files. `FileWatchDaemon`, `FileEventJournal`, and `WatchIndexScheduler` provide daemon, replay, and background refresh base behavior. | The daemon/scheduler/journal path is new and still needs production hardening; retry/backoff, rate limits, supervision, and recovery semantics are thin. | Add stress tests, process supervision guidance, dropped-event reconciliation, embedding queue rate limits, progress reporting, and large-repo concurrency controls. |
| LanceDB profile guard | Sidecar profile catches provider/model/dimension/table mismatches before search/upsert. | Uses JSON sidecar metadata; does not inspect/migrate LanceDB table schema or automatically rebuild incompatible tables. | Add migration strategy, table/schema introspection, explicit repair command, and real-model eval profiles. |
| Verified subgraph | `VerifiedCodeSubgraph` returns nodes, verified edges, paths, coverage, missing evidence, next queries, and budgeted snippets. | Builder is a prioritized BFS over existing graph edges; path scoring and coverage are still heuristic. | Add weighted path search, edge provenance normalization, branch pruning, dynamic dispatch handling, and coverageSummary/edit-readiness across all subgraph tools. |
| `explain_impact` | MCP/CLI returns blast-radius subgraph plus risk score, reasons, and edit-readiness. | Risk scoring is rule-based; diff seed support is not first-class; public API detection is mostly export-based. | Add diff input, API boundary taxonomy, changed-field/type impact, test gap scoring, and same-name false-positive controls. |
| `trace_request_flow` | MCP/CLI returns ordered flow-mode subgraphs for static TS/JS + Next.js route/client/service/test paths. | It follows existing edges; no true dataflow/taint tracking, dynamic route resolution, or wrapper-aware API client tracing. | Add framework rule modules, axios/client wrapper resolution, route params, middleware chains, repository/ORM edges, webhook/event fan-in/fan-out. |
| `expand_node` | Agent can expand one compact node as file card, skeleton, focused body, or full body under budget. | Expansion is chunk/symbol based and does not yet use per-language AST body extraction everywhere. | Add exact AST range expansion, multi-node expansion packs, stable citations, and language-specific skeletons. |
| Output presets | `compact` removes snippets for low-token first-pass reads; other presets preserve full subgraph output. | Presets are simple response shaping, not deeply different narrative contracts. | Add `agent_edit`, `debug_trace`, and `review_risk` tailored summaries with `why_these_files`, enough-context verdicts, and required next reads. |
| Reuse discovery | `find_reuse_candidates` merges search hits, owner candidates, symbol similarity, exports, callers, tests, synonyms, and duplicate risk. | Similarity and duplicate detection are heuristic; synonym list is small; no normalized body/signature/import/callee comparison yet. | Add embedding-backed behavior matching, normalized AST-body similarity, import/callee overlap, API compatibility scoring, and stricter false-positive evals. |
| Analyzer plugins | Analyzer interface/registry is in place; TS/JS is reference; Python/Go/Rust/Java tree-sitter analyzers emit symbols/imports/exports/calls. | Non-TS analyzers are syntax extractors, not language-service resolvers; cross-file resolution and framework/test topology remain shallow. | Add cross-file import/call resolution, framework route/test edges, per-language golden evals, and optional LSP/resolver passes where tree-sitter is insufficient. |
| Evaluation | Eval now separates grep-solvable lookup from graph-only flow/reuse wins and tracks path/reuse/freshness/budget metrics. | Fixture set is small and synthetic; grep baseline is literal file search, not a full benchmark suite. | Add multi-repo fixtures, same-name false positives, dynamic routing cases, language matrix dashboards, and regression thresholds per metric. |

## Deferred / Partial Hardening Items

These are the remaining non-final capabilities. Some are absent; some now have a working base implementation but still need hardening before they should be claimed as complete product behavior.

### Status Correction From Current Code

Checked on 2026-06-09 against current source.

Reclassified from "missing" to implemented base slice:

- Watch daemon and background indexing: `src/watch/watch-daemon.ts`, `src/watch/index-scheduler.ts`, `src/watch/event-journal.ts`, and CLI `watch` exist. The remaining work is hardening, not first implementation.
- Watcher event journal replay: journal append/replay/truncate is wired through `FileWatchDaemon.start()` and buffered event flushing. The remaining work is reconciliation after dropped OS watcher events and stress recovery.
- Non-TS analyzer tree-sitter migration: Python, Go, Rust, and Java analyzers now import tree-sitter parsers and share `analyzeWithTreeSitter`. The remaining work is resolver/framework depth, not parser adoption.

Still partial rather than complete:

- Output presets: `compact` has distinct response shaping; `agent_edit`, `debug_trace`, and `review_risk` currently mostly return full reports.
- `expand_node`: file card, skeleton, focused body, and full body exist; exact language-aware AST expansion packs remain future work.
- Citation and reuse evidence: citation fields, `whyReuse`, and `duplicateRisk` exist; normalized evidence across every edge/source and strict duplicate detection remain future work.

### Why These Are Deferred

Most of the gaps are not blocked by feasibility. They were deferred deliberately because the first implementation pass optimized for a verified end-to-end spine: durable indexing, explicit graph contracts, MCP/CLI tools, compact output, reuse detection, multi-language analyzer hooks, and eval gates. The remaining work is where premature depth can easily make the engine confidently wrong or operationally expensive.

| Reason | Applies to | Why it was not completed in the base slice |
| --- | --- | --- |
| Correctness risk | dataflow, dynamic dispatch, same-name disambiguation, non-TS cross-file resolution | Wrong graph edges are worse than missing edges. The base slice prefers explicit missing evidence over invented high-confidence paths. |
| Operational risk | watcher daemon, background indexing, embedding queues, LanceDB migration/repair | These can run continuously, consume paid embeddings, or mutate durable state. They need stronger scheduling, rate limits, retry, and recovery semantics before being automatic. |
| Dependency choice | language servers, watcher supervision/runtime choices, framework-specific parsers/resolvers | Parser adoption has started with tree-sitter for Python/Go/Rust/Java. The remaining dependency choices are resolver depth, LSP integration, framework modules, and production watcher/runtime behavior. |
| Scale uncertainty | large repos, monorepos, generated files, concurrent writes | Synthetic tests prove behavior, not performance ceilings. The next pass needs stress fixtures and instrumentation before optimizing hot paths. |
| Product contract maturity | output presets, reuse guard, enough-context verdicts, review-risk summaries | The base slice establishes raw contracts. The product-shaped response layer should be driven by real agent traces so it does not become decorative JSON. |
| Evaluation coverage | false positives, dynamic routes, incorrect reuse, wrong tests, real embedding quality | Current eval proves several graph-only wins, but not enough negative cases. Harder automation needs stricter eval first. |

The practical split is:

- Base slice completed: enough to run the engine, call tools, get verified subgraphs, detect obvious reuse, and measure wins over grep.
- Deferred intentionally: anything that needs production-grade background automation, deeper language semantics, framework-specific precision, or strong false-positive guarantees.
- Not a blocker: none of the listed gaps require a redesign of the current foundation. They should extend the current contracts rather than replace them.

## Benchmark-Driven Optimization Items

Checked on 2026-06-09 with warmed local sample repositories.

The audit gate proves the base slice. The real repository benchmark matrix shows where the next quality work should go.

Current warmed benchmark observations:

- `bun run benchmark -- --suite core --reuse-index --assert` currently cannot complete because `payload` has no persisted index yet. This is a benchmark-readiness item, not a retrieval-quality result.
- `vite` gated case passes. Diagnostic `vite-resolve-plugins` still misses `packages/vite/src/node/plugins/index.ts` and `packages/vite/src/node/build.ts`.
- `hono-compose-middleware` passes. `hono-context-request` still misses `src/request.ts`.
- `tanstack-query` has two gated failures:
  - `tanstack-react-use-query`: `packages/query-core/src/queryObserver.ts` appears at rank 7, but the gate requires rank <= 6.
  - `tanstack-query-cache-notify`: `packages/query-core/src/notifyManager.ts` is missing.
- `shadcn-ui` has one gated failure:
  - `shadcn-add-registry-resolver`: `packages/shadcn/src/commands/add.ts` is missing while `packages/shadcn/src/registry/resolver.ts` is present.

Next optimization queue:

1. `hono-context-request`: improve request/context relationship retrieval so `src/request.ts` is paired with `src/context.ts` instead of being displaced by helper/middleware/adapter matches.
2. `tanstack-query`: add package/core ownership signals so core files such as `queryObserver.ts` and `notifyManager.ts` are not displaced by adapter packages or examples.
3. `shadcn-ui`: add command-owner and package-scope signals so CLI command files outrank app/example semantic noise when the query asks for a command.
4. `payload`: build or repair the persisted benchmark index so it participates in warmed core gates.
5. Re-run warmed core matrix and promote the gate only after all indexed core repositories pass.

Do not start deeper dynamic dataflow or framework-specific expansion until this owner-quality queue is green. Otherwise new graph depth will amplify the same ranking failures.

### Runtime And Indexing

- Long-running filesystem watcher daemon:
  - Current state: `FileWatchDaemon` watches project roots through `chokidar`, records events into `FileEventJournal`, replays journal paths on start, and is exposed by CLI `watch`.
  - Still missing/hardening: process supervision, long soak tests, dropped-event reconciliation, restart semantics under crashes, and operational guidance for always-on use.
- Background batch index scheduler:
  - Current state: `WatchIndexScheduler` schedules quiet-period background refreshes, marks dirty files as indexing, calls `refreshIndex`, and reschedules while pending/indexing files remain.
  - Still missing/hardening: retry/backoff, embedding rate limits, richer progress reporting, tuned batch sizing, and large-repo concurrency controls.
- True affected-file analysis:
  - Current state: persisted writes are incremental; unchanged graph/vector rows are preserved.
  - Missing: analyzer/resolver work is still broad. It does not yet recompute only the changed file plus dependency neighbors.
- Watcher event journal replay:
  - Current state: `FileEventJournal` appends JSONL events, replays paths, and is replayed/truncated by `FileWatchDaemon`.
  - Still missing/hardening: reconciliation scans after dropped OS watcher events, journal compaction/retention policy, and stress coverage for crash/restart windows.
- Large-repo stress and concurrency controls:
  - Current state: base tests use small synthetic fixtures.
  - Missing: limits for parallel analyzer jobs, concurrent LanceDB writes, very large file counts, permission errors, path-case changes, and generated directory churn.

### Retrieval And Subgraph Quality

- Weighted path search:
  - Current state: `SubgraphBuilder` uses prioritized graph traversal.
  - Missing: proper weighted path ranking, branch pruning, path diversity, and confidence-calibrated scoring.
- Real coverage summary:
  - Current state: subgraphs expose coverage signals.
  - Missing: a single `coverageSummary` / "enough for edit" contract shared by context, impact, flow, and review outputs.
- `why_these_files` explanation:
  - Current state: nodes/edges contain reasons and citations.
  - Missing: a concise per-file role explanation optimized for agent reading.
- Same-name false-positive hardening:
  - Current state: seed matching and graph traversal work for simple fixtures.
  - Missing: robust disambiguation when unrelated symbols share names across files/modules/packages.
- Dynamic dispatch and reflection:
  - Current state: static calls/imports/framework rules only.
  - Missing: runtime/dynamic dispatch, dependency injection containers, string-built method names, reflection, and plugin registries.

### Impact Analysis

- Diff-based `explain_impact` seeds:
  - Current state: `explain_impact` accepts symbol/file-like targets.
  - Missing: first-class unified diff input, changed symbol extraction, changed field/type extraction, and per-hunk impact.
- Public API boundary taxonomy:
  - Current state: exported symbols increase risk.
  - Missing: package entrypoints, route contracts, generated clients, database schema fields, public event names, config keys, and external SDK-facing APIs.
- Type/field blast radius:
  - Current state: call/file/symbol edges drive impact.
  - Missing: "renamed field", "changed type", "removed enum variant", and "schema migration" impact propagation.
- Test gap scoring:
  - Current state: missing `tested_by` raises risk.
  - Missing: severity based on test type, test freshness, coverage scope, and changed behavior category.

### Flow Tracing

- True dataflow/taint tracking:
  - Current state: flow follows structural edges.
  - Missing: request body, params, headers, auth/session objects, DB rows, and event payload tracking across function boundaries.
- Dynamic URL and API wrapper resolution:
  - Current state: static `fetch('/api/...')` is handled for Next.js basics.
  - Missing: axios, custom API clients, template-string URLs, route builders, generated clients, and shared fetch wrappers.
- Framework rule modules:
  - Current state: framework topology remains concentrated around Next.js/static rules.
  - Missing: separate rule modules for Next.js App/Pages, Express, Fastify, NestJS, Remix, React Router, FastAPI, Flask, Go HTTP, Axum/Actix, Spring, and common ORM/repository patterns.
- Repository/ORM precision:
  - Current state: resource read/write edges are static heuristics.
  - Missing: Prisma/Drizzle/TypeORM/Sequelize/SQLAlchemy/GORM/JPA-specific model/table/operation resolution.

### Agent Output And Expansion

- Full preset contracts:
  - Current state: `compact` strips snippets; other presets mostly preserve the full subgraph.
  - Missing: distinct `agent_edit`, `debug_trace`, and `review_risk` response shapes with tailored summaries and required next actions.
- Exact AST range expansion across languages:
  - Current state: `expand_node` expands indexed chunks and uses existing TS/JS skeleton support.
  - Missing: precise language-aware body extraction for Python/Go/Rust/Java, nested symbol expansion, and multi-node expansion packs.
- Citation normalization:
  - Current state: citations exist on many nodes/edges.
  - Missing: a normalized citation schema across snippets, edges, tests, framework rules, resource rules, and reuse evidence.

### Reuse And Duplicate Prevention

- Dedicated `reuse_guard` mode/tool:
  - Current state: `find_reuse_candidates` exists.
  - Missing: a stricter pre-edit guard that returns a pass/block/needs-human-review decision before code generation.
- Normalized duplicate detection:
  - Current state: duplicate risk is heuristic.
  - Missing: normalized AST body similarity, signature compatibility, import/callee overlap, identical literals/errors/routes, and fixture/test overlap.
- Rich behavior matching:
  - Current state: synonym expansion catches basic examples like rate limiting/token bucket.
  - Missing: embedding-backed behavior similarity calibrated with real models, domain vocabulary expansion, and false-positive suppression.
- Reuse action plan:
  - Current state: candidates include `whyReuse` and next queries.
  - Missing: explicit "call this / extend this / wrap this / do not reuse because..." checklist with code-level integration guidance.

### Multi-Language Structural Support

- Tree-sitter-backed analyzers:
  - Current state: Python/Go/Rust/Java use tree-sitter parsers through `analyzeWithTreeSitter`.
  - Still missing/hardening: richer syntax coverage for comments/docstrings, nested symbols, decorators/annotations, generics, traits/interfaces, parser-error reporting, and per-language golden evals.
- Cross-file resolution for non-TS languages:
  - Current state: non-TS calls/imports are mostly local/unresolved graph facts.
  - Missing: import/package/module resolution, symbol definition resolution, call target resolution, and alias handling.
- Language-specific test topology:
  - Current state: `tested_by` is strongest for TS/JS import-based tests.
  - Missing: pytest subject edges, Go `_test.go` subject edges, Rust cargo test/module edges, JUnit/Spring test edges.
- Language-specific framework topology:
  - Current state: TS/JS + Next.js has the highest-confidence topology.
  - Missing: FastAPI/Flask, Go HTTP/Gin/Echo, Axum/Actix, Spring MVC/WebFlux, and Java annotation route/service/repository edges.

### Evaluation And Product Readiness

- Multi-repo benchmark suite:
  - Current state: eval fixtures are synthetic and small.
  - Missing: real-world repositories, large monorepos, mixed-language projects, generated-code-heavy repos, and noisy test layouts.
- False-positive metrics:
  - Current state: eval checks several positive retrieval paths.
  - Missing: unrelated same-name false positives, incorrect reuse false positives, wrong test association, and invented dynamic edges.
- Performance dashboards:
  - Current state: eval reports JSON metrics.
  - Missing: trend history, baseline comparison reports, latency/IO/embedding-cost metrics, and CI failure thresholds by category.
- Real embedding calibration:
  - Current state: deterministic embedding is used for offline smoke tests.
  - Missing: eval profile for actual embedding providers/models, dimension migration tests, and quality/latency/cost tradeoff baselines.

## Phase 0: Runtime Readiness And Indexing Economics

Goal: make the durable store actually save work across process boundaries.

This phase must land before broad multi-language expansion. Otherwise every new analyzer will amplify the same operational problems: repeated scans, repeated embeddings, stale session state, and weak resistance to large file bursts.

### Phase 0A: Persisted Workspace And No-Reindex Reads

Status: completed on 2026-06-08. SQLite now persists project identity, engine read paths hydrate persisted workspace state, and CLI/MCP default read surfaces can use durable SQLite instead of process-local memory. CLI cross-process smoke covers `search`, `context`, `impact`, and `tests` without implicit reindex.

- Persist or hydrate project registry state from the graph store.
- Add a read path where CLI/MCP can search an already-indexed repo without forced full reindex.
- Split CLI commands into explicit `index` and no-reindex read commands, with a clear error when no persisted index exists.
- Add smoke tests proving a repo indexed in one process can be searched in a new process.
- Keep explicit `refresh_index` for user-requested reindexing.

Acceptance:

- A repo indexed in one process can be searched in a new process without full reindex.
- CLI `search`, `context`, `impact`, and `tests` can use persisted state when available.
- Missing persisted index returns a clear diagnostic instead of silently doing broad work.

### Phase 0B: Incremental Indexing And Generations

Status: completed base slice on 2026-06-08. Indexing now scans hashes, persists monotonic `indexGeneration`, updates graph/FTS/vector rows only for changed/deleted files, preserves unchanged file row generations, and exposes generation through `index_status`. The current implementation still rebuilds the in-memory AST/topology analysis snapshot to preserve relationship quality; a later optimization can narrow AST/topology recomputation to affected files and neighbors.

- Implement changed-file indexing:
  - scan hashes;
  - delete changed/removed file rows;
  - analyze only changed files;
  - re-resolve affected cross-file edges;
  - update semantic chunks only for changed files.
- Make `indexGeneration` monotonic per project and persist it.
- Add stale/pending/indexing states that survive process restart.

Acceptance:

- Editing one file does not re-embed every unchanged chunk.
- Deleted files remove graph rows, FTS rows, and vector rows.
- `index_status` reports a persisted generation greater than `1` after multiple updates.
- Retrieval excludes stale affected files and reports freshness warnings.

### Phase 0C: Watcher And Burst-Change Resistance

Status: completed base slice on 2026-06-09. The runtime now has a reusable event coalescer, persisted dirty-file state, burst-mode/dropped-event accounting, `record_file_events` MCP support, CLI `record-events` and `status` commands, and `index_status`/context freshness surfaces that report dirty pending files across process restarts. Retrieval filters dirty indexed files while continuing to serve clean last-known-good indexed context. The long-running `FileWatchDaemon`, `FileEventJournal` replay, and `WatchIndexScheduler` are also implemented as base behavior. The next optimization layer is production hardening: supervision, stress tests, dropped-event reconciliation, retry/backoff, embedding-rate limits, and large-repo concurrency controls.

- Add a repository watcher service after changed-file indexing exists:
  - watch project roots;
  - debounce noisy events;
  - coalesce file paths into batches;
  - verify events by hash/scan before indexing;
  - persist an event journal or dirty-file table;
  - expose watcher state in `index_status`.
- Add burst-change resistance:
  - detect when changed-file count crosses a threshold;
  - switch to project-level rescan instead of processing every event one by one;
  - rate-limit embedding work;
  - cap concurrent analyzers and LanceDB writes;
  - keep serving last-known-good indexed context while marking affected files stale;
  - report `indexingFiles`, `pendingFiles`, `droppedEvents`, and `burstMode` explicitly.
- Add filesystem edge-case handling:
  - atomic rename/write temp files;
  - delete-create cycles;
  - generated directories appearing mid-scan;
  - watcher event loss;
  - permission/read errors;
  - path case changes on Windows.

Acceptance:

- Rewriting hundreds of files in a script does not start hundreds of independent index jobs.
- During a burst, retrieval excludes stale affected files and returns explicit freshness warnings instead of mixing old and new graph state.
- Watcher loss or process restart recovers from persisted dirty state by scanning hashes.
- `index_status` exposes `indexingFiles`, `pendingFiles`, `droppedEvents`, and `burstMode`.

### Phase 0D: LanceDB Embedding Profile Guard

Status: completed on 2026-06-08. LanceDB semantic storage now writes a durable embedding profile sidecar per table, including schema version, table name, provider, model/base URL when configured, request-dimensions flag, and actual vector dimensions. Upsert/search check the persisted profile before using a table and fail closed with explicit diagnostics on dimension/model/provider/profile mismatch. Legacy tables without a profile are migrated by writing the current profile on first guarded use.

- Add LanceDB embedding profile metadata:
  - provider;
  - model;
  - dimensions;
  - table schema version.
- Fail closed, recreate, or migrate LanceDB tables when embedding dimensions/model profile mismatch.

Acceptance:

- Changing embedding dimensions produces an explicit diagnostic before LanceDB write/search fails.
- Existing `.ragcode/lancedb` tables cannot be accidentally queried with the wrong embedding profile.
- Real embedding model evals are run separately from deterministic embedding smoke tests.

## Target Contract: Verified Code Subgraph

Create a single agent-facing contract used by `impact_analysis`, `trace_flow`, and future flow tools:

```ts
interface VerifiedCodeSubgraph {
  query: string;
  repoRoot: string;
  projectId: string;
  mode: "impact" | "flow" | "review" | "debug";
  answerable: boolean;
  confidence: "low" | "medium" | "high";
  nodes: SubgraphNode[];
  edges: VerifiedSubgraphEdge[];
  snippets: ContextSnippet[];
  coverage: CoverageSignal[];
  missingEvidence: string[];
  nextQueries: string[];
  budgetChars: number;
  usedChars: number;
}
```

Rules:

- Every returned edge must have a source: AST, LSP, framework rule, test import, or explicit heuristic.
- Every high-confidence edge must include file path and line-level evidence where available.
- Return path-shaped answers first: caller -> callee -> route -> service -> test.
- Expand code only after the subgraph is selected.
- Prefer skeleton/focused bodies over full files.
- If the graph is incomplete, say exactly which edge type or hop is missing.

## Phase 1: Harden Existing TS/JS Relation Search

Goal: make current TypeScript/JavaScript graph reliable enough to be the reference implementation for other languages.

Status: completed base slice on 2026-06-08. `VerifiedCodeSubgraph` is now a first-class contract with nodes, verified edges, paths, coverage signals, budgeted snippets, missing evidence, and next queries. `SubgraphBuilder` emits ordered flow/impact paths and is wired through `RagCodeEngine.verifiedSubgraph()`. Regression coverage proves `CheckoutButton -> route.ts -> billing.ts -> billing.test.ts` flow paths and transitive impact callers stay under budget.

Deliverables:

- Add `VerifiedCodeSubgraph` types.
- Add a `SubgraphBuilder` that takes seeds, graph edges, and budget and emits path-shaped output.
- Upgrade `impact_analysis` from flat files/edges to:
  - direct callers;
  - transitive callers up to configured hops;
  - related tests;
  - public/exported boundary;
  - unresolved or heuristic-only edges.
- Upgrade `trace_flow` from flat outgoing steps to ordered paths.
- Add `coverage` signals:
  - `primary_owner_found`;
  - `inbound_callers_checked`;
  - `outbound_flow_checked`;
  - `tests_checked`;
  - `unresolved_edges_present`;
  - `budget_truncated`.
- Add line references to high-confidence edges where metadata already has `line`.

Acceptance:

- For the payment fixture, one call returns `CheckoutButton -> route.ts -> billing.ts -> webhook route -> billing.test.ts`.
- Context output stays under budget and does not return full large files.
- Missing dynamic/unknown edges are visible in `missingEvidence`.

## Phase 2: Blast Radius As The First-Class Tool

Goal: answer "what will break if I change this function/file/field?" better than grep.

Status: completed base slice on 2026-06-08. `explain_impact` is available through MCP and CLI as a verified blast-radius report over `VerifiedCodeSubgraph`, with risk score, risk reasons, and edit-readiness guidance. The legacy `impact_analysis` remains available for compatibility.

Deliverables:

- Add `explain_impact` MCP/CLI command as the polished version of `impact_analysis`.
- Support seed types:
  - file path;
  - symbol name;
  - `filePath:symbol`;
  - diff changed files.
- Classify impact:
  - `direct_callers`;
  - `transitive_callers`;
  - `route_entrypoints`;
  - `tests`;
  - `exports/public_api`;
  - `unresolved_possible_callers`.
- Add risk scoring based on graph degree, exported/public boundary, tests missing, and unresolved edge count.
- Add a review-mode output that says: "safe to edit after reading these nodes" or "not enough context yet".

Acceptance:

- Renamed import and aliased import call paths are counted once and not confused with same-name unrelated symbols.
- Related tests are returned through explicit `tested_by` edges when available.
- A changed exported function without related tests reports higher risk than an internal leaf function.

## Phase 3: Request/Data Flow Tracing

Goal: answer "how does this request/data move from A to B?" as graph traversal, not similarity search.

Status: completed base slice on 2026-06-08. `trace_request_flow` is available through MCP and CLI and returns ordered flow-mode verified subgraphs. Current high-confidence coverage remains strongest for TS/JS plus Next.js static route/client/service/test paths.

Deliverables:

- Add `trace_request_flow` as a dedicated contract over `VerifiedCodeSubgraph`.
- Extend framework topology beyond the current Next.js basics:
  - client `fetch`/API wrapper -> route;
  - route -> middleware -> service;
  - service -> repository/ORM;
  - webhook/event handler -> service;
  - test -> subject.
- Harden existing `reads_from`, `writes_to`, `handles_event`, and `uses_middleware` heuristics with confidence labels and citations.
- Add framework rule modules instead of growing one monolithic `framework-topology.ts`.

Acceptance:

- A route-to-service-to-repository path is returned in order.
- If DB writes are inferred heuristically, edge confidence is not high.
- The final answer includes both path and minimal snippets.
- Dynamic or wrapper-based calls that cannot be resolved appear as missing coverage, not invented high-confidence edges.

## Phase 4: Multi-Language Analyzer Architecture

Goal: add languages without rewriting the core graph, retrieval, or context pack pipeline.

Status: completed base slice on 2026-06-09. The analyzer plugin interface, registry, fallback analyzer, and TypeScript/JavaScript reference analyzer are in place. Python, Go, Rust, and Java now use tree-sitter-backed analyzers that produce non-trivial symbols/imports/exports/calls instead of falling back to 80-line chunks only. These analyzers are intentionally syntax extractors, not full LSP/cross-file resolvers; richer resolver/framework passes remain future hardening work.

Deliverables:

- Introduce an analyzer plugin interface:

```ts
interface LanguageAnalyzer {
  language: LanguageId;
  analyzeFile(input: AnalyzeFileInput): FileAnalysis;
}
```

- Split the current TypeScript analyzer into `src/indexing/analyzers/typescript-analyzer.ts`.
- Add capability flags per analyzer:
  - symbols;
  - imports;
  - exports;
  - calls;
  - definitions;
  - framework routes;
  - tests.
- Add per-language golden fixtures and eval metrics.
- Update docs so language support distinguishes indexed-as-lines from structural graph support.

Priority:

1. TypeScript/JavaScript polish: keep as reference implementation.
2. Python: functions/classes/imports/calls, FastAPI/Flask route edges, pytest subject edges.
3. Go: packages/functions/methods/imports/calls, HTTP handler edges, `_test.go` subject edges.
4. Rust: modules/functions/impl/traits/imports/calls, Axum/Actix route heuristics, cargo test edges.
5. Java: classes/methods/imports/calls, Spring route/service edges, JUnit subject edges.

Parser strategy:

- Keep TypeScript compiler API for TS/JS because it already supports LSP/definition resolution.
- Use tree-sitter for Python/Go/Rust/Java syntax extraction.
- Add optional language-specific resolver passes where tree-sitter alone is insufficient.

Acceptance:

- Non-TS languages no longer fall back to 80-line chunks only.
- Each supported language returns symbols, imports, and at least local call edges.
- Unsupported capabilities are explicit in coverage, not silently invented.

## Phase 5: Agent Pain Polish

Goal: make the output useful for an AI agent that is about to edit code.

Status: completed base slice on 2026-06-08. Verified subgraph outputs now include coverage signals, missing evidence, path-shaped nodes/edges, budgeted snippets, and concrete `nextQueries`. `expand_node` is available through MCP and CLI for focused/skeleton/full expansion after a compact subgraph.

Pain points observed:

- Raw snippets are still too chunk-shaped; the agent needs path-shaped context.
- Edge confidence is not prominent enough.
- "I have enough" is currently implicit; it should be a signal.
- Follow-up queries are generic; they should be derived from missing graph coverage.
- MCP JSON output is correct but not optimized for fast agent reading.
- Current read tools still force broad results too often; the agent needs a compact subgraph first and expansion second.
- Agents often reimplement existing helpers, services, hooks, or components when the user forgets to mention them. The engine needs a reuse guard before code generation.

Deliverables:

- Add `coverageSummary` to context/subgraph outputs:
  - enough for low-risk edit;
  - enough for investigation only;
  - not enough, run these next queries.
- Add `citation` objects for snippets and edges:
  - file path;
  - line;
  - symbol;
  - resolver source.
- Add `expand_node` tool for on-demand focused body expansion after a compact subgraph.
- Add `why_these_files` explanation that maps each file to its graph role.
- Add output presets:
  - `compact`;
  - `agent_edit`;
  - `debug_trace`;
  - `review_risk`.
- Keep the existing MCP stdio server, but add tool-level response shaping so clients can request compact vs expanded output.

Acceptance:

- A normal impact answer fits in a small budget without losing the call chain.
- The agent can ask one follow-up to expand a node instead of re-running broad search.
- Missing coverage produces specific next actions, not generic "search more".

## Phase 6: Reuse Discovery And Duplicate Prevention

Goal: prevent agents from implementing a second copy of behavior that already exists.

Status: completed base slice on 2026-06-08. `find_reuse_candidates` is available through MCP and CLI. It merges hybrid hits, owner candidates, symbol/API similarity, export status, caller count, tested_by evidence, domain synonym expansion, duplicate risk, and next expansion/impact queries. Regression coverage proves a "rate limiting" request surfaces existing `tokenBucket` / `throttleRequests` implementations despite the naming gap.

Why this matters:

- Users often forget to mention existing utilities, services, hooks, or components.
- Users may not know what prior AI-written code exists.
- Pure grep only catches exact names; semantic search alone can miss canonical owners or suggest unrelated chunks.
- The agent needs a pre-edit reuse check that says: reuse, extend, wrap, or implement new.

Deliverables:

- Add a `find_reuse_candidates` MCP/CLI tool.
- Add a `reuse_guard` mode for feature/refactor requests before implementation.
- Return a task-shaped result:

```ts
interface ReuseCandidateReport {
  query: string;
  decision: "reuse" | "extend" | "wrap" | "implement_new" | "uncertain";
  confidence: "low" | "medium" | "high";
  candidates: ReuseCandidate[];
  duplicateRisk: "low" | "medium" | "high";
  missingEvidence: string[];
  nextQueries: string[];
}
```

- Score candidates by:
  - semantic similarity to requested behavior;
  - symbol/API name similarity;
  - exported/public availability;
  - graph centrality and number of callers;
  - test coverage;
  - freshness;
  - same domain/module proximity.
- Classify candidates:
  - existing helper/function;
  - service method;
  - React hook/component;
  - API/client wrapper;
  - type/interface/schema;
  - test fixture/mock;
  - config/constant.
- Add `why_reuse` evidence:
  - file path;
  - symbol;
  - signature;
  - callers;
  - related tests;
  - snippet or skeleton;
  - reason this is safer than a new implementation.
- Add duplicate-risk detection:
  - similar symbol names;
  - similar signatures;
  - similar normalized bodies;
  - similar imports/callees;
  - same output strings/errors/routes;
  - same tests or fixtures.
- Add an agent-facing checklist:
  - call this;
  - extend this;
  - wrap this;
  - do not reuse because...;
  - new implementation justified because....

Acceptance:

- Given a request like "add rate limiting", the tool can surface existing `tokenBucket`, `throttle`, or middleware utilities even when the query wording differs.
- Given a request to create a component/hook/service, the tool returns nearby existing exports before recommending new code.
- If a candidate is stale, untested, private, or only heuristically similar, the report lowers confidence instead of forcing reuse.
- A regression that recommends implementing new code while a high-confidence reusable export exists fails.

## Phase 7: Evaluation And Regression Harness

Goal: make "better than grep" measurable.

Status: completed base slice on 2026-06-08. The context eval harness now includes verified subgraph path completeness, impact caller recall, reuse candidate recall, duplicate false-negative rate, and literal grep baseline metrics. The report separates grep-solvable known-symbol lookup from graph-only flow/reuse wins.

Deliverables:

- Add eval fixtures for each pain class:
  - grep-free known symbol lookup baseline;
  - lexical gap retrieval;
  - impact/blast radius;
  - request/data flow;
  - enough-context decision.
  - reuse/duplicate-prevention decision.
- Add metrics:
  - path completeness;
  - caller recall;
  - unrelated same-name false positives;
  - related test recall;
  - unresolved edge rate;
  - context budget efficiency;
  - full-body violation count;
  - coverage signal accuracy.
  - reusable candidate recall;
  - duplicate false-negative rate;
  - incorrect reuse false-positive rate.
- Add a grep baseline script that proves which cases grep solves and which it cannot.

Acceptance:

- The eval report separates table-stakes grep cases from graph-only wins.
- A regression that returns unrelated same-name callers fails.
- A regression that omits related tests for an impact query fails.
- A regression that misses an existing reusable implementation fails.

## Suggested Execution Order

1. Phase 0A: persisted workspace registry and no-reindex read paths.
2. Phase 0B: changed-file indexing and generation increments.
3. Phase 0C: watcher, dirty-state persistence, and burst-change resistance.
4. Phase 0D: LanceDB embedding profile/dimension guard.
5. `VerifiedCodeSubgraph` types and builder.
6. `explain_impact` on TS/JS with coverage signals.
7. `trace_request_flow` on TS/JS/Next.js fixture.
8. `expand_node` and compact output presets.
9. `find_reuse_candidates` and `reuse_guard`.
10. Analyzer plugin interface.
11. Python analyzer.
12. Go analyzer.
13. Rust analyzer.
14. Java analyzer.
15. Grep baseline and cross-language eval dashboard.

## Stop Condition For This Phase

This phase is complete when:

- an agent can call one impact tool and receive a minimal, cited, verified blast-radius subgraph;
- an agent can call one flow tool and receive an ordered request/data path;
- the output includes enough/missing coverage signals;
- persisted SQLite/LanceDB state is usable across processes without forced full reindex;
- unchanged files are not re-embedded on every index refresh;
- an agent can run a reuse guard and get a cited recommendation before implementing new behavior;
- TypeScript/JavaScript remains the highest-confidence implementation;
- at least Python and Go have non-trivial symbol/import/call indexing;
- eval proves graph-only wins separately from grep-solvable cases.
