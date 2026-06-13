#!/usr/bin/env node
/**
 * Auto-configure RagCode as an MCP server for AI coding clients.
 *
 * Supported clients:
 *   - claude       Claude Desktop      JSON  ~/.../claude_desktop_config.json   (mcpServers.ragcode)
 *   - claude-code  Claude Code (repo)  JSON  <cwd>/.mcp.json                    (mcpServers.ragcode)
 *   - codex        Codex CLI           TOML  ~/.codex/config.toml               (mcp_servers.ragcode)
 *   - generic      print only          JSON  (paste into any MCP client)
 *   - all          multi-client        JSON+TOML  Claude Code .mcp.json + Codex config.toml
 *
 * Merge strategy: existing config is parsed, the `ragcode` entry is upserted, and the
 * file is rewritten. Other servers and unrelated keys are preserved. The previous file
 * is backed up alongside the original before any overwrite.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { loadRuntimeConfig, runtimeConfigToEnv } from '../src/config/runtime-config.js';

export type McpClient = 'claude' | 'claude-code' | 'codex' | 'generic' | 'all';
const DEFAULT_ALL_CLIENTS: Exclude<McpClient, 'generic' | 'all'>[] = ['claude-code', 'codex'];

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
  client?: McpClient;
  /** Skip the interactive overwrite prompt and replace any existing ragcode entry. */
  force?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

const SERVER_KEY = 'ragcode';

// ---------------------------------------------------------------------------
// Config-path resolution (one per client)
// ---------------------------------------------------------------------------

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

/** Claude Code reads project-scoped MCP servers from `<repoRoot>/.mcp.json`. */
export function getClaudeCodeMCPConfigPath(cwd: string): string {
  return path.join(cwd, '.mcp.json');
}

/** Codex CLI reads MCP servers from `~/.codex/config.toml` (CODEX_HOME overrides ~/.codex). */
export function getCodexConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.CODEX_HOME && env.CODEX_HOME.trim().length > 0
    ? env.CODEX_HOME
    : path.join(os.homedir(), '.codex');
  return path.join(home, 'config.toml');
}

function resolveConfigPath(client: McpClient, options: SetupMcpOptions): string {
  if (options.configPath) return options.configPath;
  const cwd = options.cwd ?? process.cwd();
  switch (client) {
    case 'codex':
      return getCodexConfigPath(options.env ?? process.env);
    case 'claude-code':
      return getClaudeCodeMCPConfigPath(cwd);
    case 'claude':
      return getClaudeMCPConfigPath();
    case 'all':
    case 'generic':
    default:
      throw new Error(`Client ${client} does not have a single writable config path.`);
  }
}

// ---------------------------------------------------------------------------
// Server config (shared core — unchanged contract, tests depend on this)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Pure merge functions (no IO — unit-testable)
// ---------------------------------------------------------------------------

/**
 * Upsert the ragcode server into a JSON MCP config object (Claude Desktop / Claude Code).
 * Unknown top-level keys and other servers are preserved. Returns a new object.
 */
export function mergeMcpServersJson(existing: unknown, server: MCPServerConfig): MCPConfig {
  const base: Record<string, unknown> =
    existing && typeof existing === 'object' ? { ...(existing as Record<string, unknown>) } : {};
  const servers =
    base.mcpServers && typeof base.mcpServers === 'object'
      ? { ...(base.mcpServers as Record<string, unknown>) }
      : {};
  servers[SERVER_KEY] = server;
  return { ...base, mcpServers: servers } as MCPConfig;
}

/**
 * Upsert the ragcode server into a Codex config.toml string.
 * Parses existing TOML, sets `mcp_servers.ragcode`, and re-stringifies. Other tables and
 * keys are preserved; TOML comments are not (smol-toml limitation — callers back up first).
 */
