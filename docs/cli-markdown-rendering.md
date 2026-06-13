# CLI Markdown Rendering Specification

**Status**: ⚠️ **Specification Complete, Implementation Pending**  
**Version**: 0.1.6  
**Last Updated**: 2026-06-13

---

## Implementation Status

### ✅ Completed (v0.1.6)
- **MCP server Markdown format support** (`src/mcp/tools.ts`)
- **Markdown formatter implementation** (`src/context/markdown-formatter.ts`)
- **Format parameter validation** (Zod schema)
- **Budget enforcement** for Markdown output
- **Documentation** (this file, README.md, CODEX_SKILL.md)

### ⚠️ Pending (Future Release)
- **CLI `--format` flag** - Not yet implemented
- **Terminal rendering** (bat/ANSI fallback)
- **Cross-terminal testing**
- **Interactive details tag expansion**

### Current Behavior (v0.1.6)

**MCP clients** (Claude Code, Codex, etc.):
```typescript
// ✅ Works now
await mcp.callTool('get_context', {
  query: 'authentication',
  format: 'markdown',
  budgetChars: 15000
});
```

**CLI**:
```bash
# ⚠️ Not yet implemented
ragcode context . "authentication" --format markdown --budget 15000
# Currently returns JSON only
```

---

## Overview

This document specifies how the RagCode CLI should render Markdown output when `format: "markdown"` is requested via the `get_context` MCP tool. The MCP server returns plain Markdown strings; the CLI layer adds terminal-specific rendering enhancements.

**Important**: This specification is for CLI implementation, NOT the MCP server. The MCP server's responsibility ends at returning a plain Markdown string.

## Rendering Requirements

### 1. Code Block Syntax Highlighting

**Objective**: Provide syntax highlighting for code blocks in terminal output.

