<p align="center">
  <img src="docs/images/eeb4a920-7607-41a7-aa2c-1d897a96a1ee.png" alt="RagCode logo" width="180" />
</p>

<h1 align="center">RagCode Context Engine</h1>

<p align="center">
  <a href="https://github.com/MarshallEriksen-Neura/ragcode/actions/workflows/ci.yml"><img src="https://github.com/MarshallEriksen-Neura/ragcode/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://www.npmjs.com/package/ragcode-context-engine"><img src="https://img.shields.io/npm/v/ragcode-context-engine.svg" alt="npm version" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D24-green.svg" alt="Node >= 24" /></a>
</p>

<p align="center"><b>English</b> · <a href="./README.zh-CN.md">简体中文</a></p>

RagCode is a **fully-local, verified context layer for coding agents.**

Most code-intelligence tools *retrieve* — they hand an agent relevant snippets and stop there. RagCode goes one step further: it tells the agent **whether it has enough verified context to safely act**. Every answer carries explicit citations, freshness, ownership, blast-radius, coverage signals, and an `edit-readiness` verdict (`safe_to_edit_after_reading` / `investigate_only` / `not_enough_context`) — plus an honest record of what evidence is still missing.

It is **editor-agnostic and MCP-native** (Claude Code, Codex, or any MCP client — not locked to one editor) and runs **entirely on your machine** (no account, no API key, no code leaving the building). The first run works offline with deterministic embeddings; swap in an OpenAI-compatible provider only if and when you want better recall.

Under the hood it cleanly separates structural code indexing, semantic retrieval, context packing, and MCP integration so each layer evolves independently — building on ideas from projects like CodeGraph and Understand-Anything, with a LanceDB semantic layer and a stronger context-engine contract on top.

---

## Why RagCode

| If you need… | RagCode fits because… |
|---|---|
| Context that isn't locked to one editor | MCP-native; works with any agent harness, not a single IDE |
| Code that never leaves your machine | Fully local index + offline embeddings; no cloud round-trip |
| Agents that act correctly, not just confidently | Verified subgraphs with coverage signals + `edit-readiness`, not raw snippet dumps |

---

## Technology Stack

| Area | Technology |
|------|-----------|
| Language / Runtime | TypeScript 5.9, Node.js **>= 24** (uses `node:sqlite`), ESM modules |
| Structural graph | `better-sqlite3` (SQLite + FTS) with an in-memory store for tests |
| Semantic / vector store | `@lancedb/lancedb` + `apache-arrow`, with an in-memory store fallback |
| AST / parsing | TypeScript Compiler API (TS/JS), `tree-sitter` (Python, Go, Rust, Java) |
| MCP integration | `@modelcontextprotocol/sdk` (stdio server) |
| CLI | `commander`, `ink` + `react` (interactive wizards) |
| Web dashboard | `express` + `ws` backend, Vue frontend (in `web/`) |
| File watching | `chokidar` |
| Validation | `zod` |
| Tooling | `tsx` (dev), `vitest` (tests), `tsc` (build + type check) |

---

## Project Architecture

RagCode is layered so that no concrete store leaks across boundaries. Every external surface (CLI, MCP, web) depends on the contracts in `src/core`, never on a specific database.

```
            ┌──────────┐   ┌──────────┐   ┌──────────────┐
 surfaces   │   CLI    │   │   MCP    │   │ Web dashboard │
            └────┬─────┘   └────┬─────┘   └──────┬───────┘
                 └──────────────┴────────────────┘
                                │
                    ┌───────────▼───────────┐
                    │  ContextEngine (core)  │  canonical contracts
                    └───────────┬───────────┘
        ┌──────────────┬────────┼────────┬──────────────┐
        ▼              ▼        ▼         ▼              ▼
   ┌────────┐    ┌─────────┐ ┌──────┐ ┌─────────┐  ┌─────────┐
   │indexing│    │  graph  │ │ sem. │ │retrieval│  │ context │
   │  scan  │    │ SQLite  │ │Lance │ │ planner │  │  packer │
   │ chunk  │    │  +FTS   │ │  DB  │ │ +fusion │  │ +budget │
   └────────┘    └─────────┘ └──────┘ └─────────┘  └─────────┘
                                │
                          ┌─────▼─────┐
                          │   watch   │  incremental freshness
                          └───────────┘
```

**Layer ownership** (see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)):

