#!/usr/bin/env node
/**
 * Interactive configuration wizard for RagCode
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

interface ConfigOptions {
  graphStore: 'sqlite' | 'memory';
  sqlitePath?: string;
  semanticStore: 'lancedb' | 'memory';
  lancedbUri?: string;
  embeddingProvider: 'openai' | 'deterministic';
  openaiApiKey?: string;
}

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
    embeddingProvider: 'openai'
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
  const embeddingProvider = await question(rl, '  Choose: [1] OpenAI (requires API key), [2] Deterministic (offline, less accurate) [1]: ');
  config.embeddingProvider = embeddingProvider === '2' ? 'deterministic' : 'openai';

  if (config.embeddingProvider === 'openai') {
    console.log('  💡 Set OPENAI_API_KEY environment variable or provide it now.');
    const apiKey = await question(rl, '  OpenAI API Key (leave empty to use env var): ');
    if (apiKey) {
      config.openaiApiKey = apiKey;
    }
  }

  rl.close();
  return config;
}

function writeConfigFile(targetDir: string, config: ConfigOptions): void {
  const ragcodeDir = path.join(targetDir, '.ragcode');
  const configPath = path.join(ragcodeDir, 'config.json');

  // Create .ragcode directory
  if (!fs.existsSync(ragcodeDir)) {
    fs.mkdirSync(ragcodeDir, { recursive: true });
    console.log(`\n📁 Created directory: ${ragcodeDir}`);
  }

  // Prepare config object
  const configObj: Record<string, any> = {
    graphStore: config.graphStore,
    semanticStore: config.semanticStore,
    embeddingProvider: config.embeddingProvider
  };

  if (config.sqlitePath) configObj.sqlitePath = config.sqlitePath;
  if (config.lancedbUri) configObj.lancedbUri = config.lancedbUri;
  if (config.openaiApiKey) configObj.openaiApiKey = config.openaiApiKey;

  // Write config
  fs.writeFileSync(configPath, JSON.stringify(configObj, null, 2), 'utf-8');
  console.log(`✅ Configuration saved to: ${configPath}\n`);
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

  if (config.embeddingProvider === 'openai') {
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

  if (config.embeddingProvider === 'openai' && !config.openaiApiKey) {
    console.log('  ⚠️  Remember to set OPENAI_API_KEY:');
    console.log('     export OPENAI_API_KEY=your-key\n');
  }

  console.log('  3. Start the MCP server:');
  console.log('     ragcode mcp\n');
  console.log('  4. Launch the web dashboard:');
  console.log('     ragcode dashboard\n');
}

async function main() {
  const args = process.argv.slice(2);
  const targetDir = args[0] || process.cwd();

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
RagCode Configuration Wizard

Usage:
  ragcode init [directory]

Examples:
  ragcode init              # Initialize in current directory
  ragcode init /path/to/project
    `);
    process.exit(0);
  }

  console.log(`📍 Target directory: ${targetDir}\n`);

  const config = await runWizard();
  writeConfigFile(targetDir, config);
  writeEnvExample(targetDir, config);
  printNextSteps(config);
}

main().catch(err => {
  console.error('❌ Setup failed:', err);
  process.exit(1);
});
