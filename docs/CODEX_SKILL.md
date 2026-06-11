# Codex/OMX Skill: ragcode-context

A repo-shipped skill template that teaches agents when and how to use RagCode. The skill routes agents to MCP tools first, falls back to the CLI, recovers missing indexes, and keeps configuration terminal-first. It does not execute RagCode logic itself.

## Location

```text
integrations/codex/skills/ragcode-context/
  SKILL.md                 # skill body: triggers, MCP-first routing, CLI fallback, recovery
  agents/openai.yaml       # OpenAI/Codex agent metadata
  references/cli.md        # full CLI reference for agents
  references/mcp-tools.md  # MCP tool arguments and recommended flows
```

## Install

Copy the skill directory into your agent's skill path, e.g.:

```bash
# Codex/OMX-style local skills
cp -r integrations/codex/skills/ragcode-context ~/.codex/skills/

# Claude Code project skills
cp -r integrations/codex/skills/ragcode-context .claude/skills/
```

Then make sure the MCP server is registered (`ragcode setup-mcp`, or `--print` to paste manually).

## Expected behavior

With the skill installed and MCP available:

- A code-change request triggers `get_context` before any edits.
- An ownership question triggers `find_owner`.
- An impact question triggers `impact_analysis` plus `related_tests`.
- A missing index triggers `index_status` → `index_repo` (or a `ragcode index <repoRoot>` suggestion).
- An embedding configuration issue routes to `ragcode configure`, never to the dashboard.

With MCP disabled, the skill falls back to CLI commands (`ragcode context`, `ragcode owner`, `ragcode impact`, `ragcode tests`, ...).

## Verification scenarios

1. Ask "where should I fix <bug>?" → the agent calls `get_context`/`find_owner` first.
2. Ask "what's the impact of changing <file>?" → `impact_analysis` and `related_tests`.
3. Disable the MCP server → the same questions produce `ragcode ...` CLI invocations.
