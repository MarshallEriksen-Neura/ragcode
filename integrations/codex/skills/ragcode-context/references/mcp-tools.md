# RagCode MCP Tools Reference (for agents)

Server name: `ragcode` (stdio). All tools accept `repoRoot` (optional when a workspace default is resolvable) and return JSON.

## Indexing and state

- `index_repo` `{ repoRoot }` — build/refresh the index. Run this first on a new repo.
- `refresh_index` `{ repoRoot? }` — incremental refresh of dirty files.
- `index_status` `{ repoRoot? }` — counts, freshness, dirty/pending files. Check before trusting stale answers.
- `watch_status` `{ repoRoot? }` — read-only watcher liveness and backlog. It never starts a watcher.

## Primary retrieval tools (prefer these)

- `get_context` `{ repoRoot?, query, mode?, budgetChars?, limit? }` — agent-ready context pack with snippets, topology, and coverage. Modes: `debug`, `feature`, `refactor`, `review`, `explain`.
- `find_owner` `{ repoRoot?, query, limit? }` — likely owner files/symbols for a behavior.
- `impact_analysis` `{ repoRoot?, target }` — structural blast radius for a file or symbol.
- `related_tests` `{ repoRoot?, target }` — tests covering a target.
- `trace_flow` `{ repoRoot?, entry, maxSteps? }` — request/data flow from an entry point.
- `review_diff` `{ repoRoot?, diff? | changedFiles? }` — review evidence for a change.

## Secondary tools

- `search_code` `{ repoRoot?, query, limit?, mode? }` — raw hybrid search hits.
- `find_symbol` `{ repoRoot?, name }` — exact symbol lookup.
- `explain_file` `{ repoRoot?, filePath }` — file card with chunks and symbols.
- `find_reuse_candidates` `{ repoRoot?, query, limit?, reuseGuard? }` — existing implementations to reuse before writing new code; `reuseGuard: true` hard-blocks confirmed duplicates.
- `trace_request_flow` / `explain_impact` / `verified_subgraph` / `expand_node` / `topology_map` — verified graph evidence and node expansion under budget.

## Recommended flows

- Code change: `get_context` → edit → `related_tests` → `review_diff`.
- "Where do I fix X?": `find_owner` → `get_context` on the owner.
- Risky refactor: `impact_analysis` → `verified_subgraph` (mode `impact`) → `related_tests`.
- Stale/no data: `index_status` → `index_repo` → retry original tool.
- Auto-refresh concern: `watch_status`; if not running, use/suggest `ragcode service install <repoRoot>` for persistent freshness or `ragcode watch <repoRoot>` for a foreground watcher.
