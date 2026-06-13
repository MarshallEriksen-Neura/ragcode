# Architecture

## Goal

Build a local, explainable, agent-facing context engine for codebases. The foundation must support structural graph lookup, LanceDB semantic recall, hybrid retrieval, and MCP tools without coupling those layers together.

## Layer Ownership

### Core

`src/core` owns the canonical contracts:

- `RepoIndex`: indexed repository state.
- `CodeFile`: tracked source file metadata.
- `CodeChunk`: retrievable text unit.
- `GraphStore`: structural lookup contract.
- `SemanticStore`: vector lookup contract.
- `ContextEngine`: orchestration facade used by CLI and MCP.

All external surfaces should depend on these contracts, not on concrete stores.

### Indexing

`src/indexing` owns local filesystem ingestion:

- scan repository files;
- apply ignore rules;
- compute hashes;
- chunk files;
- write graph and semantic records;
- split empty-index bootstraps into bounded batches and persist progress.

This layer must not know about MCP.

### Graph

`src/graph` owns exact code structure:

- files;
- symbols;
- edges;
- symbol lookup;
- file explanation;
- future callers/callees/impact queries.

Production graph storage is SQLite + FTS, with an in-memory implementation kept for tests and isolated runs. Graph writes support both full replacements and scoped incremental upserts so large repositories can bootstrap in batches.

### Semantic

`src/semantic` owns embeddings and vector search:

- `InMemorySemanticStore` for tests;
- `LanceSemanticStore` for production storage;
- deterministic placeholder embedding for local smoke tests.

The embedding provider is deliberately an interface so OpenAI, local models, or cached embeddings can be swapped later. Semantic state is tracked separately from graph state (`semanticGeneration`, `semanticFresh`, rebuild-needed/error fields) because a large first graph bootstrap may deliberately defer vector writes.

### Retrieval

`src/retrieval` owns query planning:

- exact/path/symbol intent detection;
- graph search;
- semantic search;
- score fusion;
- result normalization.

This is where the engine should eventually surpass pure RAG.

### Context

`src/context` owns agent-ready output:

- choose snippets under budget;
- attach reasons and scores;
- report missing evidence;
- preserve file/line citations.

MCP tools should return context packs, not raw vector hits.

### Watch

`src/watch` owns incremental freshness for long-running local repositories:

- `FileWatchDaemon` adapts chokidar OS file events into repo-relative dirty paths;
- `FileEventJournal` durably appends events before dirty-state flushes so restarts can replay missed work;
- `WatchIndexScheduler` batches quiet dirty files, marks them `indexing`, and triggers `refreshIndex` in the background;
- `file-event-coalescer` bounds bursty event sets before they enter graph-store watcher state.

The watch layer depends only on the `ContextEngine` contract. It does not know about SQLite tables, semantic storage, MCP transport, or CLI formatting. Failed dirty-state flushes keep journal entries recoverable, failed refreshes requeue `indexing` files back to pending dirty state, and scheduler batches share the same memory guardrails as foreground indexing.

### MCP

`src/mcp` owns protocol adaptation:

- tool names;
- input validation;
- handler dispatch;
- future SDK server transport.

MCP must remain thin. It should not implement search logic.

## Target Storage Shape

Current production shape:

- graph: SQLite tables for projects, files, chunks, symbols, edges, FTS, dirty state, and semantic freshness metadata;
- semantic: LanceDB table for chunks, with an in-memory store for tests;
- sync: file watcher + hash-based incremental rebuild + bounded bootstrap batches;
- state: `.ragcode/` under each indexed repository, including config, watcher state, `index-state.json`, and `index-progress.jsonl`.

## Stop Condition For The Foundation

The foundation is good enough when these are true:

- a repo can be scanned deterministically;
- chunks have stable IDs and hashes;
- graph and semantic stores are replaceable;
- CLI and MCP call the same engine;
- tests cover scan, index, search, and context packing;
- TypeScript strict check passes.