- **core** — canonical contracts: `RepoIndex`, `CodeFile`, `CodeChunk`, `GraphStore`, `SemanticStore`, `ContextEngine`. The stable boundary everything else depends on.
- **indexing** — filesystem scan, ignore rules, hashing, chunking, and index-pipeline steps. Knows nothing about MCP.
- **graph** — exact code structure: files, symbols, edges, lookup, callers/callees/impact. In-memory for tests, SQLite + FTS for production.
- **semantic** — embeddings and vector search behind an interface, so providers (deterministic, OpenAI-compatible, local) and stores swap freely.
- **retrieval** — query planning: intent detection, graph + semantic search, score fusion, normalization.
- **context** — agent-ready output: snippet selection under a character/token budget, reasons, scores, citations, and `missingEvidence`.
- **watch** — long-running watcher, durable event journal, dirty-file coalescing, and background batched re-index scheduling.
- **mcp** — thin protocol adaptation: tool names, input validation, handler dispatch. No search logic lives here.

The **context-pack contract** is the heart of the engine. `get_context` returns:

```
brief → freshness → ownerChain → topology → evidence snippets → missingEvidence → nextQueries
```

Snippets are *evidence*, not the primary organization. Large files default to a `skeleton` expansion level rather than full source, and every snippet reports how many lines were elided.

---

## Getting Started

### Prerequisites

- **Node.js >= 24.0.0** (required — the SQLite graph store uses `node:sqlite`)
- Windows, macOS, or Linux
- ~100 MB disk for dependencies + index data

### Install and run (terminal-first, offline-first)

The first run needs no embedding API key, no account, and no hosted service.

```bash
# Install globally
npm install -g ragcode-context-engine

cd my-project
ragcode init          # offline-first config: sqlite + lancedb + deterministic embeddings
ragcode index .       # build the structural + semantic index
ragcode setup-mcp     # register the MCP server for your agent client
```

Or try it without installing:

```bash
npx ragcode-context-engine index .
npx ragcode-context-engine search . "query"
```

Working from source (no global install)? Run any command through the dev script — it executes the TypeScript entry directly via `tsx`:

```bash
npm run dev -- index .
npm run dev -- setup-mcp --client codex --print
```

### Upgrade semantic recall (optional, never a blocker)

```bash
ragcode configure          # edit storage / provider / model / base URL / dimensions
ragcode configure --test   # verify the provider (classified failures; secrets never printed)
```

**OpenAI-compatible providers (OpenAI, Azure, Ollama, etc.):**

```bash
# Cloud (OpenAI)
export RAGCODE_EMBEDDING_PROVIDER=openai-compatible
export RAGCODE_EMBEDDING_API_KEY=sk-your-key

# Local (Ollama) - recommended for privacy + quality
ollama pull nomic-embed-text
export RAGCODE_EMBEDDING_PROVIDER=openai-compatible
export RAGCODE_EMBEDDING_BASE_URL=http://localhost:11434/v1
export RAGCODE_EMBEDDING_MODEL=nomic-embed-text
export RAGCODE_EMBEDDING_API_KEY=ollama  # any non-empty string works
```

See [docs/EMBEDDING_PROVIDERS.md](docs/EMBEDDING_PROVIDERS.md) for Azure, Ollama setup, troubleshooting, and performance comparison.

`ragcode init` walks you through the full first-run flow; `ragcode <command> --help` documents each command's options.

### CLI commands

```bash
ragcode init [directory]            # Initialize configuration (interactive wizard)
ragcode index <repoRoot>            # Index a repository
ragcode search <repoRoot> <query>   # Search code
ragcode status <repoRoot>           # Check index status
ragcode context <repoRoot> <query>  # Build a context pack
ragcode mcp                         # Start the MCP server (stdio)
ragcode setup-mcp                   # Register MCP for Claude Desktop
ragcode doctor [repoRoot]           # Runtime diagnostics
ragcode watch <repoRoot>            # File-watcher daemon
ragcode dashboard                   # Web observability backend (port 3000)
```

Run `ragcode --help` or `ragcode <command> --help` for details.

### MCP server integration

RagCode runs as an MCP server so agents like Claude can call its tools directly. Auto-register for your client:

```bash
ragcode setup-mcp                       # Claude Code     (project ./.mcp.json, default)
ragcode setup-mcp --client claude       # Claude Desktop  (~/.../claude_desktop_config.json)
ragcode setup-mcp --client codex        # Codex CLI       (~/.codex/config.toml)
ragcode setup-mcp --client codex --print # print config, write nothing
```

Existing config is merged in place (other servers and unrelated keys are preserved, and the
previous file is backed up). Add `--force` to overwrite an existing `ragcode` entry without
prompting, and `--include-secrets` to embed the API key instead of redacting it.

Or add it manually to your MCP client config:

