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

---

## MCP Tools Reference (Updated v0.1.6)

### `get_context` — Primary Context Tool

**New in v0.1.6**:
- **Format parameter**: Choose between JSON (default) or Markdown output
- **Strict budget enforcement**: Output guaranteed ≤ budgetChars × 1.2
- **Reasoning transparency**: Results include `reason` field explaining relevance
- **Completeness metrics**: `freshnessScore` and `coverageScore` indicators

#### Parameters

```typescript
{
  query: string,              // Natural language or symbol name
  budgetChars?: number,       // Character budget (default: 18000)
  format?: 'json' | 'markdown', // Output format (NEW, default: 'json')
  mode?: 'auto' | 'debug' | 'feature' | 'refactor' | 'review' | 'explain',
  repoRoot?: string
}
```

#### Example (Markdown Format - Recommended)

```typescript
await mcp.callTool('get_context', {
  query: 'login implementation',
  format: 'markdown',    // AI-friendly formatted output
  budgetChars: 15000
});

// Returns:
{
  content: `## Login Implementation (high confidence)

### Primary Files
1. **src/auth/login.ts** (score: 9.2)
   - Reason: Direct implementation of Device Code Flow

### Code Snippets
...`,
  metadata: {
    confidence: "high",
    totalSnippets: 5,
    budgetUsed: 14500,
    freshnessScore: 0.95
  }
}
```

#### Example (JSON Format - Backward Compatible)

```typescript
await mcp.callTool('get_context', {
  query: 'login implementation',
  format: 'json',  // or omit (default)
  budgetChars: 15000
});

// Returns ContextPack structure (unchanged from v0.1.5)
{
  query: "login implementation",
  brief: "...",
  confidence: "high",
  snippets: [...],
  ownerChain: [...],
  freshness: {...}
}
```

#### Budget Enforcement (Fixed in v0.1.6)

Previously, `budgetChars` was only advisory. Now it's **strictly enforced**:

- ✅ Output size guaranteed ≤ budgetChars × 1.2
- ✅ Individual snippets capped at 150 lines or 8000 chars
- ✅ Smart truncation at natural boundaries (functions, classes)
- ✅ Truncation notices in `missingEvidence`

**Real-world impact**: Outputs reduced from 3.3MB to ≤18KB.

#### Reasoning Transparency (New in v0.1.6)

Every result includes a `reason` field:

```json
{
  "filePath": "src/auth/login.ts",
  "score": 9.2,
  "reason": "🎯 Keyword match: login, authentication • Symbol match: registerLoginCommand (0.95) • Graph position: 0 hops"
}
```

This helps agents understand:
- **Why** the file was selected (keyword vs semantic)
- **What** symbols matched
- **How** it relates to other code (graph distance)

#### Completeness Metrics (New in v0.1.6)

Check index freshness before trusting results:

```json
{
  "freshness": {
    "freshnessScore": 0.95,    // 0.0 = stale, 1.0 = fresh
    "coverageScore": 1.0,      // 0.0 = incomplete, 1.0 = complete
    "pendingFiles": [],        // Files not yet indexed
    "staleFiles": []           // Files changed since last index
  }
}
```

**Use these signals**:
- `freshnessScore < 0.8` → Re-index recommended
- `pendingFiles.length > 100` → Large portions not indexed
- `staleFiles.length > 10` → Recent changes not reflected

---

### Known Issues & Workarounds (v0.1.6)

#### Issue 1: Chinese Semantic Search Quality

**Problem**: Chinese queries may return translation files (locales/*.json) instead of code implementations.

**Root cause**: Semantic embedding model has limited Chinese language support.

**Workaround**:

```typescript
// ❌ Avoid: Generic Chinese query
await mcp.callTool('get_context', {
  query: '登录功能的实现'  // May return locales/auth.json
});

// ✅ Use: English query
await mcp.callTool('get_context', {
  query: 'login implementation'  // Returns src/auth/login.ts
});

// ✅ Use: Exact symbol name
await mcp.callTool('get_context', {
  query: 'registerLoginCommand'  // Precise match
});
```

**Agent guidance**: When the user asks in Chinese, translate to English or extract exact symbol names before calling `get_context`.

#### Issue 2: Large Repositories with Incomplete Index

**Problem**: When `pendingFileCount` is high, results may not cover entire codebase.

**Detection**:
```typescript
const result = await mcp.callTool('get_context', {...});

if (result.freshness.pendingFiles.length > 100) {
  // Warn user: "Index incomplete, results may not cover all code"
  // Suggest: ragcode index <repoRoot> to continue indexing
}
```

**Workaround**: Run `ragcode index <repoRoot>` to continue indexing.

---

### CLI Fallback (MCP Unavailable)

When MCP is unavailable, fall back to CLI with equivalent behavior:

```bash
# MCP: get_context with Markdown
ragcode context <repoRoot> "query" --budget 15000 --mode debug

# Note: CLI --format flag not yet implemented (v0.1.6)
# CLI currently returns JSON only
```

**Limitation**: CLI `--format markdown` flag is not yet implemented in v0.1.6. Use MCP for Markdown output.

---

## Version History

### v0.1.6 (2026-06-13)
- Added `format: 'markdown'` parameter
- Fixed budget enforcement (3.3MB → ≤18KB)
- Added reasoning transparency (`reason` field)
- Added completeness metrics (`freshnessScore`, `coverageScore`)
- Known issue: Chinese semantic search quality limited

### v0.1.5 (2026-06-10)
- Initial MCP tools release
- `get_context`, `search_code`, `find_owner`, `impact_analysis`
- Offline-first with deterministic embeddings