export function mergeCodexToml(existingToml: string, server: MCPServerConfig): string {
  let root: Record<string, unknown> = {};
  const trimmed = existingToml.trim();
  if (trimmed.length > 0) {
    const parsed = parseToml(existingToml);
    if (parsed && typeof parsed === 'object') {
      root = parsed as Record<string, unknown>;
    }
  }

  const mcpServers =
    root.mcp_servers && typeof root.mcp_servers === 'object'
      ? { ...(root.mcp_servers as Record<string, unknown>) }
      : {};

  // Codex stdio server schema: command, args, env. cwd is honored by recent Codex builds and
  // ignored by older ones; the env values already carry absolute paths so behavior is correct
  // either way. Drop undefined keys so the emitted TOML stays clean.
  const entry: Record<string, unknown> = {
    command: server.command,
    args: server.args
  };
  if (server.cwd) entry.cwd = server.cwd;
  if (server.env && Object.keys(server.env).length > 0) entry.env = server.env;

  mcpServers[SERVER_KEY] = entry;
  root.mcp_servers = mcpServers;

  return stringifyToml(root);
}

function isJsonClient(client: McpClient): boolean {
  return client === 'claude' || client === 'claude-code';
}

// ---------------------------------------------------------------------------
// IO helpers
// ---------------------------------------------------------------------------

function ensureDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    console.log(`📁 Creating config directory: ${dir}`);
    fs.mkdirSync(dir, { recursive: true });
  }
}

function backupExisting(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const backup = `${filePath}.ragcode-backup`;
  fs.copyFileSync(filePath, backup);
  console.log(`🗂️  Backed up existing config to: ${backup}`);
}

function readFileSafe(filePath: string): string | undefined {
  try {
    if (fs.existsSync(filePath)) return fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    console.warn(`⚠️  Failed to read existing config: ${err}`);
  }
  return undefined;
}

