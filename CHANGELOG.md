# Changelog

All notable changes to RagCode will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.6] - 2026-06-13

### Added
- **Format parameter support**: `get_context` MCP tool now accepts `format: 'json' | 'markdown'` for flexible output
- **Markdown formatter**: New `formatContextAsMarkdown()` function generates AI-friendly formatted output with:
  - Syntax-highlighted code blocks
  - Structured sections (primary files, snippets, call graph, limitations)
  - Budget usage statistics in footer
- **Reasoning transparency**: All search results now include `reason` field explaining:
  - Keyword matches vs semantic similarity
  - Symbol matches and graph relationships
  - Distance from query intent
- **Completeness metrics**: Added freshness and coverage scoring:
  - `freshnessScore`: Index freshness indicator (0.0-1.0)
  - `coverageScore`: Coverage completeness (0.0-1.0)
  - User-facing recommendations when index is stale

### Fixed
- **Critical: Output size enforcement**: Strictly enforce `budgetChars` limit
  - Output now guaranteed ≤ `budgetChars × 1.2` (was: 3.3MB for 15KB budget)
  - Real-world reduction: 2,413,543 bytes → 16,403 bytes (99.3% compression)
  - Enables AI agents to use RagCode outputs within token limits
- **Snippet truncation**: Individual snippets now capped at 150 lines or 8000 characters
  - Smart truncation at natural boundaries (functions, classes) within ±10 lines
  - Clear truncation markers indicating omitted content
- **Cost estimation accuracy**: Improved budget estimation formula
  - Added 30% JSON serialization overhead factor
  - Added 200-char field overhead constant
  - Accuracy within 20% of actual output size
- **Code duplication**: Eliminated duplicate `truncateContextPack` implementations
  - Extracted to shared module `src/context/truncate-context-pack.ts`
  - CLI and MCP now use single implementation

### Changed
- **Enhanced output structure**: Improved `get_context` return format
  - Enriched `ownerChain` with reasoning for each file
  - Extended `missingEvidence` with actionable truncation notices
  - Optimized `freshness` metadata (limited file lists to prevent output bloat)
- **Backward compatible**: Default `format: 'json'` preserves existing ContextPack structure

### Known Issues
- **Chinese semantic search quality**: May return translation files (locales/*.json) instead of code implementations
  - **Workaround**: Use English queries or exact symbol names (e.g., "registerLoginCommand" instead of "登录功能")
  - **Root cause**: Semantic embedding model has limited Chinese language support
  - **Tracked in**: [Enhancement] Improve Chinese semantic search quality (P1)
- **Large repositories**: Results may be incomplete when `pendingFileCount` is high
  - Check `freshness.pendingFiles` count in output
  - Re-run `ragcode index <repoRoot>` to update index
- **CLI format flag**: `--format markdown` not yet implemented in CLI (MCP only)
  - MCP clients (Claude Code, etc.) can use `format: 'markdown'` immediately
  - CLI support planned for v0.1.7

## [0.1.5] - 2026-06-10

### Added
- Initial public release
- MCP server with core tools: `get_context`, `search_code`, `find_owner`, `impact_analysis`
- SQLite-based structural graph index
- LanceDB semantic vector search
- File watcher with incremental updates

### Security
- All processing fully local (no code leaves machine)
- Offline-capable with deterministic embeddings

---

## Release Notes

### v0.1.6 Summary

This release focuses on **output size control** and **transparency improvements** to make RagCode practical for AI agents with token limits.

**Key achievement**: Reduced typical `get_context` output from 3.3MB to ≤18KB while maintaining search quality.

**Upgrade recommendation**: Immediate upgrade recommended for all users experiencing large output issues.

### Breaking Changes

None. All changes are backward compatible with v0.1.5.

### Migration Guide

No migration required. Existing MCP clients continue to work unchanged:

```javascript
// v0.1.5 (still works)
await mcp.callTool('get_context', {
  query: 'authentication',
  budgetChars: 15000
});

// v0.1.6 (new feature)
await mcp.callTool('get_context', {
  query: 'authentication',
  format: 'markdown',  // New parameter
  budgetChars: 15000
});
```

### Contributors

- Claude (Ralph workflow) - Output optimization implementation
- RagCode team - Architecture review and testing
