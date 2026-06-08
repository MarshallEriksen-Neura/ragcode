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
- write graph and semantic records.

This layer must not know about MCP.

### Graph

`src/graph` owns exact code structure:

- files;
- symbols;
- edges;
- symbol lookup;
- file explanation;
- future callers/callees/impact queries.

The first implementation is in-memory. The target implementation is SQLite + FTS + graph traversal inspired by CodeGraph.

### Semantic

`src/semantic` owns embeddings and vector search:

- `InMemorySemanticStore` for tests;
- `LanceSemanticStore` for production storage;
- deterministic placeholder embedding for local smoke tests.

The embedding provider is deliberately an interface so OpenAI, local models, or cached embeddings can be swapped later.

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

### MCP

`src/mcp` owns protocol adaptation:

- tool names;
- input validation;
- handler dispatch;
- future SDK server transport.

MCP must remain thin. It should not implement search logic.

## Target Storage Shape

Short term:

- graph: in-memory;
- semantic: in-memory or LanceDB;
- metadata: generated in process.

Medium term:

- graph: SQLite tables for files, nodes, edges, unresolved refs, FTS;
- semantic: LanceDB table for chunks and summaries;
- sync: file watcher + hash-based incremental rebuild;
- state: `.ragcode/` under each indexed repository.

## Stop Condition For The Foundation

The foundation is good enough when these are true:

- a repo can be scanned deterministically;
- chunks have stable IDs and hashes;
- graph and semantic stores are replaceable;
- CLI and MCP call the same engine;
- tests cover scan, index, search, and context packing;
- TypeScript strict check passes.