```json
{
  "mcpServers": {
    "ragcode": {
      "command": "ragcode",
      "args": ["mcp"],
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

**Available MCP tools (19):**

- *Index lifecycle* — `index_repo`, `refresh_index`, `index_status`, `record_file_events`, `watch_status`
- *Search & context* — `search_code`, `get_context`, `topology_map`, `expand_node`
- *Symbols & files* — `find_symbol`, `explain_file`, `find_owner`, `find_reuse_candidates`
- *Impact & flow* — `impact_analysis`, `explain_impact`, `related_tests`, `trace_flow`, `trace_request_flow`
- *Review* — `review_diff`

`watch_status` is read-only: it reports whether a live watcher is keeping the index fresh, but never starts one (that belongs to `ragcode watch` or the OS service).

### Web dashboard (observation and debugging)

The dashboard is RagCode's observability surface — graph visualization, search debugging, context-pack inspection, watcher monitoring, and a runtime-config view with per-field source labels and redacted secrets. Setup and configuration stay in the terminal.

```bash
ragcode dashboard       # backend API (port 3000)
cd web && npm run dev   # Vue frontend (port 5173, development)
```

See [docs/DASHBOARD.md](docs/DASHBOARD.md) and [web/README.md](web/README.md).

---

## Project Structure

```
ragcode/
├── src/
│   ├── core/          # Canonical contracts and orchestration facade (stable boundary)
│   ├── indexing/      # Scan, ignore rules, hashing, chunking, analyzers, pipeline
│   ├── graph/         # Structural code graph: symbols, files, edges, lookup
│   ├── semantic/      # Embeddings + vector store (LanceDB / in-memory)
│   ├── retrieval/     # Query planning and hybrid (exact/graph/keyword/semantic) fusion
│   ├── context/       # Context-pack construction under token/char budgets
│   ├── subgraph/      # Verified code subgraph (impact / flow / review / debug)
│   ├── topology/      # Framework + dataflow topology edges
│   ├── reuse/         # Reuse / duplicate detection
│   ├── lsp/           # LSP-assisted symbol resolution
│   ├── watch/         # Watcher daemon, event journal, dirty coalescing, scheduler
│   ├── mcp/           # MCP tool definitions and handlers (thin adapter)
│   ├── cli/           # Command entrypoint (commander + ink wizards)
│   ├── web/           # Dashboard backend (express + ws)
│   ├── config/        # Runtime configuration resolution
│   ├── project/       # Project identity and workspace auto-scope
│   ├── diagnostics/   # Doctor / smoke checks
│   ├── types/         # Shared type declarations
│   └── utils/         # Small shared utilities (not domain owners)
├── tests/             # Vitest regression suites (foundation, graph, retrieval, watch, ...)
├── docs/              # Architecture notes, contracts, and decision records
├── integrations/      # Codex/OMX agent skill template (ragcode-context)
├── scripts/           # init-config, setup-mcp, benchmarks, eval, audit
├── web/               # Vue dashboard frontend
└── benchmarks/        # Benchmark fixtures and results
```

---

## Key Features

- **Hybrid retrieval** — fuses exact, graph, keyword, and semantic signals, then applies mode-specific boosts and graph-distance reranking. Candidates with non-positive final scores are filtered out.
- **Mode-aware context packing** — resolves a retrieval mode from the query: `debug`, `feature`, `refactor`, `review`, or `explain`, each prioritizing different evidence.
- **Context-pack contract** — `brief`, `freshness`, `ownerChain`, `topology`, evidence snippets, `missingEvidence`, and `nextQueries`, with citations and elision stats. Returning uncertainty beats overclaiming.
- **Structural code graph** — symbols, files, and `contains` / `imports` / `exports` / `calls` edges, backed by SQLite + FTS or an in-memory store.
- **Framework + dataflow topology** — bounded route/ORM evidence (Next.js, Express, Fastify, Prisma, Drizzle) emitted as `calls_api`, `routes_to`, `reads_from`, `writes_to`, and request-payload `orm_dataflow` edges.
- **Multi-language analysis** — full AST support for TypeScript/JavaScript via the TS Compiler API; tree-sitter–backed analysis for Python, Go, Rust, and Java, with fallback line chunking for other file types.
- **Incremental freshness** — chokidar OS watcher → durable event journal → dirty-file coalescing → background batched re-index. Restarts replay the journal so no dirty work is lost.
- **Offline-first** — deterministic embeddings require no API key; swap in an OpenAI-compatible provider whenever you want, without re-architecting.
- **MCP-native** — 19 agent tools over a thin stdio server (index lifecycle, search/context, impact/flow, review), plus a Codex/OMX skill template that routes agents to MCP first with CLI fallback.
- **Web observability** — graph visualization, search debugger, context-pack inspector, watcher monitor, and a redacted runtime-config view.

---

## Development Workflow

Clone and set up:

```bash
git clone https://github.com/MarshallEriksen-Neura/ragcode.git
cd ragcode
npm install
```

Common tasks (npm is the canonical toolchain used by CI; `bun` also works locally):

```bash
npm run dev -- doctor       # run the CLI from source via tsx
npm run check               # TypeScript strict type check (no emit)
npm test                    # run the Vitest suite
npm run test:watcher        # watcher-focused tests
npm run build               # compile to dist/ via tsconfig.build.json
```

**Branching:** `main` is the protected default branch. Work on feature branches and open pull requests against `main` — never push directly to `main`.

**CI** ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs on every push and PR to `main` against Node 24 and enforces, in order: `npm ci` → `npm run check` → `npm run build` → `npm test` → `npm pack --dry-run`. All steps must pass before merge. Publishing is automated via [.github/workflows/publish.yml](.github/workflows/publish.yml).

Offline smoke run with deterministic embeddings:

```bash
export RAGCODE_GRAPH_STORE=sqlite
export RAGCODE_SQLITE_PATH=.ragcode/graph.sqlite
export RAGCODE_SEMANTIC_STORE=lancedb
export RAGCODE_LANCEDB_URI=.ragcode/lancedb
export RAGCODE_EMBEDDING_PROVIDER=deterministic

