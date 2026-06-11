import readline from "node:readline/promises";
import {
  loadRuntimeConfig,
  readRuntimeConfigFile,
  redactRuntimeConfig,
  writeRuntimeConfigFile,
  type RedactedRuntimeConfig,
  type RuntimeConfigFile
} from "../config/runtime-config.js";
import { testEmbeddingForConfig, type EmbeddingTestResult } from "../diagnostics/embedding-test.js";

export interface ConfigureUpdates {
  graphStore?: string;
  sqlitePath?: string;
  semanticStore?: string;
  lancedbUri?: string;
  embeddingProvider?: string;
  embeddingBaseUrl?: string;
  embeddingModel?: string;
  embeddingApiKey?: string;
  embeddingDimensions?: number;
  embeddingRequestDimensions?: boolean;
}

export interface ConfigureResult {
  configPath: string;
  config: RedactedRuntimeConfig;
  embeddingTest?: EmbeddingTestResult;
}

// Non-interactive core of `ragcode configure`: merge updates into .ragcode/config.json,
// then re-resolve the effective config through the shared loader. Returns redacted output
// so callers never see the API key back. Kept UI-free so tests and a future Ink app can
// drive it directly.
export async function applyConfigureUpdates(options: {
  repoRoot: string;
  updates: ConfigureUpdates;
  env?: NodeJS.ProcessEnv;
  testEmbedding?: boolean;
}): Promise<ConfigureResult> {
  const env = options.env ?? process.env;
  const existingPath = loadRuntimeConfig({ cwd: options.repoRoot, env, overrides: { repoRoot: options.repoRoot } }).configPath;
  const merged = mergeConfigFile(readRuntimeConfigFile(existingPath), options.updates);
  const configPath = writeRuntimeConfigFile(options.repoRoot, merged);
  const effective = loadRuntimeConfig({ cwd: options.repoRoot, env, overrides: { repoRoot: options.repoRoot } });
  const embeddingTest = options.testEmbedding ? await testEmbeddingForConfig(effective) : undefined;
  return { configPath, config: redactRuntimeConfig(effective), embeddingTest };
}

function mergeConfigFile(existing: RuntimeConfigFile, updates: ConfigureUpdates): RuntimeConfigFile {
  const merged: RuntimeConfigFile = { ...existing };
  if (updates.graphStore !== undefined) merged.graphStore = updates.graphStore;
  if (updates.sqlitePath !== undefined) merged.sqlitePath = updates.sqlitePath;
  if (updates.semanticStore !== undefined) merged.semanticStore = updates.semanticStore;
  if (updates.lancedbUri !== undefined) merged.lancedbUri = updates.lancedbUri;
  if (updates.embeddingProvider !== undefined) merged.embeddingProvider = updates.embeddingProvider === "openai" ? "openai-compatible" : updates.embeddingProvider;
  if (updates.embeddingBaseUrl !== undefined) merged.embeddingBaseUrl = updates.embeddingBaseUrl;
  if (updates.embeddingModel !== undefined) merged.embeddingModel = updates.embeddingModel;
  if (updates.embeddingApiKey !== undefined) merged.embeddingApiKey = updates.embeddingApiKey;
  if (updates.embeddingDimensions !== undefined) merged.embeddingDimensions = updates.embeddingDimensions;
  if (updates.embeddingRequestDimensions !== undefined) merged.embeddingRequestDimensions = updates.embeddingRequestDimensions;
  return merged;
}

export interface ConfigureCommandOptions extends ConfigureUpdates {
  show?: boolean;
  test?: boolean;
  yes?: boolean;
}

