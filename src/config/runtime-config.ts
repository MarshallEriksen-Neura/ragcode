import fs from "node:fs";
import path from "node:path";
import type { GraphStore } from "../core/contracts.js";
import type { EmbeddingProvider, SemanticStore } from "../core/contracts.js";
import { createGraphRuntimeFromConfig, type GraphRuntimeConfig } from "./graph-runtime.js";
import { createSemanticRuntimeFromConfig, type EmbeddingProviderKind, type SemanticRuntimeConfig } from "./semantic-runtime.js";

export interface RuntimeConfigFile {
  graphStore?: string;
  sqlitePath?: string;
  semanticStore?: string;
  lancedbUri?: string;
  lanceDbUri?: string;
  lancedbTable?: string;
  lanceDbTableName?: string;
  embeddingProvider?: string;
  embeddingBaseUrl?: string;
  embeddingApiKey?: string;
  embeddingModel?: string;
  embeddingDimensions?: number | string;
  embeddingRequestDimensions?: boolean | string;
  embeddingBatchSize?: number | string;
  embeddingConcurrency?: number | string;
  semanticMaxChunks?: number | string;
}

export interface RuntimeConfigOverrides extends RuntimeConfigFile {
  repoRoot?: string;
}

export interface RuntimeConfig {
  repoRoot: string;
  configPath: string;
  graph: GraphRuntimeConfig;
  semantic: SemanticRuntimeConfig;
  embeddingApiKey?: string;
  sources: Record<string, "override" | "env" | "config" | "default">;
}

export interface RuntimeComponents {
  graphStore: GraphStore;
  semanticStore: SemanticStore;
  embeddingProvider: EmbeddingProvider;
  config: RuntimeConfig;
}

export interface RedactedRuntimeConfig {
  repoRoot: string;
  configPath: string;
  graphStore: RuntimeConfig["graph"]["graphStore"];
  sqlitePath: string;
  semanticStore: RuntimeConfig["semantic"]["semanticStore"];
  lancedbUri?: string;
  lanceDbTableName: string;
  embeddingProvider: RuntimeConfig["semantic"]["embeddingProvider"];
  embeddingBaseUrl?: string;
  embeddingModel?: string;
  embeddingDimensions?: number;
  embeddingRequestDimensions: boolean;
  embeddingBatchSize: number;
  embeddingConcurrency: number;
  semanticMaxChunks?: number;
  embeddingApiKey: "set" | "unset" | "redacted";
  sources: RuntimeConfig["sources"];
}

export const DEFAULT_RUNTIME_CONFIG = {
  graphStore: "sqlite",
  sqlitePath: path.join(".ragcode", "graph.sqlite"),
  semanticStore: "lancedb",
  lancedbUri: path.join(".ragcode", "lancedb"),
  lanceDbTableName: "code_chunks",
  embeddingProvider: "deterministic",
  embeddingBaseUrl: "https://api.openai.com/v1",
  embeddingBatchSize: 64,
  embeddingConcurrency: 1,
  embeddingRequestDimensions: false
} as const;

const CONFIG_FILE_NAME = path.join(".ragcode", "config.json");

