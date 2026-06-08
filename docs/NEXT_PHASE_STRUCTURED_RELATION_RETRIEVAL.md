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

Still true or partially true:

- CLI commands still re-index before most reads, so persistent SQLite does not yet remove repeated indexing work for CLI usage.
- Project registry/session state is not hydrated from persisted SQLite rows; a new process cannot fully use persisted graph state without re-registering/indexing the workspace.
- Indexing is still full reset plus full semantic re-embed; unchanged files still cost time and real embedding money.
- File watching is not implemented yet. Current freshness is request-time scan/hash comparison; watcher/debounce only exists in docs as a target.
- Large burst changes are not handled as a distinct mode. A script that rewrites many files will currently create many pending/stale files and the next refresh still falls back to full reindex.
- `indexGeneration` and row `generation` are always `1`, so generation-based invalidation is not real yet.
- The default deterministic embedding is not semantic; it is an offline test signal. Real embedding models need separate eval calibration.
- LanceDB table dimension/model compatibility is not guarded. Existing tables can conflict after provider/model/dimension changes.
- Non-TS/JS files still fall back to line chunks; `LanguageId` promises more than the analyzer layer delivers.
- Framework topology remains mostly Next.js and static pattern based. Dynamic URLs, axios/API wrappers, other frameworks, and richer repository/ORM patterns are incomplete.
- `related` remains an unused edge kind and should either gain a producer or be removed from the public contract.
- `traceFlow` and `impactAnalysis` are still flat lists, not path-shaped verified subgraphs.
- Existing `find_owner` and hybrid search can find related files, but they do not yet answer the reuse question: "has this behavior already been implemented, and should the agent call, extend, or wrap it instead of writing another version?"

## Phase 0: Runtime Readiness And Indexing Economics

Goal: make the durable store actually save work across process boundaries.

This phase must land before broad multi-language expansion. Otherwise every new analyzer will amplify the same operational problems: repeated scans, repeated embeddings, stale session state, and weak resistance to large file bursts.

### Phase 0A: Persisted Workspace And No-Reindex Reads

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
