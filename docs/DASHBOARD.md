# Web Dashboard: Observability and Debugging

The Web dashboard is RagCode's observation surface. Setup and configuration are terminal-first (`ragcode init` / `ragcode configure` — see [ONBOARDING.md](ONBOARDING.md)); the dashboard exists to watch and debug a running engine.

## Start

```bash
ragcode dashboard      # backend API on port 3000
cd web && npm run dev  # Vue frontend on port 5173 (development)
```

## What it is for

- **Overview**: index statistics (files, symbols, chunks, edges) and freshness.
- **Graph**: interactive dependency graph visualization.
- **Search**: retrieval debugging — inspect ranked hits, scores, and rank reasons.
- **Context**: context-pack inspection with budget/coverage details.
- **Impact**: blast-radius exploration for a file or symbol.
- **Watch**: live watcher event stream and background indexing status.
- **Runtime Config**: read-only view of the effective config — per-field source labels (override/env/config/default), config file path, secrets redacted.

## What it is not for

- Not the onboarding path: first-run setup is `ragcode init`.
- Not the configuration surface: storage/embedding changes go through `ragcode configure`; the dashboard's advanced edit writes through the same shared config layer but the terminal is the recommended path.
- Not an agent surface: agents integrate via MCP (`ragcode setup-mcp`), never via the dashboard.

## Copyable terminal commands

The Runtime Config page corresponds to:

```bash
ragcode configure --show      # effective config, redacted
ragcode doctor .              # health + config + dependency check
ragcode setup-mcp --print     # agent MCP config, redacted
```
