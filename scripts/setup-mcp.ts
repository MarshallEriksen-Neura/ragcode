#!/usr/bin/env node
/**
 * Auto-configure RagCode as an MCP server for Claude Desktop
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadRuntimeConfig, runtimeConfigToEnv } from '../src/config/runtime-config.js';

interface MCPServerConfig {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

interface MCPConfig {
  mcpServers: Record<string, MCPServerConfig>;
}

export interface SetupMcpOptions {
  configPath?: string;
  print?: boolean;
  includeSecrets?: boolean;
  client?: 'claude' | 'codex' | 'generic';
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export function getClaudeMCPConfigPath(): string {
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
    execFileSync('ragcode', ['--version'], { stdio: 'ignore' });
    return 'ragcode';
  } catch {
    // Fallback to npx
    return 'npx';
  }
}

export function setupMCP(options: SetupMcpOptions = {}): MCPConfig | MCPServerConfig {
  validateClient(options.client);
  if (options.print) return printConfig(options);

  const configPath = options.configPath || getClaudeMCPConfigPath();
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
    void import('node:readline').then((readline) => {
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
        writeConfig(config, configPath, options);
      });
    });
  } else {
    writeConfig(config, configPath, options);
  }

  return config;
}

function writeConfig(config: MCPConfig, configPath: string, options: SetupMcpOptions): void {
  // Add ragcode server config
  config.mcpServers.ragcode = buildMcpServerConfig(options);

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

export function buildMcpServerConfig(options: SetupMcpOptions = {}): MCPServerConfig {
  const command = getRagCodeCommand();
  const args = command === 'npx' ? ['ragcode-context-engine', 'mcp'] : ['mcp'];
  const runtime = loadRuntimeConfig({ cwd: options.cwd ?? process.cwd(), env: options.env ?? process.env });

  return {
    command,
    args,
    cwd: runtime.repoRoot,
    env: runtimeConfigToEnv(runtime, { includeSecrets: options.includeSecrets })
  };
}

function printConfig(options: SetupMcpOptions = {}): MCPServerConfig {
  const config = buildMcpServerConfig(options);

  console.log('Add this to your MCP client config:\n');
  console.log(JSON.stringify({ mcpServers: { ragcode: config } }, null, 2));
  return config;
}

function printHelp(): void {
  console.log(`
RagCode MCP Setup

Usage:
  ragcode setup-mcp [options]

Options:
  --config <path>    Custom MCP config path
  --print            Print config without writing
  --include-secrets  Include real secrets instead of redacted placeholders
  --client <client>  Client format: claude, codex, or generic
  --help, -h         Show this help

Examples:
  ragcode setup-mcp
  ragcode setup-mcp --config ~/.config/custom-mcp.json
  ragcode setup-mcp --print
  `);
}

function parseOptions(args: string[]): SetupMcpOptions {
  const configIndex = args.indexOf('--config');
  const clientIndex = args.indexOf('--client');
  const client = clientIndex >= 0 ? args[clientIndex + 1] : undefined;
  validateClient(client);
  return {
    print: args.includes('--print'),
    includeSecrets: args.includes('--include-secrets'),
    configPath: configIndex >= 0 ? args[configIndex + 1] : undefined,
    client: client as SetupMcpOptions['client'] | undefined
  };
}

function validateClient(client: string | undefined): void {
  if (client && client !== 'claude' && client !== 'codex' && client !== 'generic') {
    throw new Error(`Unsupported MCP client: ${client}`);
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    process.exit(0);
  }

  try {
    setupMCP(parseOptions(args));
  } catch (error) {
    console.error(`❌ MCP setup failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
