---
name: ragcode-context
description: Route code-understanding, debugging, editing, review, ownership, impact, and test questions through RagCode. Prefer MCP tools (get_context, find_owner, impact_analysis, related_tests, trace_flow, review_diff); fall back to the ragcode CLI when MCP is unavailable. Covers index recovery, embedding configuration, and dashboard-only-for-observation guidance.
---

# RagCode Context

RagCode is a local code-intelligence engine exposed to agents through MCP tools and a CLI. Use it BEFORE reading files manually whenever the task involves understanding, editing, reviewing, or assessing code.

## When to use

- "How does X work?", "Where is X implemented?" → context/ownership lookup
- "Fix this bug", "Add this feature" → get context before editing
- "What breaks if I change X?" → impact analysis
- "Which tests cover X?" → related tests
- "Review this diff" → diff review
- Index is missing/stale, or embedding/config questions → recovery/config flow below

## MCP-first routing

Prefer these MCP tools (server name: `ragcode`):

| Question | Tool |
|---|---|
| Build context for a task | `get_context` (query + optional mode: debug/feature/refactor/review/explain) |
| Who owns this behavior / where to edit | `find_owner` |
| Blast radius of a change | `impact_analysis` |
| Tests covering a target | `related_tests` |
| Request/data flow from an entry point | `trace_flow` |
| Review a diff | `review_diff` |
| Check index freshness | `index_status` |
| (Re)build the index | `index_repo` |

Read `references/mcp-tools.md` for argument details.

## CLI fallback (MCP unavailable)

```bash
ragcode doctor <repoRoot> --query "smoke query"   # health + config check
ragcode status <repoRoot>                          # index freshness
ragcode context <repoRoot> "<query>"               # context pack
ragcode owner <repoRoot> "<query>"                 # ownership
ragcode impact <repoRoot> <fileOrSymbol>           # impact analysis
ragcode tests <repoRoot> <fileOrSymbol>            # related tests
```

Read `references/cli.md` for the full command list.

## Missing or stale index recovery

1. Check: `index_status` (MCP) or `ragcode status <repoRoot>`.
2. If missing/stale: `index_repo` (MCP) or run/suggest `ragcode index <repoRoot>`.
3. Retry the original tool after indexing.

## Configuration path

- First run: `ragcode init` (offline-first defaults: sqlite + lancedb + deterministic embeddings; no API key needed).
- Change storage/embedding provider/model/base URL/dimensions: `ragcode configure` (add `--test` to verify the provider).
- Agent/MCP client config: `ragcode setup-mcp --print` (secrets redacted by default).

Never route configuration through the Web dashboard.

## Dashboard guidance

`ragcode dashboard` is observability only: graph visualization, search debugging, context-pack inspection, watcher monitoring. Recommend it for humans observing the engine — not for setup, not for agents.
