# RagCode Context Engine

RagCode is a local code intelligence foundation for agent-facing context retrieval. The first milestone is not a UI and not a generic RAG demo. It is a durable base that separates structural code indexing, semantic retrieval, context packing, and MCP integration.

The intended direction is to stand on the shoulders of projects such as CodeGraph and Understand-Anything while adding a LanceDB semantic layer and a stronger context-engine contract.

## Quick Start

Terminal-first, offline-first — the first run needs no embedding API key, no account, no hosted service:

```bash
# Install globally
npm install -g ragcode-context-engine

cd my-project
ragcode init          # offline-first config: sqlite + lancedb + deterministic embeddings
ragcode index .       # build the structural + semantic index
ragcode setup-mcp     # register the MCP server for your agent client
```

Upgrade semantic recall later with a real embedding provider (optional, never a blocker):

```bash
ragcode configure          # edit storage / provider / model / base URL / dimensions
ragcode configure --test   # verify the provider (classified failures, secrets never printed)
```

See [docs/ONBOARDING.md](docs/ONBOARDING.md) for the full first-run flow and [docs/INSTALLATION.md](docs/INSTALLATION.md) for detailed installation instructions.

## Web Dashboard (observation and debugging)

The Web dashboard is RagCode's observability surface — graph visualization, search debugging, context-pack inspection, watcher monitoring, and a runtime-config view with per-field source labels and redacted secrets. Setup and configuration stay in the terminal.

```bash
ragcode dashboard      # backend API (port 3000)
cd web && npm run dev  # Vue frontend (port 5173, development)
```

See [docs/DASHBOARD.md](docs/DASHBOARD.md) for scope and [web/README.md](web/README.md) for development details.

## Agent Skill

A Codex/OMX skill template ships in `integrations/codex/skills/ragcode-context/` — it routes agents to MCP tools first (`get_context`, `find_owner`, `impact_analysis`, ...), with CLI fallback and missing-index recovery. See [docs/CODEX_SKILL.md](docs/CODEX_SKILL.md).

## Core Folders

- `src/core`: shared domain types, service contracts, orchestration, and errors. This is the stable boundary other layers depend on.
- `src/indexing`: filesystem scanning, ignore rules, chunking, hashing, and index pipeline steps.
- `src/graph`: structural code graph storage and graph queries. This owns symbols, files, edges, and exact lookup.
- `src/semantic`: vector/embedding storage. LanceDB lives here behind an interface, so tests and future stores can swap it out.
- `src/retrieval`: query planning and hybrid retrieval. It combines exact, graph, keyword, and semantic signals.
- `src/context`: context-pack construction. This turns retrieval hits into agent-ready evidence with token/character budgets.
- `src/watch`: long-running filesystem watcher, event journal, dirty-file coalescing, and background index scheduling.
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
- persisted watcher dirty-file state, journal replay, chokidar-based OS watching, and background batched refresh scheduling;
- MCP tool registry for `index_repo`, `search_code`, `get_context`, `find_symbol`, `explain_file`, `find_owner`, `impact_analysis`, `related_tests`, `trace_flow`, and `review_diff`;
- MCP stdio server entrypoint for agent clients;
- CLI doctor and smoke commands for runtime readiness.

See `docs/SEMANTIC_RUNTIME.md` for LanceDB and embedding model configuration.

## Development Commands

```bash
bun install
bun install --frozen-lockfile
bun --silent run dev -- doctor
bun run check
bun run test
bun run test:watcher
bun run build
```

RagCode currently requires Node >=24 because the SQLite graph store uses `node:sqlite`.

## CLI Commands

```bash
ragcode init [directory]           # Initialize configuration
ragcode index <repoRoot>           # Index a repository
ragcode search <repoRoot> <query>  # Search code
ragcode status <repoRoot>          # Check index status
ragcode context <repoRoot> <query> # Build context pack
ragcode mcp                        # Start MCP server
ragcode setup-mcp                  # Configure MCP for Claude Desktop
ragcode doctor [repoRoot]          # Runtime diagnostics
ragcode watch <repoRoot>           # File watcher daemon
```

Run `ragcode --help` or `ragcode <command> --help` for more details.

Offline smoke with deterministic embeddings:

```bash
$env:RAGCODE_GRAPH_STORE="sqlite"
$env:RAGCODE_SQLITE_PATH=".ragcode/graph.sqlite"
$env:RAGCODE_SEMANTIC_STORE="lancedb"
$env:RAGCODE_LANCEDB_URI=".ragcode/lancedb"
$env:RAGCODE_EMBEDDING_PROVIDER="deterministic"

bun --silent run dev -- doctor . --query "context engine"
bun run dev -- index .
bun run dev -- search . "context engine"
bun run dev -- watch . --batch-delay 750 --quiet 250
```

The watcher is a long-lived daemon. It writes observed OS file events to `.ragcode/watch-events.jsonl` before flushing dirty paths into graph-store watcher state, then a background scheduler marks bounded quiet batches as `indexing` and calls `refreshIndex`. If the process exits or dirty-state recording fails before a flush completes, the next daemon start replays the journal and schedules recovery indexing. Use `--no-auto-index` to record dirty state without background refresh, `--poll` when native watcher events are unreliable, and `--no-index-on-start` when startup must fail instead of creating the first index.

Start the MCP server over stdio:

```bash
bun --silent run dev -- mcp
```

Example MCP client config:

```json
{
  "mcpServers": {
    "ragcode": {
      "command": "bun",
      "args": ["--silent", "run", "dev", "--", "mcp"],
      "cwd": "d:/20260302170616/ragcode",
      "env": {
        "RAGCODE_GRAPH_STORE": "sqlite",
        "RAGCODE_SQLITE_PATH": ".ragcode/graph.sqlite",
        "RAGCODE_SEMANTIC_STORE": "lancedb",
        "RAGCODE_LANCEDB_URI": ".ragcode/lancedb",
        "RAGCODE_EMBEDDING_PROVIDER": "deterministic"
      }
    }
  }
}
```
