# Stability And Topology Plan

Status: historical/completed planning baseline. For the active next-phase execution plan, use `docs/NEXT_PHASE_STRUCTURED_RELATION_RETRIEVAL.md`.

This plan covers the two missing foundations that must be solved before RagCode can become a serious context engine:

1. index freshness under fast, messy file changes;
2. resolved AST + LSP topology across frontend, API, service, and webhook paths.
3. strict multi-project isolation so one repository never leaks into another repository's retrieval results.
4. context-size control through skeletonization and graph-distance reranking so large projects do not dump raw code into the AI context.

The target is not just better search. The target is a context compiler that can say which evidence is fresh, which evidence is stale, and how a request flows across real code owners.

## Final Output Model

The AI should not receive an unstructured list of files or raw search hits. The AI receives one task-shaped `ContextPack`.

```text
AST / LSP / SQLite / LanceDB / graph reranking / skeletonization / freshness / workspace scope
  -> Context Compiler
  -> ContextPack
```

Each subsystem has a clear responsibility:

```text
WorkspaceResolver      -> project isolation and active scope
SQLite/AST/LSP         -> verifiable code facts
LanceDB                -> semantic candidate recall
Graph reranking        -> logical relevance and owner priority
Skeletonization        -> how much code to return per file
Freshness              -> whether cached evidence can be trusted
ContextPack            -> the only normal AI-facing retrieval output
```

Target shape:

```ts
interface ContextPack {
  query: string;
  mode: ContextMode;
  answerable: boolean;
  confidence: "low" | "medium" | "high";

  freshness: FreshnessReport;

  ownerChain: OwnerNode[];
  topology: TopologyEdge[];

  snippets: EvidenceSnippet[];

  missingEvidence: string[];
  nextQueries: string[];
}
```

The important product rule:

```text
AI should first understand ownerChain and topology, then inspect snippets.
```

Snippets are evidence, not the primary organization of the answer.

## Current State

Already implemented:

- TypeScript/JavaScript AST bootstrap via TypeScript compiler API.
- Symbol extraction for functions, classes, methods, types, and top-level variables.
- Basic graph edges: `contains`, `imports`, `exports`, `calls`.
- Mode-aware context compiler.
- Agent tools: `get_context`, `find_owner`, `impact_analysis`, `related_tests`, `trace_flow`, `review_diff`.

Not yet implemented:

- Persistent SQLite graph store.
- File watcher and pending/stale state.
- Transactional per-file reindexing.
- LanceDB delete-before-upsert semantics by file.
- Import/export resolution to real symbol IDs.
- LSP definition/reference/type bridge.
- Cross-file call graph.
- Framework topology recognition for React, API routes, middleware, services, and webhooks.

## Design Principle

Filesystem is truth.

SQLite and LanceDB are caches with freshness metadata. Any context pack that uses cache-derived data must be able to report freshness and stale/pending files.

```text
current file/diff overlay > fresh direct file read > SQLite graph > LanceDB semantic recall
```

Project isolation is a hard boundary, not a ranking hint. The AI should not be responsible for passing `projectId` or even `repoRoot` in normal tool calls. The server resolves workspace scope automatically.

```text
MCP client roots / cwd / filePath -> WorkspaceResolver -> ActiveProjectScope -> projectId -> index namespace -> query scope
```

No tool should search across projects unless the request explicitly opts into a future cross-project mode. The default and current mode is single-project only.

Resolution rule:

```text
auto resolve one workspace -> search that project
ambiguous workspace -> reject with ambiguity error
no workspace -> reject with missing workspace error
never fall back to global search
```

## Phase 0: Project Isolation Contract

Goal: prevent retrieval, graph traversal, vector search, and cache state from mixing unrelated repositories.

### New Modules

- `src/project/project-identity.ts`
  - computes stable `projectId`.
  - normalizes `repoRoot`.
  - records git remote/head when available.

- `src/project/project-registry.ts`
  - maps `repoRoot` to `projectId`.
  - stores project metadata.
  - prevents ambiguous roots.