export function loadRuntimeConfig(options: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  overrides?: RuntimeConfigOverrides;
} = {}): RuntimeConfig {
  const env = options.env ?? process.env;
  const repoRoot = path.resolve(options.overrides?.repoRoot ?? env.RAGCODE_REPO_ROOT ?? options.cwd ?? process.cwd());
  const configPath = path.join(repoRoot, CONFIG_FILE_NAME);
  const fileConfig = readRuntimeConfigFile(configPath);
  const sources: RuntimeConfig["sources"] = {};

  const graphStore = selectString("graphStore", options.overrides?.graphStore, env.RAGCODE_GRAPH_STORE, fileConfig.graphStore, DEFAULT_RUNTIME_CONFIG.graphStore, sources);
  const sqlitePath = resolveRepoPath(repoRoot, selectString("sqlitePath", options.overrides?.sqlitePath, env.RAGCODE_SQLITE_PATH, fileConfig.sqlitePath, DEFAULT_RUNTIME_CONFIG.sqlitePath, sources));
  const semanticStore = selectString("semanticStore", options.overrides?.semanticStore, env.RAGCODE_SEMANTIC_STORE, fileConfig.semanticStore, DEFAULT_RUNTIME_CONFIG.semanticStore, sources);
  const lanceDbUri = resolveRepoPath(repoRoot, selectString("lancedbUri", options.overrides?.lancedbUri ?? options.overrides?.lanceDbUri, env.RAGCODE_LANCEDB_URI, fileConfig.lancedbUri ?? fileConfig.lanceDbUri, DEFAULT_RUNTIME_CONFIG.lancedbUri, sources));
  const lanceDbTableName = selectString("lanceDbTableName", options.overrides?.lanceDbTableName ?? options.overrides?.lancedbTable, env.RAGCODE_LANCEDB_TABLE, fileConfig.lanceDbTableName ?? fileConfig.lancedbTable, DEFAULT_RUNTIME_CONFIG.lanceDbTableName, sources);
  const embeddingProvider = normalizeEmbeddingProvider(selectString("embeddingProvider", options.overrides?.embeddingProvider, env.RAGCODE_EMBEDDING_PROVIDER, fileConfig.embeddingProvider, DEFAULT_RUNTIME_CONFIG.embeddingProvider, sources));
  const embeddingBaseUrl = selectString("embeddingBaseUrl", options.overrides?.embeddingBaseUrl, env.RAGCODE_EMBEDDING_BASE_URL, fileConfig.embeddingBaseUrl, DEFAULT_RUNTIME_CONFIG.embeddingBaseUrl, sources);
  const embeddingApiKey = selectOptionalString("embeddingApiKey", options.overrides?.embeddingApiKey, env.RAGCODE_EMBEDDING_API_KEY ?? env.OPENAI_API_KEY, fileConfig.embeddingApiKey, sources);
  const embeddingModel = selectOptionalString("embeddingModel", options.overrides?.embeddingModel, env.RAGCODE_EMBEDDING_MODEL, fileConfig.embeddingModel, sources)
    ?? (embeddingProvider === "openai-compatible" ? "text-embedding-3-small" : undefined);
  const embeddingDimensions = selectOptionalPositiveInteger("embeddingDimensions", options.overrides?.embeddingDimensions, env.RAGCODE_EMBEDDING_DIMENSIONS, fileConfig.embeddingDimensions, sources);
  const embeddingRequestDimensions = selectBoolean("embeddingRequestDimensions", options.overrides?.embeddingRequestDimensions, env.RAGCODE_EMBEDDING_REQUEST_DIMENSIONS, fileConfig.embeddingRequestDimensions, DEFAULT_RUNTIME_CONFIG.embeddingRequestDimensions, sources);
  const embeddingBatchSize = selectPositiveInteger("embeddingBatchSize", options.overrides?.embeddingBatchSize, env.RAGCODE_EMBEDDING_BATCH_SIZE, fileConfig.embeddingBatchSize, DEFAULT_RUNTIME_CONFIG.embeddingBatchSize, sources);
  const embeddingConcurrency = selectPositiveInteger("embeddingConcurrency", options.overrides?.embeddingConcurrency, env.RAGCODE_EMBEDDING_CONCURRENCY, fileConfig.embeddingConcurrency, DEFAULT_RUNTIME_CONFIG.embeddingConcurrency, sources);
  const semanticMaxChunks = selectSemanticMaxChunks("semanticMaxChunks", options.overrides?.semanticMaxChunks, env.RAGCODE_SEMANTIC_MAX_CHUNKS, fileConfig.semanticMaxChunks, embeddingProvider, sources);

  return {
    repoRoot,
    configPath,
    graph: {
      graphStore: enumValue(graphStore, ["memory", "sqlite"], "graphStore"),
      sqlitePath
    },
    semantic: {
      semanticStore: enumValue(semanticStore, ["memory", "lancedb"], "semanticStore"),
      embeddingProvider,
      lanceDbUri,
      lanceDbTableName,
      embeddingBaseUrl,
      embeddingModel,
      embeddingDimensions,
      embeddingRequestDimensions,
      embeddingBatchSize,
      embeddingConcurrency,
      semanticMaxChunks
    },
    embeddingApiKey,
    sources
  };
}

