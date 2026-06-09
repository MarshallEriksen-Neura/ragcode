# RagCode Installation Guide

## Quick Start

### Option 1: Global Installation (Recommended)

```bash
npm install -g ragcode-context-engine

# Verify installation
ragcode --version

# Index your project
cd /path/to/your/project
ragcode index .

# Search code
ragcode search . "function query"
```

### Option 2: npx (No Installation)

```bash
# Run directly without installing
npx ragcode-context-engine index .
npx ragcode-context-engine search . "query"
```

### Option 3: Local Development Dependency

```bash
# Add to your project
npm install --save-dev ragcode-context-engine

# Use via npm scripts
{
  "scripts": {
    "index": "ragcode index .",
    "search": "ragcode search ."
  }
}
```

---

## Requirements

- **Node.js**: >= 24.0.0
- **Operating System**: Windows, macOS, Linux
- **Disk Space**: ~100MB for dependencies + index data

---

## Configuration

### 1. Basic Setup

Create `.ragcode/config.json` in your project root:

```json
{
  "graphStore": "sqlite",
  "sqlitePath": ".ragcode/graph.sqlite",
  "semanticStore": "lancedb",
  "lancedbUri": ".ragcode/lancedb",
  "embeddingProvider": "openai"
}
```

### 2. Environment Variables

```bash
# Graph storage
export RAGCODE_GRAPH_STORE=sqlite
export RAGCODE_SQLITE_PATH=.ragcode/graph.sqlite

# Semantic storage
export RAGCODE_SEMANTIC_STORE=lancedb
export RAGCODE_LANCEDB_URI=.ragcode/lancedb

# Embedding provider
export RAGCODE_EMBEDDING_PROVIDER=openai
export OPENAI_API_KEY=your-api-key

# Or use deterministic embeddings (offline mode)
export RAGCODE_EMBEDDING_PROVIDER=deterministic
```

### 3. Interactive Setup Wizard

```bash
ragcode init
# Walks you through configuration step-by-step
```

---

## MCP Server Integration

RagCode can run as an MCP (Model Context Protocol) server for AI agents like Claude.

### Automatic Setup

```bash
# Auto-configure for Claude Desktop
ragcode setup-mcp

# Or specify custom MCP config location
ragcode setup-mcp --config ~/.config/claude/mcp.json
```

### Manual Setup

Add to your MCP client config (e.g., Claude Desktop):

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
        "RAGCODE_EMBEDDING_PROVIDER": "openai",
        "OPENAI_API_KEY": "your-api-key"
      }
    }
  }
}
```

**Available MCP Tools**:
- `index_repo`: Index a codebase
- `search_code`: Hybrid search (keyword + semantic + graph)
- `get_context`: Build agent-ready context packs
- `find_symbol`: Locate symbol definitions
- `explain_file`: Get file overview with symbols
- `find_owner`: Trace ownership chains
- `impact_analysis`: Analyze change impact
- `related_tests`: Find related test files
- `trace_flow`: Trace execution flows
- `review_diff`: Review code changes

---

## Web Dashboard

Launch the web-based management interface:

```bash
ragcode dashboard

# Or manually
ragcode web:server  # Backend (port 3000)
cd web && npm run dev  # Frontend (port 5173)
```

**Dashboard Features**:
- Configuration management
- Real-time index statistics
- Code graph visualization
- Search debugger
- Live file change monitoring

---

## Offline Mode

Use deterministic embeddings for offline development:

```bash
export RAGCODE_EMBEDDING_PROVIDER=deterministic

ragcode index .
ragcode search . "query"
```

**Note**: Deterministic embeddings are less accurate but require no API calls.

---

## Docker Deployment

```bash
# Pull image
docker pull ragcode/ragcode-engine:latest

# Run as MCP server
docker run -p 3000:3000 \
  -v /path/to/code:/workspace \
  -e OPENAI_API_KEY=your-key \
  ragcode/ragcode-engine:latest mcp

# Run with dashboard
docker run -p 3000:3000 -p 5173:5173 \
  -v /path/to/code:/workspace \
  ragcode/ragcode-engine:latest dashboard
```

---

## Troubleshooting

### Command Not Found

```bash
# Ensure global npm bin is in PATH
npm config get prefix
# Add <prefix>/bin to your PATH

# Or use full path
$(npm config get prefix)/bin/ragcode
```

### Node Version Issues

```bash
# Check Node version
node --version  # Must be >= 24

# Upgrade Node
nvm install 24
nvm use 24
```

### Permission Errors (Unix)

```bash
# Fix npm global permissions
sudo chown -R $(whoami) $(npm config get prefix)/{lib/node_modules,bin,share}
```

### Index Not Found

```bash
# Verify project is indexed
ragcode doctor .

# Re-index if needed
ragcode index . --force
```

---

## Uninstallation

```bash
# Remove global installation
npm uninstall -g ragcode-context-engine

# Clean up data
rm -rf .ragcode/
```

---

## Next Steps

- [CLI Reference](./CLI.md)
- [MCP Tools Reference](./MCP_TOOLS.md)
- [Configuration Guide](./CONFIGURATION.md)
- [Architecture Overview](./ARCHITECTURE.md)