- `src/project/workspace-resolver.ts`
  - resolves active workspace from MCP roots, cwd, filePath hints, and indexed projects.
  - owns automatic workspace switching.

- `src/project/scope.ts`
  - validates that every query has exactly one active project scope.
  - rejects accidental cross-project access.

- `src/mcp/session-scope.ts`
  - stores per-session active project.
  - updates active project when workspace roots or file hints change.

### Project Identity

```ts
interface ProjectIdentity {
  projectId: string;
  repoRoot: string;
  canonicalRoot: string;
  displayName: string;
  gitRemote?: string;
  gitHead?: string;
  createdAtMs: number;
  lastIndexedAtMs?: number;
}
```

`projectId` should be stable for one checkout but should not collide with another checkout. A good first implementation:

```text
sha256(canonicalRoot + gitRemote?)
```

For cloned copies of the same remote, root path remains part of the identity so their indexes stay separate.

### Required Behavior

- Normal public tool input does not require AI-provided `repoRoot` or `projectId`.
- Every public tool call must resolve to one `projectId` before touching stores.
- Every storage row includes `projectId`.
- Every SQLite query filters by `projectId`.
- Every LanceDB query filters by `projectId`.
- Every graph traversal starts from nodes inside the same `projectId`.
- `repoRoot` path validation prevents escaping the project root.
- Default MCP session state has one active project scope.
- Workspace changes automatically switch the active project when they resolve unambiguously.
- If multiple indexed projects match and no active scope can be inferred, the tool rejects the call.
- Cross-project retrieval is not allowed until an explicit future `multi_project_search` tool exists.

### Acceptance Criteria

- Tool calls can omit `repoRoot` when server session has an active workspace.
- Indexing project A and project B with identical filenames keeps rows separate.
- Searching project A never returns project B files.
- Ambiguous workspace returns an explicit error and performs no search.
- LanceDB semantic search filters by `projectId`.
- `impact_analysis` cannot traverse into another project.
- Tests include two temp repos with same file names and different content.

## Project-Scoped Tool Contract

All current tools stay single-project and should be callable without AI passing `projectId`. `repoRoot` becomes an optional override or indexing target, not a normal retrieval requirement.

- `index_repo`
- `search_code`
- `get_context`
- `find_symbol`
- `explain_file`
- `find_owner`
- `impact_analysis`
- `related_tests`
- `trace_flow`
- `review_diff`

Each tool must resolve:

```text
workspace hint / active session / cwd / filePath -> ProjectIdentity -> projectId
```

Then all downstream stores receive both canonical `repoRoot` and `projectId`.

Do not use raw `repoRoot` as the only storage partition once persistent storage lands. Paths can be renamed, symlinked, or passed in different textual forms. `repoRoot` is input; `projectId` is the storage namespace.

### Retrieval Tool Input Shape

Target shape:

```ts
interface WorkspaceHint {
  root?: string;
  filePath?: string;
}

interface ScopedToolInput {
  workspace?: WorkspaceHint;
}
```

Example:

```ts
get_context({
  query: "how should we modify the payment flow?",
  mode: "feature",
  workspace: { filePath: "apps/web/src/checkout/Button.tsx" }
})
```

If `workspace` is omitted, the server uses the active MCP session workspace. AI should not provide `projectId`.

### Workspace Resolution Priority

1. `workspace.filePath` if present and inside exactly one known project.
2. `workspace.root` if present and resolves to a known or indexable project.
3. MCP client workspace roots, when provided by the transport/session.
4. Server startup `cwd`, resolved to nearest git root or package root.
5. Single indexed project fallback.
6. Otherwise reject as ambiguous or missing workspace.

### Session Scope

```ts
interface WorkspaceSession {
  activeProjectId: string;
  activeRepoRoot: string;
  knownProjects: ProjectIdentity[];
  resolvedFrom: "filePath" | "root" | "mcp_roots" | "cwd" | "single_project";
}
```

