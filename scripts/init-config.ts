#!/usr/bin/env node
/**
 * Interactive configuration wizard for RagCode
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { DEFAULT_RUNTIME_CONFIG, writeRuntimeConfigFile, type RuntimeConfigFile } from '../src/config/runtime-config.js';

interface ConfigOptions {
  graphStore: 'sqlite' | 'memory';
  sqlitePath?: string;
  semanticStore: 'lancedb' | 'memory';
  lancedbUri?: string;
  embeddingProvider: 'openai-compatible' | 'deterministic';
  openaiApiKey?: string;
}

export interface InitConfigOptions {
  targetDir?: string;
  defaults?: boolean;
}

export interface InitConfigResult {
  targetDir: string;
  configPath: string;
  config: RuntimeConfigFile;
}

const DEFAULT_INIT_CONFIG: ConfigOptions = {
  graphStore: DEFAULT_RUNTIME_CONFIG.graphStore,
  sqlitePath: DEFAULT_RUNTIME_CONFIG.sqlitePath,
  semanticStore: DEFAULT_RUNTIME_CONFIG.semanticStore,
  lancedbUri: DEFAULT_RUNTIME_CONFIG.lancedbUri,
  embeddingProvider: DEFAULT_RUNTIME_CONFIG.embeddingProvider
};

function createInterface() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
}

function question(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise(resolve => {
    rl.question(prompt, answer => resolve(answer.trim()));
  });
}

async function runWizard(): Promise<ConfigOptions> {
  const rl = createInterface();
  const config: ConfigOptions = {
    graphStore: 'sqlite',
    semanticStore: 'lancedb',
    embeddingProvider: 'deterministic'
  };

  console.log('🧙 RagCode Configuration Wizard\n');

  // Graph store
  console.log('📊 Graph Store (structural code graph)');
  const graphStore = await question(rl, '  Choose: [1] SQLite (persistent), [2] Memory (testing only) [1]: ');
  config.graphStore = graphStore === '2' ? 'memory' : 'sqlite';

  if (config.graphStore === 'sqlite') {
    const sqlitePath = await question(rl, '  SQLite database path [.ragcode/graph.sqlite]: ');
    config.sqlitePath = sqlitePath || '.ragcode/graph.sqlite';
  }

  // Semantic store
  console.log('\n🔍 Semantic Store (vector embeddings)');
  const semanticStore = await question(rl, '  Choose: [1] LanceDB (persistent), [2] Memory (testing only) [1]: ');
  config.semanticStore = semanticStore === '2' ? 'memory' : 'lancedb';

  if (config.semanticStore === 'lancedb') {
    const lancedbUri = await question(rl, '  LanceDB directory [.ragcode/lancedb]: ');
    config.lancedbUri = lancedbUri || '.ragcode/lancedb';
  }

  // Embedding provider
  console.log('\n🤖 Embedding Provider');
  const embeddingProvider = await question(rl, '  Choose: [1] Deterministic (offline), [2] OpenAI-compatible (requires API key) [1]: ');
  config.embeddingProvider = embeddingProvider === '2' ? 'openai-compatible' : 'deterministic';

  if (config.embeddingProvider === 'openai-compatible') {
    console.log('  💡 Set OPENAI_API_KEY environment variable or provide it now.');
    const apiKey = await question(rl, '  OpenAI API Key (leave empty to use env var): ');
    if (apiKey) {
      config.openaiApiKey = apiKey;
    }
  }

  rl.close();
  return config;
}

function toRuntimeConfigFile(config: ConfigOptions): RuntimeConfigFile {
  const configObj: RuntimeConfigFile = {
    graphStore: config.graphStore,
    semanticStore: config.semanticStore,
    embeddingProvider: config.embeddingProvider
  };

  if (config.sqlitePath) configObj.sqlitePath = config.sqlitePath;
  if (config.lancedbUri) configObj.lancedbUri = config.lancedbUri;
  if (config.openaiApiKey) configObj.embeddingApiKey = config.openaiApiKey;

  return configObj;
}

function writeConfigFile(targetDir: string, config: ConfigOptions): string {
  const ragcodeDir = path.join(targetDir, '.ragcode');
  if (!fs.existsSync(ragcodeDir)) {
    fs.mkdirSync(ragcodeDir, { recursive: true });
    console.log(`\n📁 Created directory: ${ragcodeDir}`);
  }

  const configPath = writeRuntimeConfigFile(targetDir, toRuntimeConfigFile(config));
  console.log(`✅ Configuration saved to: ${configPath}\n`);
  return configPath;
}

function writeEnvExample(targetDir: string, config: ConfigOptions): void {
  const envPath = path.join(targetDir, '.ragcode', '.env.example');

  let envContent = '# RagCode Environment Variables\n\n';
  envContent += `RAGCODE_GRAPH_STORE=${config.graphStore}\n`;

  if (config.sqlitePath) {
    envContent += `RAGCODE_SQLITE_PATH=${config.sqlitePath}\n`;
  }

  envContent += `\nRAGCODE_SEMANTIC_STORE=${config.semanticStore}\n`;

  if (config.lancedbUri) {
    envContent += `RAGCODE_LANCEDB_URI=${config.lancedbUri}\n`;
  }

  envContent += `\nRAGCODE_EMBEDDING_PROVIDER=${config.embeddingProvider}\n`;

  if (config.embeddingProvider === 'openai-compatible') {
    envContent += 'OPENAI_API_KEY=your-api-key-here\n';
  }

  fs.writeFileSync(envPath, envContent, 'utf-8');
  console.log(`📄 Environment template saved to: ${envPath}`);
}

function printNextSteps(config: ConfigOptions): void {
  console.log('\n🎉 Setup complete!\n');
  console.log('Next steps:');
  console.log('  1. Index your codebase:');
  console.log('     ragcode index .\n');
  console.log('  2. Search code:');
  console.log('     ragcode search . "your query"\n');

  if (config.embeddingProvider === 'openai-compatible' && !config.openaiApiKey) {
    console.log('  ⚠️  Remember to set OPENAI_API_KEY:');
    console.log('     export OPENAI_API_KEY=your-key\n');
  }

  console.log('  3. Start the MCP server:');
  console.log('     ragcode setup-mcp\n');
  console.log('  4. Upgrade embedding provider if needed:');
  console.log('     ragcode configure\n');
  console.log('  5. Launch the web dashboard for observation:');
  console.log('     ragcode dashboard\n');
}

export async function runInitConfig(options: InitConfigOptions = {}): Promise<InitConfigResult> {
  const targetDir = path.resolve(options.targetDir || process.cwd());

  console.log(`📍 Target directory: ${targetDir}\n`);

  const config = options.defaults ? { ...DEFAULT_INIT_CONFIG } : await runWizard();
  const configPath = writeConfigFile(targetDir, config);
  writeEnvExample(targetDir, config);
  printNextSteps(config);

  return { targetDir, configPath, config: toRuntimeConfigFile(config) };
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
RagCode Configuration Wizard

Usage:
  ragcode init [directory] [--defaults]

Examples:
  ragcode init              # Initialize in current directory
  ragcode init /path/to/project
  ragcode init --defaults   # Write offline-first defaults without prompts
    `);
    process.exit(0);
  }

  const positional = args.filter((arg) => !arg.startsWith('-'));
  await runInitConfig({
    targetDir: positional[0],
    defaults: args.includes('--defaults') || args.includes('--yes') || args.includes('-y')
  });
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error('❌ Setup failed:', err);
    process.exit(1);
  });
}
