#!/usr/bin/env node
/**
 * Auto-configure RagCode as an MCP server for Claude Desktop
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

interface MCPServerConfig {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

interface MCPConfig {
  mcpServers: Record<string, MCPServerConfig>;
}

function getClaudeMCPConfigPath(): string {
  const platform = os.platform();

  if (platform === 'win32') {
    return path.join(os.homedir(), 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json');
  } else if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  } else {
    // Linux
    return path.join(os.homedir(), '.config', 'claude', 'claude_desktop_config.json');
  }
}

function loadOrCreateMCPConfig(configPath: string): MCPConfig {
  try {
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf-8');
      return JSON.parse(content);
    }
  } catch (err) {
    console.warn(`⚠️  Failed to read existing config: ${err}`);
  }

  return { mcpServers: {} };
}

function getRagCodeCommand(): string {
  // Check if ragcode is globally installed
  try {
    const { execSync } = require('node:child_process');
    execSync('ragcode --version', { stdio: 'ignore' });
    return 'ragcode';
  } catch {
    // Fallback to npx
    return 'npx';
  }
}

function setupMCP(customConfigPath?: string): void {
  const configPath = customConfigPath || getClaudeMCPConfigPath();
  const configDir = path.dirname(configPath);

  console.log(`📍 MCP config path: ${configPath}`);

  // Ensure config directory exists
  if (!fs.existsSync(configDir)) {
    console.log(`📁 Creating config directory: ${configDir}`);
    fs.mkdirSync(configDir, { recursive: true });
  }

  // Load or create config
  const config = loadOrCreateMCPConfig(configPath);

  // Check if ragcode is already configured
  if (config.mcpServers.ragcode) {
    console.log('⚠️  RagCode MCP server is already configured.');
    console.log('Current config:');
    console.log(JSON.stringify(config.mcpServers.ragcode, null, 2));

    // Ask for confirmation to overwrite
    const readline = require('node:readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    rl.question('\nOverwrite existing configuration? (y/N): ', (answer: string) => {
      rl.close();
      if (answer.toLowerCase() !== 'y') {
        console.log('❌ Setup cancelled.');
        process.exit(0);
      }
      writeConfig(config, configPath);
    });
  } else {
    writeConfig(config, configPath);
  }
}

function writeConfig(config: MCPConfig, configPath: string): void {
  const command = getRagCodeCommand();
  const args = command === 'npx' ? ['ragcode-context-engine', 'mcp'] : ['mcp'];

  // Add ragcode server config
  config.mcpServers.ragcode = {
    command,
    args,
    env: {
      RAGCODE_GRAPH_STORE: 'sqlite',
      RAGCODE_SQLITE_PATH: '.ragcode/graph.sqlite',
      RAGCODE_SEMANTIC_STORE: 'lancedb',
      RAGCODE_LANCEDB_URI: '.ragcode/lancedb',
      RAGCODE_EMBEDDING_PROVIDER: 'openai',
      // User should set this via system env
      // OPENAI_API_KEY: 'your-api-key'
    }
  };

  // Write config
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    console.log('\n✅ RagCode MCP server configured successfully!');
    console.log('\n📝 Configuration written:');
    console.log(JSON.stringify(config.mcpServers.ragcode, null, 2));
    console.log('\n⚠️  Remember to set OPENAI_API_KEY in your environment:');
    console.log('   export OPENAI_API_KEY=your-api-key');
    console.log('\n🔄 Restart Claude Desktop to activate the MCP server.');
  } catch (err) {
    console.error(`❌ Failed to write config: ${err}`);
    process.exit(1);
  }
}

function printConfig(): void {
  const command = getRagCodeCommand();
  const args = command === 'npx' ? ['ragcode-context-engine', 'mcp'] : ['mcp'];

  const config: MCPServerConfig = {
    command,
    args,
    env: {
      RAGCODE_GRAPH_STORE: 'sqlite',
      RAGCODE_SQLITE_PATH: '.ragcode/graph.sqlite',
      RAGCODE_SEMANTIC_STORE: 'lancedb',
      RAGCODE_LANCEDB_URI: '.ragcode/lancedb',
      RAGCODE_EMBEDDING_PROVIDER: 'openai',
      OPENAI_API_KEY: 'your-api-key'
    }
  };

  console.log('Add this to your MCP client config:\n');
  console.log(JSON.stringify({ mcpServers: { ragcode: config } }, null, 2));
}

// CLI
const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
RagCode MCP Setup

Usage:
  ragcode setup-mcp [options]

Options:
  --config <path>    Custom MCP config path
  --print            Print config without writing
  --help, -h         Show this help

Examples:
  ragcode setup-mcp
  ragcode setup-mcp --config ~/.config/custom-mcp.json
  ragcode setup-mcp --print
  `);
  process.exit(0);
}

if (args.includes('--print')) {
  printConfig();
} else {
  const configIndex = args.indexOf('--config');
  const customPath = configIndex >= 0 ? args[configIndex + 1] : undefined;
  setupMCP(customPath);
}