export function createRuntimeComponents(config: RuntimeConfig): RuntimeComponents {
  const graphRuntime = createGraphRuntimeFromConfig(config.graph);
  const semanticRuntime = createSemanticRuntimeFromConfig(config.semantic, {
    RAGCODE_EMBEDDING_API_KEY: config.embeddingApiKey ?? ""
  });
  return {
    graphStore: graphRuntime.graphStore,
    semanticStore: semanticRuntime.semanticStore,
    embeddingProvider: semanticRuntime.embeddingProvider,
    config
  };
}

export function createRuntimeComponentsForRepo(options: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  overrides?: RuntimeConfigOverrides;
} = {}): RuntimeComponents {
  return createRuntimeComponents(loadRuntimeConfig(options));
}

export function writeRuntimeConfigFile(repoRoot: string, config: RuntimeConfigFile): string {
  const configPath = path.join(path.resolve(repoRoot), CONFIG_FILE_NAME);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return configPath;
}

export function runtimeConfigToEnv(config: RuntimeConfig, options: { includeSecrets?: boolean } = {}): Record<string, string> {
  const env: Record<string, string> = {
    RAGCODE_GRAPH_STORE: config.graph.graphStore,
    RAGCODE_SQLITE_PATH: config.graph.sqlitePath,
    RAGCODE_SEMANTIC_STORE: config.semantic.semanticStore,
    RAGCODE_LANCEDB_URI: config.semantic.lanceDbUri ?? path.join(config.repoRoot, DEFAULT_RUNTIME_CONFIG.lancedbUri),
    RAGCODE_LANCEDB_TABLE: config.semantic.lanceDbTableName,
    RAGCODE_EMBEDDING_PROVIDER: config.semantic.embeddingProvider,
    RAGCODE_EMBEDDING_BASE_URL: config.semantic.embeddingBaseUrl ?? DEFAULT_RUNTIME_CONFIG.embeddingBaseUrl,
    RAGCODE_EMBEDDING_BATCH_SIZE: String(config.semantic.embeddingBatchSize),
    RAGCODE_EMBEDDING_CONCURRENCY: String(config.semantic.embeddingConcurrency)
  };
  if (config.semantic.embeddingModel) env.RAGCODE_EMBEDDING_MODEL = config.semantic.embeddingModel;
  if (config.semantic.embeddingDimensions) env.RAGCODE_EMBEDDING_DIMENSIONS = String(config.semantic.embeddingDimensions);
  if (config.semantic.embeddingRequestDimensions) env.RAGCODE_EMBEDDING_REQUEST_DIMENSIONS = "true";
  if (config.semantic.semanticMaxChunks !== undefined) env.RAGCODE_SEMANTIC_MAX_CHUNKS = String(config.semantic.semanticMaxChunks);
  if (config.embeddingApiKey) env.RAGCODE_EMBEDDING_API_KEY = options.includeSecrets ? config.embeddingApiKey : "<redacted>";
  return env;
}

export function redactRuntimeConfig(config: RuntimeConfig): RedactedRuntimeConfig {
  return {
    repoRoot: config.repoRoot,
    configPath: config.configPath,
    graphStore: config.graph.graphStore,
    sqlitePath: config.graph.sqlitePath,
    semanticStore: config.semantic.semanticStore,
    lancedbUri: config.semantic.lanceDbUri,
    lanceDbTableName: config.semantic.lanceDbTableName,
    embeddingProvider: config.semantic.embeddingProvider,
    embeddingBaseUrl: config.semantic.embeddingBaseUrl,
    embeddingModel: config.semantic.embeddingModel,
    embeddingDimensions: config.semantic.embeddingDimensions,
    embeddingRequestDimensions: config.semantic.embeddingRequestDimensions,
    embeddingBatchSize: config.semantic.embeddingBatchSize,
    embeddingConcurrency: config.semantic.embeddingConcurrency,
    semanticMaxChunks: config.semantic.semanticMaxChunks,
    embeddingApiKey: config.embeddingApiKey ? "set" : "unset",
    sources: config.sources
  };
}

