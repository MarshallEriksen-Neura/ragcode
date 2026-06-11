# RagCode CLI Reference (for agents)

All read commands require the repo to be indexed first (`ragcode index <repoRoot>`). Reads resolve runtime config via CLI args > env > `<repoRoot>/.ragcode/config.json` > offline-first defaults (sqlite + lancedb + deterministic).

## Health and state

```bash
ragcode doctor [repoRoot] --query "<smoke query>"  # deps, runtime config (redacted), MCP registration, optional index/search smoke
ragcode status <repoRoot>                          # persisted index + dirty watcher state, no indexing
```

## Indexing

```bash
ragcode index <repoRoot>          # full/incremental index
ragcode watch <repoRoot>          # long-lived watcher daemon with background refresh
```

## Retrieval

```bash
ragcode context <repoRoot> "<query>" [--mode debug|feature|refactor|review|explain] [--budget <chars>]
ragcode search <repoRoot> "<query>" [--limit N]
ragcode owner <repoRoot> "<query>"
ragcode reuse <repoRoot> "<query>"          # reusable existing code before writing new code
ragcode impact <repoRoot> <fileOrSymbol>
ragcode explain-impact <repoRoot> <target>  # verified minimal subgraph for blast radius
ragcode tests <repoRoot> <fileOrSymbol>
ragcode trace-request-flow <repoRoot> <entry>
ragcode expand-node <repoRoot> <file[:symbol]> [--expansion focused_body|full_body|skeleton|file_card]
```

## Setup and configuration

```bash
ragcode init [dir] [--defaults]      # first-run config; --defaults writes offline-first config without prompts
ragcode configure [repoRoot]         # edit storage/embedding config; --show prints effective config; --test verifies embedding
ragcode setup-mcp [--print] [--include-secrets] [--client claude|codex|generic]
ragcode mcp                          # start the MCP server over stdio
ragcode dashboard                    # Web observability API (humans only)
```

## Error recovery

- "Repository is not indexed" → run `ragcode index <repoRoot>`, retry.
- Embedding failures → `ragcode configure --test` to classify (missing key / auth / model / network / dimensions), then `ragcode configure` to fix.