The session scope is server-owned. It is not an AI prompt convention.

## Phase 1: Index Freshness Core

Goal: make the index resilient when files change quickly, are renamed, or are generated by tooling.

### New Modules

- `src/state/index-state.ts`
  - owns `IndexGeneration`, file status, and freshness summaries.

- `src/storage/sqlite-graph-store.ts`
  - persistent replacement for `InMemoryGraphStore`.
  - owns files, symbols, edges, chunks metadata, and FTS tables.

- `src/indexing/incremental-indexer.ts`
  - compares content hashes.
  - deletes old per-file graph rows.
  - inserts new per-file graph rows transactionally.

- `src/indexing/watch-service.ts`
  - debounced file watcher.
  - marks files `pending`, then `indexing`, then `fresh`.

- `src/indexing/ignore-policy.ts`
  - central ignore rules for generated/dependency/build artifacts.

### SQLite Tables

```sql
projects(project_id, repo_root, canonical_root, display_name, git_remote, git_head, created_at_ms, last_indexed_at_ms)
files(project_id, path, language, content_hash, modified_at_ms, indexed_at_ms, status, generation)
symbols(project_id, id, file_path, name, kind, start_line, end_line, signature, exported, generation)
edges(project_id, id, source_id, target_id, kind, metadata_json, file_path, generation)
chunks(project_id, id, file_path, kind, symbol_name, start_line, end_line, content_hash, generation)
chunks_fts(project_id, id, file_path, symbol_name, content)
index_meta(project_id, key, value)
```

Primary/unique keys must include `project_id` where appropriate:

```sql
unique(project_id, path)
unique(project_id, id)
```

### File Status

```ts
type FileIndexStatus =
  | "fresh"
  | "pending"
  | "indexing"
  | "stale"
  | "deleted"
  | "ignored"
  | "error";
```

### Required Behavior

- A changed file is never partially visible.
- Reindexing one file happens inside one transaction.
- Deleted files remove old symbols, edges, chunks, and vectors.
- Renamed files are treated as delete + add.
- Generated and build outputs are ignored by default.
- Large files are skipped with explicit reason metadata.
- `get_context` reports `freshness`.

### Context Freshness Contract

Add to `ContextPack`:

```ts
interface FreshnessReport {
  projectId: string;
  indexGeneration: number;
  indexedAtMs: number;
  staleFiles: string[];
  pendingFiles: string[];
  indexingFiles: string[];
  skippedFiles: Array<{ filePath: string; reason: string }>;
}
```

### Acceptance Criteria

- Editing one file only reindexes that file.
- Deleting one file removes old hits from `search_code` and `get_context`.
- A pending changed file appears in `freshness.pendingFiles`.
- Query results never include chunks from deleted files.
- Tests cover changed, deleted, ignored, and stale files.

## Phase 2: LanceDB Consistency Layer

Goal: make semantic recall obey the same freshness model as SQLite.

### New Modules

- `src/semantic/vector-sync.ts`
  - deletes old vectors by `repoRoot + filePath`.
  - inserts new chunk vectors.
  - records vector generation.

- `src/semantic/vector-state.ts`
  - checks whether vectors match current file generation.

### LanceDB Row Contract

```ts
interface SemanticCodeChunk {
  id: string;
  projectId: string;
  repoRoot: string;
  filePath: string;
  language: string;
  kind: string;
  symbolName?: string;
  startLine: number;
  endLine: number;
  content: string;
  contentHash: string;
  generation: number;
  vector: number[];
}
```

### Required Behavior

- No append-only vector writes for changed files.
- Every file update does `delete where projectId = X and filePath = Y`, then insert new chunks.
- Semantic hits with stale generation are discarded or marked stale.
- If LanceDB is unavailable, exact/FTS/graph retrieval still works.

### Acceptance Criteria

- Changed file does not return old vector chunks.
- Deleted file does not return semantic hits.
- Project A query cannot return Project B vector chunks.
- Missing LanceDB does not break indexing or graph search.