export async function runConfigureCommand(repoRootArg: string | undefined, options: ConfigureCommandOptions): Promise<void> {
  const repoRoot = repoRootArg ?? process.cwd();
  const hasEditFlags = configureUpdateKeys.some((key) => options[key] !== undefined);

  if (options.show || (!hasEditFlags && !options.test && !process.stdin.isTTY)) {
    const effective = loadRuntimeConfig({ cwd: repoRoot, overrides: { repoRoot } });
    console.log(JSON.stringify(redactRuntimeConfig(effective), null, 2));
    return;
  }

  if (options.test && !hasEditFlags) {
    const effective = loadRuntimeConfig({ cwd: repoRoot, overrides: { repoRoot } });
    printEmbeddingTest(await testEmbeddingForConfig(effective));
    return;
  }

  const updates = hasEditFlags ? pickUpdates(options) : await interactiveUpdates(repoRoot);
  if (!updates) {
    console.log("Configuration unchanged.");
    return;
  }
  const result = await applyConfigureUpdates({
    repoRoot,
    updates,
    testEmbedding: options.test ?? true
  });
  console.log(`✅ Configuration saved to: ${result.configPath}`);
  console.log(JSON.stringify(result.config, null, 2));
  if (result.embeddingTest) printEmbeddingTest(result.embeddingTest);
}

const configureUpdateKeys = [
  "graphStore",
  "sqlitePath",
  "semanticStore",
  "lancedbUri",
  "embeddingProvider",
  "embeddingBaseUrl",
  "embeddingModel",
  "embeddingApiKey",
  "embeddingDimensions",
  "embeddingRequestDimensions"
] as const;

function pickUpdates(options: ConfigureCommandOptions): ConfigureUpdates {
  const updates: ConfigureUpdates = {};
  for (const key of configureUpdateKeys) {
    if (options[key] !== undefined) (updates as Record<string, unknown>)[key] = options[key];
  }
  return updates;
}

async function interactiveUpdates(repoRoot: string): Promise<ConfigureUpdates | undefined> {
  const current = redactRuntimeConfig(loadRuntimeConfig({ cwd: repoRoot, overrides: { repoRoot } }));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("🛠  RagCode Configure (Enter keeps the current value)\n");
    const updates: ConfigureUpdates = {};

    const graphStore = await ask(rl, `Graph store (memory/sqlite) [${current.graphStore}]: `);
    if (graphStore) updates.graphStore = graphStore;
    const semanticStore = await ask(rl, `Semantic store (memory/lancedb) [${current.semanticStore}]: `);
    if (semanticStore) updates.semanticStore = semanticStore;
    const provider = await ask(rl, `Embedding provider (deterministic/openai-compatible) [${current.embeddingProvider}]: `);
    if (provider) updates.embeddingProvider = provider;

    const effectiveProvider = updates.embeddingProvider ?? current.embeddingProvider;
    if (effectiveProvider === "openai-compatible") {
      const baseUrl = await ask(rl, `Embedding base URL [${current.embeddingBaseUrl ?? "https://api.openai.com/v1"}]: `);
      if (baseUrl) updates.embeddingBaseUrl = baseUrl;
      const model = await ask(rl, `Embedding model [${current.embeddingModel ?? "text-embedding-3-small"}]: `);
      if (model) updates.embeddingModel = model;
      const apiKey = await ask(rl, `Embedding API key [${current.embeddingApiKey === "set" ? "keep existing" : "unset"}]: `);
      if (apiKey) updates.embeddingApiKey = apiKey;
      const dimensions = await ask(rl, `Embedding dimensions [${current.embeddingDimensions ?? "provider default"}]: `);
      if (dimensions) updates.embeddingDimensions = Number(dimensions);
      const requestDimensions = await ask(rl, `Request dimensions from provider (true/false) [${current.embeddingRequestDimensions}]: `);
      if (requestDimensions) updates.embeddingRequestDimensions = requestDimensions === "true";
    }

    if (Object.keys(updates).length === 0) return undefined;
    const confirm = await ask(rl, "Save these changes? (Y/n): ");
    if (confirm.toLowerCase() === "n") return undefined;
    return updates;
  } finally {
    rl.close();
  }
}

async function ask(rl: readline.Interface, prompt: string): Promise<string> {
  return (await rl.question(prompt)).trim();
}

function printEmbeddingTest(result: EmbeddingTestResult): void {
  if (result.ok) {
    console.log(`🧪 Embedding test OK: provider=${result.provider}${result.model ? ` model=${result.model}` : ""} dimensions=${result.dimensions} latency=${result.latencyMs}ms`);
    return;
  }
  console.log(`🧪 Embedding test FAILED (${result.failure?.kind}): ${result.failure?.message}`);
  if (result.provider === "openai-compatible") {
    console.log("   Fix the provider settings with `ragcode configure`, or fall back to the offline deterministic provider.");
  }
}