export function readRuntimeConfigFile(configPath: string): RuntimeConfigFile {
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8")) as RuntimeConfigFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

function resolveRepoPath(repoRoot: string, value: string): string {
  return path.isAbsolute(value) ? value : path.join(repoRoot, value);
}

function selectString(field: string, overrideValue: unknown, envValue: unknown, configValue: unknown, defaultValue: string, sources: RuntimeConfig["sources"]): string {
  const selected = selectValue(field, overrideValue, envValue, configValue, defaultValue, sources);
  if (typeof selected !== "string" || selected.trim() === "") throw new Error(`Invalid runtime config field ${field}: expected a non-empty string.`);
  return selected;
}

function selectOptionalString(field: string, overrideValue: unknown, envValue: unknown, configValue: unknown, sources: RuntimeConfig["sources"]): string | undefined {
  const selected = selectValue(field, overrideValue, envValue, configValue, undefined, sources);
  if (selected === undefined || selected === null || selected === "") return undefined;
  if (typeof selected !== "string") throw new Error(`Invalid runtime config field ${field}: expected a string.`);
  return selected;
}

function selectPositiveInteger(field: string, overrideValue: unknown, envValue: unknown, configValue: unknown, defaultValue: number, sources: RuntimeConfig["sources"]): number {
  return positiveInteger(field, selectValue(field, overrideValue, envValue, configValue, defaultValue, sources));
}

function selectOptionalPositiveInteger(field: string, overrideValue: unknown, envValue: unknown, configValue: unknown, sources: RuntimeConfig["sources"]): number | undefined {
  const selected = selectValue(field, overrideValue, envValue, configValue, undefined, sources);
  if (selected === undefined || selected === null || selected === "") return undefined;
  return positiveInteger(field, selected);
}

function selectBoolean(field: string, overrideValue: unknown, envValue: unknown, configValue: unknown, defaultValue: boolean, sources: RuntimeConfig["sources"]): boolean {
  const selected = selectValue(field, overrideValue, envValue, configValue, defaultValue, sources);
  if (typeof selected === "boolean") return selected;
  if (selected === "true") return true;
  if (selected === "false") return false;
  throw new Error(`Invalid runtime config field ${field}: expected boolean.`);
}

function selectSemanticMaxChunks(field: string, overrideValue: unknown, envValue: unknown, configValue: unknown, provider: EmbeddingProviderKind, sources: RuntimeConfig["sources"]): number | undefined {
  const selected = selectValue(field, overrideValue, envValue, configValue, undefined, sources);
  if (selected === undefined || selected === null || selected === "") return provider === "openai-compatible" ? 512 : undefined;
  if (selected === "0" || (typeof selected === "string" && selected.toLowerCase() === "all")) return undefined;
  return positiveInteger(field, selected);
}

function selectValue(field: string, overrideValue: unknown, envValue: unknown, configValue: unknown, defaultValue: unknown, sources: RuntimeConfig["sources"]): unknown {
  if (overrideValue !== undefined) {
    sources[field] = "override";
    return overrideValue;
  }
  if (envValue !== undefined) {
    sources[field] = "env";
    return envValue;
  }
  if (configValue !== undefined) {
    sources[field] = "config";
    return configValue;
  }
  sources[field] = "default";
  return defaultValue;
}

function normalizeEmbeddingProvider(value: string): EmbeddingProviderKind {
  if (value === "openai") return "openai-compatible";
  return enumValue(value, ["deterministic", "openai-compatible"], "embeddingProvider");
}

function enumValue<T extends string>(value: string, allowed: readonly T[], field: string): T {
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`Invalid runtime config field ${field}: expected one of ${allowed.join(", ")}, got ${value}.`);
}

function positiveInteger(field: string, value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid runtime config field ${field}: expected positive integer, got ${String(value)}.`);
  }
  return parsed;
}