## Phase 3: Import/Export Resolution

Goal: turn weak import/call hints into resolved graph edges.

### New Modules

- `src/topology/import-resolver.ts`
  - resolves relative imports to files.
  - supports `.ts`, `.tsx`, `.js`, `.jsx`, `index.*`.

- `src/topology/export-index.ts`
  - maps exported names to symbol IDs.

- `src/topology/symbol-resolver.ts`
  - resolves local and imported identifiers to real symbols.

### Edge Upgrade

Current weak edge:

```ts
{ kind: "calls", metadata: { targetName: "refreshProfile" } }
```

Target resolved edge:

```ts
{
  kind: "calls",
  sourceId: "symbol:loginUser",
  targetId: "symbol:refreshProfile",
  metadata: {
    resolution: "resolved",
    sourceFile: "src/auth.ts",
    targetFile: "src/profile.ts"
  }
}
```

### Acceptance Criteria

- `import { refreshProfile } from "./profile"` resolves to `src/profile.ts`.
- Calls to imported functions create resolved `symbolId -> symbolId` edges.
- `impact_analysis("refreshProfile")` includes callers in other files.
- `trace_flow("loginUser")` crosses file boundaries.

## Phase 4: LSP Bridge

Goal: supplement AST heuristics with language-server truth for definitions, references, and type-aware call graph.

### New Modules

- `src/lsp/lsp-client.ts`
  - process/session lifecycle for language servers.

- `src/lsp/typescript-language-service.ts`
  - local TypeScript language service wrapper.
  - preferred first implementation before generic LSP.

- `src/lsp/definition-resolver.ts`
  - resolves definition locations.

- `src/lsp/reference-resolver.ts`
  - resolves references/callers.

- `src/lsp/type-resolver.ts`
  - resolves type info for ambiguous calls.

### Strategy

Start with TypeScript Language Service, not generic LSP protocol. It is easier to run locally, deterministic, and enough for the current TypeScript-first architecture.

Generic LSP can come later for Python/Rust/Go/Java.

### Acceptance Criteria

- `find_symbol` can include definition locations from TypeScript service.
- `impact_analysis` can include references not found by AST name matching.
- Ambiguous calls are marked as `unresolved` instead of guessed.
- LSP failures degrade gracefully to AST graph.

## Phase 5: Framework Topology

Goal: understand real application flows such as React event -> API route -> middleware -> service -> webhook.

### New Modules

- `src/topology/framework-detector.ts`
  - detects React, Next.js, Express, Fastify, Hono, Nest-style patterns.

- `src/topology/react-topology.ts`
  - detects components, event handlers, hooks, client API calls.

- `src/topology/api-topology.ts`
  - detects routes, handlers, middleware, controllers.

- `src/topology/service-topology.ts`
  - detects service classes/functions and repository/database boundaries.

- `src/topology/webhook-topology.ts`
  - detects webhook handlers and event dispatch.

- `src/topology/flow-builder.ts`
  - composes route/service/webhook edges into readable topology paths.

### New Edge Kinds

Extend `EdgeKind`:

```ts
| "handles_event"
| "routes_to"
| "uses_middleware"
| "calls_api"
| "handles_webhook"
| "reads_from"
| "writes_to"
```

### Example Target

For query:

```text
如何修改支付流程
```

The engine should produce:

```text
React checkout button
  -> client payment API call
  -> Node API route
  -> auth/idempotency middleware
  -> Billing Service
  -> payment provider adapter
  -> webhook receiver
  -> order/subscription update
```

### Acceptance Criteria

- React handler to API route can be linked when URL/path is static or template-resolvable.
- API route to service call can be linked through resolved call graph.
- Webhook route can be identified by route names, handler names, or provider event parsing.
- `trace_flow` can return a multi-file, multi-layer path with edge reasons.

## Phase 6: Agent Tool Upgrades

Goal: expose the new capabilities through stable MCP tools.

