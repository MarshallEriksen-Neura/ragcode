# Runtime Storage And Embeddings

RagCode has three runtime choices that matter for real repositories:

- graph store: persists files, symbols, edges, chunks, and freshness metadata;
- embedding provider: turns text into vectors;
- semantic store: persists and searches vectors.

The default remains offline and deterministic so local tests and structural graph retrieval never need credentials:

```text
RAGCODE_GRAPH_STORE=memory
RAGCODE_EMBEDDING_PROVIDER=deterministic
RAGCODE_SEMANTIC_STORE=memory
```

For real repositories, use SQLite for the graph cache, LanceDB for vector recall, and an OpenAI-compatible embedding endpoint.

## SQLite Graph Store

```sh
RAGCODE_GRAPH_STORE=sqlite
RAGCODE_SQLITE_PATH=.ragcode/graph.sqlite
```

SQLite stores the structural graph and freshness metadata. It is the right default for dogfooding because it survives process restarts and keeps project rows isolated by `projectId`.

## Semantic Runtime

RagCode has two semantic pieces:

- embedding provider: turns text into vectors;
- semantic store: persists and searches vectors.

## Install

```sh
bun install
```

`@lancedb/lancedb` is a normal dependency in this app. The MCP SDK remains optional because the core engine can run without an MCP transport.

## Environment

```sh
RAGCODE_SEMANTIC_STORE=lancedb
RAGCODE_LANCEDB_URI=.ragcode/lancedb
RAGCODE_LANCEDB_TABLE=code_chunks

RAGCODE_EMBEDDING_PROVIDER=openai-compatible
RAGCODE_EMBEDDING_API_KEY=...
RAGCODE_EMBEDDING_BASE_URL=https://api.openai.com/v1
RAGCODE_EMBEDDING_MODEL=text-embedding-3-small
RAGCODE_EMBEDDING_DIMENSIONS=1536
```

Only set `RAGCODE_EMBEDDING_REQUEST_DIMENSIONS=true` when the endpoint accepts a `dimensions` field in the request body.

## Why This Matters

The deterministic provider is useful for repeatable tests, but it is not a strong semantic model. For production-quality code search, configure a real embedding model and persist vectors in LanceDB. Structural graph retrieval remains the source of truth; LanceDB is only candidate recall.
