# PLAN_STABILITY_AND_TOPOLOGY Completion Audit

Status: complete

Executable gate:

```sh
bun run audit:plan && bun run eval:context && bun run check && bun run test && bun run build
```

## Completion Evidence

| Completion definition | Evidence |
| --- | --- |
| Survive fast edits without returning deleted or stale context as fresh | `scripts/audit-plan.ts`, `tests/freshness.test.ts`, eval metrics `staleHitRate=0`, `deletedHitRate=0` |
| Keep multiple projects isolated in graph, vector, freshness, and MCP tool results | `tests/foundation.test.ts`, `tests/sqlite-graph-store.test.ts`, `tests/semantic-consistency.test.ts` |
| Report freshness in every context pack | `tests/foundation.test.ts`, `tests/agent-tools.test.ts`, `index_status` smoke in `scripts/audit-plan.ts` |
| Resolve imports/exports and cross-file calls for TypeScript | `tests/topology-resolution.test.ts`, eval metric `resolvedEdgeRate > 0` |
| Use TypeScript language service for definitions/references | `tests/lsp-resolution.test.ts` |
| Identify React -> API -> service -> webhook flow in an eval fixture | `tests/eval/topology.test.ts`, eval metric `flowPathCompleteness=1` |
| Skeletonize large related files and expand only focused owner bodies | `tests/eval/skeletonization.test.ts`, eval metrics `largeFullBodyViolations=0`, `elidedLineCount > 0` |
| Rerank semantic candidates by graph distance and expose ranking reasons | `tests/eval/reranking.test.ts`, eval metric `graphRerankLift > 0`, rerank reasons present |
| Expose the result through MCP tools with passing tests | `tests/agent-tools.test.ts`, `topology_map`, `index_status`, `refresh_index`, `get_context` smoke in `scripts/audit-plan.ts` |

## Current Audit Metrics

The latest completed Phase 9 evaluator produced:

```text
ownerHitRate=1
flowPathCompleteness=1
unresolvedEdgeCount=3
staleHitRate=0
deletedHitRate=0
graphRerankLift=5
largeFullBodyViolations=0
```

## Remaining Work

The stability and topology plan is closed. The next workstream should be dogfooding and quality tuning on larger real repositories, not more foundation planning:

- run the evaluator against larger fixtures or real open-source projects;
- tune ranking weights and context budgets from observed failures;
- add language-specific topology beyond TypeScript when needed;
- polish MCP UX and error reporting around workspace ambiguity.

## Production Runtime Configuration

For real dogfooding, run with persistent graph and semantic stores:

```sh
RAGCODE_GRAPH_STORE=sqlite
RAGCODE_SQLITE_PATH=.ragcode/graph.sqlite
RAGCODE_SEMANTIC_STORE=lancedb
RAGCODE_LANCEDB_URI=.ragcode/lancedb
RAGCODE_EMBEDDING_PROVIDER=openai-compatible
RAGCODE_EMBEDDING_API_KEY=...
RAGCODE_EMBEDDING_MODEL=text-embedding-3-small
RAGCODE_EMBEDDING_DIMENSIONS=1536
```