/** Detect whether a ragcode entry already exists in the on-disk config. */
function hasExistingEntry(client: McpClient, raw: string | undefined): boolean {
  if (!raw) return false;
  try {
    if (isJsonClient(client)) {
      const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
      return Boolean(parsed.mcpServers && SERVER_KEY in parsed.mcpServers);
    }
    const parsed = parseToml(raw) as { mcp_servers?: Record<string, unknown> };
    return Boolean(parsed.mcp_servers && SERVER_KEY in parsed.mcp_servers);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function setupMCP(options: SetupMcpOptions = {}): void {
  const client: McpClient = options.client ?? 'claude-code';
  validateClient(client);

  if (options.print || client === 'generic') {
    printConfig(options);
    return;
  }

  if (client === 'all') {
    if (options.configPath) {
      throw new Error('--config cannot be used with --client all because each client has a different config path.');
    }
    for (const targetClient of DEFAULT_ALL_CLIENTS) {
      setupMCP({ ...options, client: targetClient });
    }
    return;
  }

  const configPath = resolveConfigPath(client, options);
  const server = buildMcpServerConfig(options);
  const raw = readFileSafe(configPath);

  console.log(`📍 ${clientLabel(client)} config path: ${configPath}`);

  if (hasExistingEntry(client, raw) && !options.force) {
    if (!process.stdin.isTTY) {
      console.log('⚠️  RagCode is already configured here. Re-run with --force to overwrite, or remove the existing entry first.');
      return;
    }
    void import('node:readline').then((readline) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question('\n⚠️  RagCode is already configured. Overwrite existing entry? (y/N): ', (answer: string) => {
        rl.close();
        if (answer.trim().toLowerCase() !== 'y') {
          console.log('❌ Setup cancelled.');
          return;
        }
        writeClientConfig(client, configPath, raw, server);
      });
    });
    return;
  }

  writeClientConfig(client, configPath, raw, server);
}

function writeClientConfig(
  client: McpClient,
  configPath: string,
  raw: string | undefined,
  server: MCPServerConfig
): void {
  ensureDir(configPath);
  backupExisting(configPath);

  let contents: string;
  if (isJsonClient(client)) {
    let existing: unknown = {};
    if (raw) {
      try {
        existing = JSON.parse(raw);
      } catch (err) {
        console.warn(`⚠️  Existing config is not valid JSON; starting fresh. (${err})`);
      }
    }
    contents = `${JSON.stringify(mergeMcpServersJson(existing, server), null, 2)}\n`;
  } else {
    // codex
    contents = mergeCodexToml(raw ?? '', server);
  }

  try {
    fs.writeFileSync(configPath, contents, 'utf-8');
  } catch (err) {
    console.error(`❌ Failed to write config: ${err}`);
    process.exitCode = 1;
    return;
  }

  console.log(`\n✅ RagCode MCP server configured for ${clientLabel(client)}.`);
  console.log('\n📝 Server entry:');
  console.log(JSON.stringify(server, null, 2));
  if (server.env?.RAGCODE_EMBEDDING_API_KEY === '<redacted>') {
    console.log('\n⚠️  API key was redacted. Re-run with --include-secrets to embed it, or set the key in your environment.');
  }
  console.log(`\n🔄 ${restartHint(client)}`);
}

function printConfig(options: SetupMcpOptions = {}): void {
  const client: McpClient = options.client ?? 'generic';
  const server = buildMcpServerConfig(options);

  if (client === 'all') {
    console.log('Claude Code / generic MCP JSON config:\n');
    console.log(JSON.stringify({ mcpServers: { [SERVER_KEY]: server } }, null, 2));
    console.log('\nCodex TOML config:\n');
    console.log(mergeCodexToml('', server));
    return;
  }

  if (client === 'codex') {
    console.log('Add this to your Codex config (~/.codex/config.toml):\n');
    console.log(mergeCodexToml('', server));
    return;
  }

  console.log('Add this to your MCP client config:\n');
  console.log(JSON.stringify({ mcpServers: { [SERVER_KEY]: server } }, null, 2));
}

function clientLabel(client: McpClient): string {
  switch (client) {
    case 'claude':
      return 'Claude Desktop';
    case 'claude-code':
      return 'Claude Code';
    case 'codex':
      return 'Codex';
    case 'all':
      return 'Claude Code and Codex';
    case 'generic':
      return 'generic MCP client';
  }
}

function restartHint(client: McpClient): string {
  switch (client) {
    case 'claude':
      return 'Restart Claude Desktop to activate the MCP server.';
    case 'claude-code':
      return 'Reopen the project in Claude Code (it loads .mcp.json on startup) to activate the server.';
    case 'codex':
      return 'Restart your Codex session to activate the MCP server.';
    default:
      return 'Restart your client to activate the MCP server.';
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printHelp(): void {
  console.log(`
RagCode MCP Setup

Usage:
  ragcode setup-mcp [options]

Options:
  --config <path>    Custom config path (overrides the client default)
  --print            Print config without writing
  --include-secrets  Include real secrets instead of redacted placeholders
  --client <client>  Target client: claude, claude-code, codex, generic, or all (default: claude-code)
  --force            Overwrite an existing ragcode entry without prompting
  --help, -h         Show this help

Examples:
  ragcode setup-mcp                          # Claude Code .mcp.json (default)
  ragcode --setup mcp                        # Claude Code .mcp.json + Codex config.toml
  ragcode setup-mcp --client claude          # Claude Desktop (global)
  ragcode setup-mcp --client codex           # ~/.codex/config.toml
  ragcode setup-mcp --client all             # Claude Code .mcp.json + Codex config.toml
  ragcode setup-mcp --client codex --print   # print TOML, write nothing
  ragcode setup-mcp --config ~/custom.json   # custom path
  `);
}

export function parseSetupMcpArgs(args: string[], options: { defaultClient?: McpClient } = {}): SetupMcpOptions {
  const configIndex = args.indexOf('--config');
  const clientIndex = args.indexOf('--client');
  const client = clientIndex >= 0 ? args[clientIndex + 1] : options.defaultClient;
  validateClient(client);
  return {
    print: args.includes('--print'),
    includeSecrets: args.includes('--include-secrets'),
    force: args.includes('--force'),
    configPath: configIndex >= 0 ? args[configIndex + 1] : undefined,
    client: client as McpClient | undefined
  };
}

function validateClient(client: string | undefined): void {
  if (client && !['claude', 'claude-code', 'codex', 'generic', 'all'].includes(client)) {
    throw new Error(`Unsupported MCP client: ${client} (expected claude, claude-code, codex, generic, or all)`);
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
    setupMCP(parseSetupMcpArgs(args));
  } catch (error) {
    console.error(`❌ MCP setup failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