### Tool Changes

Upgrade:

- `get_context`
  - becomes the canonical AI-facing retrieval output.
  - returns brief, freshness, owner chain, topology, evidence snippets, missing evidence, and next queries.
  - includes `freshness`.
  - includes resolved topology evidence when available.

- `trace_flow`
  - supports `mode: "code" | "framework" | "full"`.
  - returns resolved and unresolved edges separately.

- `impact_analysis`
  - includes references, callers, related tests, stale warning.

Add:

- `topology_map`
  - returns high-level flow graph for a feature/domain query.

- `index_status`
  - reports fresh/pending/stale/error counts.

- `refresh_index`
  - force reindex changed files.

### Acceptance Criteria

- Agent can ask `topology_map("payment flow")` and get ordered owners.
- Agent can ask `index_status` before trusting context.
- Agent can force refresh before high-risk edits.

## Phase 7: Skeletonization And Context Shaping

Goal: prevent large files and broad matches from overwhelming the AI. The engine should return structure first, then focused bodies only when needed.

### New Modules

- `src/context/skeletonizer.ts`
  - renders file/class/interface/function skeletons.
  - preserves public signatures, exports, interfaces, class declarations, method signatures, and docstrings.
  - folds implementation bodies unless selected for focused expansion.

- `src/context/expansion-policy.ts`
  - decides whether a hit should return `file_card`, `skeleton`, `focused_body`, or `full_body`.
  - uses mode, score, owner-chain position, changed files, stale state, and line/error hits.

- `src/context/snippet-renderer.ts`
  - renders snippets according to expansion policy.

### Expansion Levels

```ts
type ExpansionLevel =
  | "file_card"
  | "skeleton"
  | "focused_body"
  | "full_body";
```

Recommended behavior:

```text
non-core related files -> skeleton
core owner files -> focused bodies
changed files / failing tests / error line matches -> focused bodies
explicit full request -> full body
large low-confidence files -> file card only
```

### Skeleton Content

Keep:

- imports summary;
- exports summary;
- interfaces and type aliases;
- class declarations;
- public method signatures;
- function signatures;
- docstrings/comments directly attached to declarations;
- line ranges.

Fold:

- method bodies;
- long implementation blocks;
- low-level helper internals;
- repeated overload-like bodies;
- generated sections.

### Context Pack Changes

Add to each snippet:

```ts
interface ContextSnippet {
  expansionLevel: ExpansionLevel;
  originalLineCount: number;
  returnedLineCount: number;
  elidedLineCount: number;
}
```

### Required Behavior

- Files above the large-file threshold are never returned in full by default.
- Skeleton output must preserve enough signatures for the agent to choose follow-up expansions.
- Core owner files can include focused function bodies.
- Debug mode can expand implementation bodies around error lines or changed code.
- Review mode expands changed hunks and related tests, not whole files.

### Acceptance Criteria

- A fixture file with thousands of lines returns a skeleton under normal `get_context`.
- `get_context` reports how many lines were elided.
- Explicit focused query expands only the relevant function body.
- Context packs stay within budget without silently dropping all owner evidence.

## Phase 8: Graph-Based Reranking

Goal: after keyword/vector recall, rerank candidates by structural closeness in the code graph so results are logically related, not merely textually similar.

### New Modules

- `src/retrieval/graph-reranker.ts`
  - computes graph proximity from seed hits.
  - applies hop-count decay and edge-kind weights.

- `src/retrieval/topology-distance.ts`
  - shortest path / bounded BFS utilities.

- `src/retrieval/ranking-signals.ts`
  - combines exact, keyword, semantic, graph, mode, freshness, and diff signals.

### Ranking Formula

Initial shape:

```ts
finalScore =
  exactScore * 2.0 +
  keywordScore * 1.2 +
  semanticScore * 1.0 +
  graphProximityScore * 1.6 +
  edgeKindBoost +
  modeBoost +
  diffBoost -
  stalePenalty;
```

