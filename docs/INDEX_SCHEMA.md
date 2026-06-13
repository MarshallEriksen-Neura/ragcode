# Index Schema

This is the production shape for the local code intelligence core. Structural graph state is persisted in SQLite + FTS, semantic chunks live in LanceDB, and tests can still swap in in-memory stores through the same contracts.

## Structural Graph

### `projects`

- `projectId`
- `repoRoot`
- `canonicalRoot`
- `displayName`
- `gitRemote`
- `gitHead`
- `createdAtMs`
- `lastIndexedAtMs`
- `indexGeneration`
- `semanticGeneration`
- `semanticFresh`
- `semanticRebuildNeeded`
- `semanticLastError`
- `semanticUpdatedAtMs`

`projectId` is the storage namespace. It is required for every graph, chunk, and vector row. Raw `repoRoot` is an input path, not a sufficient isolation boundary.

Normal retrieval tools should not rely on the AI passing `projectId` or `repoRoot`. The MCP server resolves workspace scope automatically through `WorkspaceResolver` and stores the active project in session scope.

### `files`

- `projectId`
- `path`
- `absolutePath`
- `language`
- `sizeBytes`
- `contentHash`
- `modifiedAtMs`

### `symbols`

- `projectId`
- `id`
- `filePath`
- `name`
- `kind`: `file | function | class | method | type | variable | unknown`
- `language`
- `startLine`
- `endLine`
- `signature`
- `exported`

### `edges`

- `projectId`
- `sourceId`
- `targetId`
- `kind`: `contains | imports | exports | calls | references | tested_by | related | handles_event | calls_api | routes_to | uses_middleware | handles_webhook | reads_from | writes_to`
- `metadata`

Important metadata keys:

- `sourceFile`
- `targetFile`
- `targetName`
- `source`
- `line`
- `resolution`
- `framework`
- `route`
- `requestPath`
- `routeFile`
- `resource`
- `model`
- `operation`
- `orm`
- `dataflowSource`
- `dataflowKind`
- `producer`

Resolution values are resolver-specific evidence labels. Current topology emitters include `resolved`, `resolved_lsp`, `test_import`, `framework_static`, `framework_call_graph`, `framework_dataflow`, `resource_static`, `event_static`, `orm_static`, and `orm_dataflow`.

Framework/dataflow boundaries:

- `calls_api` links client-side static or same-file-constant/template API calls to indexed Next.js, Express, or Fastify route handlers.
- Unresolved template request paths are not persisted as concrete `calls_api` route links.
- `routes_to` links route handlers to services only through resolved call graph edges.
- `reads_from` and `writes_to` resource targets may be virtual ids such as `prisma.order` or `drizzle.orders` rather than real file symbols.
- `orm_dataflow` marks bounded request payload evidence on writes. It is not a general cross-file taint engine.

## Semantic Chunks

LanceDB table: `code_chunks`.

- `id`
- `projectId`
- `repoRoot`
- `filePath`
- `language`
- `kind`
- `symbolName`
- `startLine`
- `endLine`
- `content`
- `contentHash`
- `vector`

## Incremental And Bootstrap Indexing

The incremental algorithm is:

1. resolve `repoRoot` to `projectId`;
2. scan files with ignore rules;
3. compare `contentHash` against previous `files` rows for the same `projectId`;
4. delete chunks/symbols/edges for removed or changed files inside that `projectId`;
5. re-analyze changed files;
6. rebuild topology for refreshed files using current source text as resolver context, so incremental client refreshes can still see unchanged route catalogs;
7. upsert structural rows;
8. upsert semantic chunks with `projectId`;
9. mark stale files while watcher debounce is pending.

For an empty large repository, CLI bootstrap does not force a full all-at-once index. It scans the inventory, indexes the first bounded file batch, writes structural rows with incremental upsert semantics, and records the remaining files as pending dirty state. The first partial bootstrap defaults to semantic deferral, so graph retrieval can become usable before a complete vector rebuild. Progress is persisted under `.ragcode/index-state.json` and `.ragcode/index-progress.jsonl`.

Freshness surfaces must distinguish:

- `graphFresh`: whether the structural graph has pending/stale/indexing files;
- `semanticFresh`: whether vector rows match the graph generation;
- `semanticCoverage`: `complete_repo` or `indexed_graph`;
- `semanticRebuildNeeded` / `semanticLastError`: whether semantic recall should be treated as degraded while graph search remains usable.

## Isolation Rules

- Every table query must include `projectId`.
- Every LanceDB search must filter `projectId`.
- Every graph traversal must reject nodes outside the active `projectId`.
- No current MCP tool performs cross-project retrieval.
- Retrieval tools resolve workspace through server-owned session scope before reading stores.
- If workspace resolution is ambiguous, the tool fails closed and performs no search.
- AI-provided `repoRoot` is an optional override/indexing hint, not the primary isolation mechanism.
- Future cross-project search must be a separate explicit tool with separate result grouping.

## Workspace Resolution

Priority:

1. `workspace.filePath`
2. `workspace.root`
3. MCP client roots
4. server startup `cwd`
5. single indexed project fallback
6. otherwise reject

Resolved session shape:

```ts
interface WorkspaceSession {
  activeProjectId: string;
  activeRepoRoot: string;
  knownProjects: ProjectIdentity[];
  resolvedFrom: "filePath" | "root" | "mcp_roots" | "cwd" | "single_project";
}
```
