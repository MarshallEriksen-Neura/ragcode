# Onboarding: Terminal-First Setup

RagCode is set up entirely from the terminal. The first run works offline — no embedding API key, no account, no hosted service.

## First run

```bash
npm install -g ragcode-context-engine
cd my-project
ragcode init          # writes .ragcode/config.json (offline-first defaults)
ragcode index .       # builds the structural + semantic index
ragcode setup-mcp     # registers the MCP server for your agent client
```

`ragcode init` defaults (accept them all for a credential-free first run):

```json
{
  "graphStore": "sqlite",
  "sqlitePath": ".ragcode/graph.sqlite",
  "semanticStore": "lancedb",
  "lancedbUri": ".ragcode/lancedb",
  "embeddingProvider": "deterministic"
}
```

Non-interactive: `ragcode init --defaults` writes this config without prompts.

The deterministic embedding provider is an offline baseline — semantic recall works, but a real embedding provider recalls better. Upgrading is a follow-up step, never a blocker.

## Config precedence

CLI, MCP server, Web dashboard, doctor, and setup-mcp all resolve runtime config through one shared loader with the same precedence:

1. Explicit CLI arguments
2. Environment variables (`RAGCODE_*`)
3. `<repoRoot>/.ragcode/config.json`
4. Offline-first defaults

`ragcode doctor` and `ragcode configure --show` print the effective config with per-field source labels and secrets redacted.

## Upgrading the embedding provider

```bash
ragcode configure                 # interactive: storage, provider, model, base URL, dimensions
ragcode configure --test          # test the current provider (classified failures, no secrets in output)
ragcode configure --embedding-provider openai-compatible \
  --base-url https://api.openai.com/v1 --model text-embedding-3-small \
  --api-key sk-... --test         # non-interactive upgrade + verification
```

Failure classifications: `missing_key`, `auth_failure`, `model_not_found`, `network_failure`, `dimensions_mismatch`, `unsupported_dimensions_request`.

After switching providers, re-index so vectors match the new profile: `ragcode index .`

## Agent integration

```bash
ragcode setup-mcp --print                   # print MCP config, secrets redacted
ragcode setup-mcp --print --include-secrets # explicit opt-in to real values
ragcode setup-mcp --client claude           # write Claude Desktop config
```

A Codex/OMX skill template ships in `integrations/codex/skills/ragcode-context/` — see [CODEX_SKILL.md](CODEX_SKILL.md).

## Observation (optional)

```bash
ragcode dashboard
```

The Web dashboard is for observation and debugging only (graph, search, context packs, watcher, runtime config inspection). It is not the setup path — see [DASHBOARD.md](DASHBOARD.md).

## Health check

```bash
ragcode doctor . --query "context engine"
```

Checks Node version, native deps (sqlite/LanceDB/MCP SDK), effective runtime config (redacted), and optionally smoke-indexes the repo.