**Implementation**:
1. Detect if `bat` is available: `which bat || where bat`
2. **If `bat` is present**: Pipe code blocks through `bat --language={lang} --style=plain --color=always`
3. **If `bat` is absent**: Apply basic ANSI highlighting using `chalk` or similar:
   - Keywords (function, class, if, return, etc.) → Blue (`\x1b[34m`)
   - Strings (content in quotes) → Green (`\x1b[32m`)
   - Comments (// or /* */) → Gray (`\x1b[90m`)
   - Reset after block → `\x1b[0m`

**Example**:
```typescript
// With bat:
const highlighted = spawnSync('bat', [
  '--language=typescript',
  '--style=plain',
  '--color=always'
], { input: codeBlock }).stdout.toString();

// Without bat (fallback):
const highlighted = codeBlock
  .replace(/\b(function|class|if|return|const|let|var)\b/g, '\x1b[34m$1\x1b[0m')
  .replace(/(["'`].*?["'`])/g, '\x1b[32m$1\x1b[0m')
  .replace(/(\/\/.*$)/gm, '\x1b[90m$1\x1b[0m');
```

### 2. `<details>` Tag Handling

**Problem**: Terminals do not support interactive HTML `<details>` tags.

**Degradation Strategy**:
- **Non-interactive mode** (piped output, e.g., `ragcode ... | less`):
  - Collapse to: `[+] Summary text` (collapsed indicator, content not shown)
- **Interactive mode** (direct terminal output):
  - Render as: `[+] Summary text`
  - Add hint below: `(Note: this is a collapsible section in web view)`
  - Show collapsed content as regular text with indentation

**Example**:
```
Input (Markdown):
<details>
<summary>Why this file is relevant</summary>
Contains the authentication logic for JWT validation.
</details>

Output (terminal):
[+] Why this file is relevant
    (Note: this is a collapsible section in web view)
    Contains the authentication logic for JWT validation.
```

### 3. Reasoning Chain Styling

**Objective**: Visually separate reasoning chains from code snippets.

**Implementation**:
- Apply dim gray ANSI color to reasoning text: `\x1b[90m`
- Reset after reasoning block: `\x1b[0m`
- Reasoning typically appears as italic text with icons (🔍, 🎯, 📊) in Markdown

**Example**:
```
Input (Markdown):
*🔍 Matched: authentication, login | 🎯 Symbol: validateToken (exact)*

Output (terminal):
\x1b[90m🔍 Matched: authentication, login | 🎯 Symbol: validateToken (exact)\x1b[0m
```

### 4. Cross-Terminal Testing Matrix

Before merging CLI Markdown rendering, manually validate on the following terminals:

- [ ] **Windows Terminal** (Windows 11) - Verify ANSI codes render correctly
- [ ] **macOS Terminal.app** - Verify bat integration and fallback
- [ ] **Linux GNOME Terminal** - Verify color rendering and emoji support
- [ ] **Non-interactive pipe**: `ragcode get_context --query "auth" --format markdown | less`
  - Verify output is readable with no broken ANSI escape sequences
  - Verify `<details>` tags degrade gracefully

**Test Procedure**:
1. Run `ragcode get_context --query "authentication" --format markdown`
2. Verify code blocks have syntax highlighting
3. Verify reasoning chains appear dimmed
4. Check emoji rendering (📁, 💻, 🔗, ⚠️)
5. Pipe to `less` and verify no broken escape codes

## Non-Requirements

The following are explicitly **out of scope** for this specification:

1. **Interactive collapsible sections**: Terminals cannot support `<details>` interactivity
2. **Custom color themes**: Use terminal's default color scheme
3. **Pager integration**: Let users choose their own pager (`less`, `more`, `bat --paging`)
4. **Emoji fallbacks**: Assume modern terminals support Unicode emoji

## Implementation Timeline

- **Phase 1** (P0): Basic Markdown rendering (code blocks, headings, lists)
- **Phase 2** (P1): Syntax highlighting with `bat` integration
- **Phase 3** (P1): Reasoning chain styling
- **Phase 4** (P2): `<details>` tag degradation

## Examples

### Full Workflow Example

**Input** (MCP server returns):
```markdown
# authentication

**Confidence**: high | **Mode**: feature

## 📁 Primary Files (2)

1. **src/auth/jwt.ts** (score: 8.5)
   JWT token validation and generation
   *Symbols*: validateToken, generateToken

## 💻 Code Snippets (1)

### src/auth/jwt.ts

**function: validateToken** • Lines 15-25

```typescript
export function validateToken(token: string): boolean {
  try {
    const decoded = jwt.verify(token, SECRET);
    return decoded !== null;
  } catch {
    return false;
  }
}
```

## ⚠️ Limitations

- Pending files need indexing: src/auth/refresh.ts.

---
*Used 2,450 / 15,000 chars*
```

**Expected CLI Output** (with `bat` and colors):
```
# authentication

Confidence: high | Mode: feature

## 📁 Primary Files (2)

1. src/auth/jwt.ts (score: 8.5)
   JWT token validation and generation
   Symbols: validateToken, generateToken

## 💻 Code Snippets (1)

### src/auth/jwt.ts

function: validateToken • Lines 15-25

[Syntax-highlighted code block in blue/green/gray]
export function validateToken(token: string): boolean {
  try {
    const decoded = jwt.verify(token, SECRET);
    return decoded !== null;
  } catch {
    return false;
  }
}

## ⚠️ Limitations

- Pending files need indexing: src/auth/refresh.ts.

---
Used 2,450 / 15,000 chars
```

## Dependencies

- **Optional**: `bat` (for enhanced syntax highlighting)
- **Required**: ANSI color support (fallback for syntax highlighting)
- **Recommended**: `chalk` or similar library for ANSI styling

## Notes for Implementers

1. Keep the rendering layer separate from MCP server logic
2. Test on Windows (cmd.exe, PowerShell, Windows Terminal) separately from Unix shells
3. Consider adding a `--no-color` flag to disable ANSI codes
4. Respect `NO_COLOR` environment variable per standard conventions
5. Use `process.stdout.isTTY` to detect interactive vs piped output

## References

- MCP server implementation: `src/mcp/tools.ts` (get_context handler)
- Markdown formatter: `src/context/markdown-formatter.ts`
- Bat documentation: https://github.com/sharkdp/bat
- ANSI escape codes: https://en.wikipedia.org/wiki/ANSI_escape_code
