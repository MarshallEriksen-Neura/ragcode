# RagCode Context Engine

RagCode is a local code intelligence foundation for agent-facing context retrieval. The first milestone is not a UI and not a generic RAG demo. It is a durable base that separates structural code indexing, semantic retrieval, context packing, and MCP integration.

The intended direction is to stand on the shoulders of projects such as CodeGraph and Understand-Anything while adding a LanceDB semantic layer and a stronger context-engine contract.

## Core Folders

- `src/core`: shared domain types, service contracts, orchestration, and errors. This is the stable boundary other layers depend on.
- `src/indexing`: filesystem scanning, ignore rules, chunking, hashing, and index pipeline steps.
- `src/graph`: structural code graph storage and graph queries. This owns symbols, files, edges, and exact lookup.
- `src/semantic`: vector/embedding storage. LanceDB lives here behind an interface, so tests and future stores can swap it out.
- `src/retrieval`: query planning and hybrid retrieval. It combines exact, graph, keyword, and semantic signals.
- `src/context`: context-pack construction. This turns retrieval hits into agent-ready evidence with token/character budgets.
- `src/mcp`: MCP tool definitions and handlers. It adapts the engine to clients without owning business logic.
- `src/cli`: local command entrypoint for indexing, search, and smoke checks.
- `src/utils`: small shared utilities that are not domain owners.
- `docs`: architecture notes, contracts, and future decision records.
- `tests`: focused regression tests for the foundation.

## Current Baseline

This scaffold provides:

- repository scanning with conservative ignore defaults;
- sensitive-file filtering for `.env`, keys, credentials, and secrets;
- project identity and workspace auto-scope foundation;
- deterministic content hashing;
- TypeScript/JavaScript AST-backed symbol chunks plus fallback line chunks;
- structural graph edges for contains/imports/exports/calls;
- in-memory structural graph store for tests and early development;
- LanceDB semantic store plus in-memory semantic store;
- configurable deterministic or OpenAI-compatible embedding provider;
- mode-aware query planner and context pack builder;
- final ContextPack fields for `brief`, `freshness`, `ownerChain`, `topology`, and evidence snippets;
- MCP tool registry for `index_repo`, `search_code`, `get_context`, `find_symbol`, `explain_file`, `find_owner`, `impact_analysis`, `related_tests`, `trace_flow`, and `review_diff`;
- CLI commands for smoke usage.

See `docs/SEMANTIC_RUNTIME.md` for LanceDB and embedding model configuration.

## Commands

```bash
bun install
bun run check
bun run test
bun run build
```

Example:

```bash
bun run dev -- index .
bun run dev -- search . "context engine"
```