### Edge Weights

Suggested relative strength:

```text
calls / routes_to / handles_event / handles_webhook = strongest
exports / imports = strong
tested_by = mode-dependent strong
contains = structural support
related = weak
```

### Hop Count

Recommended decay:

```text
0 hops: exact owner
1 hop: direct caller/callee/import/export
2 hops: adjacent service/test/config
3+ hops: weak unless topology mode asks for path expansion
```

### Required Behavior

- Vector results are candidate seeds, not final truth.
- Graph distance can promote a lower-vector-score file if it is a direct caller/callee of an owner.
- Graph distance can demote semantically similar but disconnected files.
- Reranking must respect `projectId`; no cross-project graph traversal.
- Stale files receive a penalty or freshness warning.

### Acceptance Criteria

- In a payment-flow fixture, `BillingService` outranks unrelated payment docs/mock data.
- Direct callers/callees of the top owner appear before disconnected semantic matches.
- Test files are promoted in `review/debug` mode and demoted in ordinary `feature/explain` mode unless explicitly requested.
- Reranking output includes reasons/signals for debugging.

## Phase 9: Evaluation Harness

Goal: prevent retrieval changes from becoming vibes.

### New Modules

- `tests/eval/fixtures/*`
  - small fake apps with known flows.

- `tests/eval/topology.test.ts`
  - expected React -> API -> service -> webhook path.

- `tests/eval/freshness.test.ts`
  - changed/deleted/stale file behavior.

- `tests/eval/skeletonization.test.ts`
  - large file returns skeleton and focused body only when justified.

- `tests/eval/reranking.test.ts`
  - graph-proximate candidates outrank disconnected semantic matches.

- `scripts/eval-context.ts`
  - runs scenario queries and reports hit quality.

### Metrics

- owner hit rate;
- resolved edge rate;
- stale hit rate;
- deleted hit rate;
- context budget usage;
- related test hit rate;
- flow path completeness.
- returned line count;
- elided line count;
- graph rerank lift.

### Acceptance Criteria

- Evaluator fails if deleted files appear in results.
- Evaluator fails if known payment flow misses the service or webhook node.
- Evaluator reports unresolved edge count.
- Evaluator fails if a large unrelated file is returned in full.
- Evaluator fails if graph-proximate owner files rank below disconnected semantic matches in known fixtures.

## Suggested Implementation Order

1. SQLite schema + `SQLiteGraphStore`.
2. Project identity + registry + workspace resolver + session scope enforcement.
3. Incremental per-file index transactions.
4. Freshness report in `ContextPack`.
5. LanceDB delete-before-upsert and generation filtering by `projectId`.
6. Import/export resolver.
7. Cross-file call graph.
8. TypeScript Language Service bridge.
9. Framework topology detectors.
10. `topology_map` and `index_status` MCP tools.
11. Skeletonization and expansion policy.
12. Graph-based reranking.
13. Evaluation harness.

## Do Not Do Yet

- Do not add a dashboard before freshness and topology are correct.
- Do not rely on vector search for topology.
- Do not claim resolved flow when edges are name-only.
- Do not make LanceDB the source of truth for current code.
- Do not index generated/build/dependency directories by default.
- Do not allow implicit cross-project search.
- Do not treat `projectId` as an optional filter; it is required storage scope.
- Do not return full large files by default.
- Do not let vector similarity override clear graph disconnection without a reason.

## Completion Definition

This plan is complete when RagCode can:

- survive fast edits without returning deleted or stale context as fresh;
- keep multiple projects isolated in graph, vector, freshness, and MCP tool results;
- report freshness in every context pack;
- resolve imports/exports and cross-file calls for TypeScript;
- use TypeScript language service for definitions/references;
- identify at least one realistic React -> API -> service -> webhook flow in an eval fixture;
- skeletonize large related files and expand only focused owner bodies;
- rerank semantic candidates by graph distance and expose ranking reasons;
- expose the result through MCP tools with passing tests.