npm run dev -- doctor . --query "context engine"
npm run dev -- index .
npm run dev -- search . "context engine"
```

---

## Coding Standards

- **TypeScript strict mode.** `npm run check` (`tsc --noEmit`) must pass with zero errors before any change is considered done.
- **ESM throughout.** The package is `"type": "module"`; use ES import/export and `node:`-prefixed builtins.
- **Respect layer boundaries.** Depend on the contracts in `src/core`, not concrete stores. `indexing` must not know about MCP; `mcp` must stay thin and contain no search logic; `watch` depends only on the `ContextEngine` contract.
- **Stores are replaceable.** Anything touching graph or semantic storage goes through the `GraphStore` / `SemanticStore` interfaces so tests and future backends can swap in.
- **Stable IDs and hashes.** Chunks have deterministic content hashes and stable IDs — preserve this when changing chunking or analyzers.
- **Validate inputs at the edges** with `zod`, especially MCP tool inputs.
- **Never print secrets.** Config views and provider tests redact API keys; sensitive files (`.env`, keys, credentials) are filtered from indexing.

---

## Testing

Tests use **Vitest** and live in [tests/](tests/) (38+ suites). They cover the full foundation: scanning and incremental indexing, SQLite and LanceDB stores, hybrid retrieval and graph reranking, context packing and skeletonization, topology resolution, the watcher daemon and journal replay, MCP server tools, and the onboarding/configure CLI wizards.

```bash
npm test                    # full suite
npm run test:watcher        # watcher daemon + state tests only
npx vitest run tests/foundation.test.ts   # a single suite
```

The foundation is considered sound when a repo scans deterministically, chunks have stable IDs/hashes, graph and semantic stores are replaceable, CLI and MCP call the same engine, the strict type check passes, and scan/index/search/context-packing are all covered by tests. Add or update tests alongside any behavior change, and keep authoring and reviewing as separate passes.

---

## Contributing

1. Fork the repo and create a feature branch off `main`.
2. Make your change, keeping it within the relevant layer's boundary (see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)).
3. Add or update tests in [tests/](tests/) for any behavior change.
4. Run the full local gate before pushing:
   ```bash
   npm run check && npm test && npm run build
   ```
5. Push your branch and open a pull request against `main` with a concise summary of what changed and what you tested.

For agent-assisted contribution, the Codex/OMX skill template in [integrations/codex/skills/ragcode-context/](integrations/codex/skills/ragcode-context/) routes agents to RagCode's MCP tools first, with CLI fallback and missing-index recovery — see [docs/CODEX_SKILL.md](docs/CODEX_SKILL.md).

### Further documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — layers and ownership
- [docs/INDEX_SCHEMA.md](docs/INDEX_SCHEMA.md) — index schema
- [docs/DASHBOARD.md](docs/DASHBOARD.md) — web dashboard scope
- [docs/CODEX_SKILL.md](docs/CODEX_SKILL.md) — Codex/OMX agent skill template

认同 `真诚`、`友善`、`团结`、`专业`，欢迎加入 [LinuxDo](https://linux.do/latest)。
---

## License

Released under the [MIT License](./LICENSE). Copyright (c) 2026 RagCode Team.
