import path from "node:path";
import type { EmbeddingProvider, SemanticStore } from "../core/contracts.js";
import { DeterministicEmbeddingProvider } from "../semantic/deterministic-embedding.js";
import { InMemorySemanticStore } from "../semantic/in-memory-semantic-store.js";
import { LanceSemanticStore } from "../semantic/lance-semantic-store.js";
import { OpenAICompatibleEmbeddingProvider } from "../semantic/openai-compatible-embedding.js";

export type SemanticStoreKind = "memory" | "lancedb";
export type EmbeddingProviderKind = "deterministic" | "openai-compatible";

export interface SemanticRuntimeConfig {
  semanticStore: SemanticStoreKind;
  embeddingProvider: EmbeddingProviderKind;
  lanceDbUri?: string;
  lanceDbTableName: string;
  embeddingBaseUrl?: string;
  embeddingModel?: string;
  embeddingDimensions?: number;
  embeddingRequestDimensions: boolean;
  embeddingBatchSize: number;
  embeddingConcurrency: number;
  semanticMaxChunks?: number;
}

export interface SemanticRuntimeComponents {
  semanticStore: SemanticStore;
  embeddingProvider: EmbeddingProvider;
  config: SemanticRuntimeConfig;
}

export function createSemanticRuntimeFromEnv(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): SemanticRuntimeComponents {
  const config = readSemanticRuntimeConfig(env, cwd);
  return createSemanticRuntimeFromConfig(config, env);
}

export function createSemanticRuntimeFromConfig(config: SemanticRuntimeConfig, env: Partial<Pick<NodeJS.ProcessEnv, "RAGCODE_EMBEDDING_API_KEY">> = process.env): SemanticRuntimeComponents {
  const embeddingProvider = createEmbeddingProvider(config, env);
  const semanticStore = createSemanticStore(config, embeddingProvider);
  return { semanticStore, embeddingProvider, config };
}

export function readSemanticRuntimeConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): SemanticRuntimeConfig {
  const semanticStore = enumValue(env.RAGCODE_SEMANTIC_STORE, ["memory", "lancedb"], "memory");
  const embeddingProvider = enumValue(env.RAGCODE_EMBEDDING_PROVIDER, ["deterministic", "openai-compatible"], "deterministic");
  const embeddingDimensions = optionalPositiveInteger(env.RAGCODE_EMBEDDING_DIMENSIONS);
  return {
    semanticStore,
    embeddingProvider,
    lanceDbUri: env.RAGCODE_LANCEDB_URI ?? path.join(cwd, ".ragcode", "lancedb"),
    lanceDbTableName: env.RAGCODE_LANCEDB_TABLE ?? "code_chunks",
    embeddingBaseUrl: env.RAGCODE_EMBEDDING_BASE_URL ?? "https://api.openai.com/v1",
    embeddingModel: env.RAGCODE_EMBEDDING_MODEL ?? (embeddingProvider === "openai-compatible" ? "text-embedding-3-small" : undefined),
    embeddingDimensions,
    embeddingRequestDimensions: env.RAGCODE_EMBEDDING_REQUEST_DIMENSIONS === "true",
    embeddingBatchSize: optionalPositiveInteger(env.RAGCODE_EMBEDDING_BATCH_SIZE) ?? 64,
    embeddingConcurrency: optionalPositiveInteger(env.RAGCODE_EMBEDDING_CONCURRENCY) ?? 1,
    semanticMaxChunks: semanticMaxChunks(env.RAGCODE_SEMANTIC_MAX_CHUNKS, embeddingProvider)
  };
}

function createEmbeddingProvider(config: SemanticRuntimeConfig, env: Partial<Pick<NodeJS.ProcessEnv, "RAGCODE_EMBEDDING_API_KEY">>): EmbeddingProvider {
  if (config.embeddingProvider === "deterministic") {
    return new DeterministicEmbeddingProvider(config.embeddingDimensions ?? 64);
  }
  return new OpenAICompatibleEmbeddingProvider({
    apiKey: env.RAGCODE_EMBEDDING_API_KEY ?? "",
    model: config.embeddingModel ?? "text-embedding-3-small",
    baseUrl: config.embeddingBaseUrl,
    dimensions: config.embeddingDimensions,
    requestDimensions: config.embeddingRequestDimensions
  });
}

function createSemanticStore(config: SemanticRuntimeConfig, provider: EmbeddingProvider): SemanticStore {
  if (config.semanticStore === "memory") return new InMemorySemanticStore();
  return new LanceSemanticStore(config.lanceDbUri ?? ".ragcode/lancedb", {
    tableName: config.lanceDbTableName,
    vectorDimensions: provider.dimensions,
    embeddingProfile: {
      provider: config.embeddingProvider,
      model: config.embeddingModel,
      baseUrl: config.embeddingBaseUrl,
      requestDimensions: config.embeddingRequestDimensions
    },
    embeddingBatchSize: config.embeddingBatchSize,
    embeddingConcurrency: config.embeddingConcurrency,
    maxChunks: config.semanticMaxChunks,
    onProgress: (progress) => {
      if (process.env.RAGCODE_EMBEDDING_PROGRESS === "false") return;
      const percent = Math.round((progress.completedChunks / progress.totalChunks) * 100);
      const elapsedSeconds = Math.max(1, Math.round(progress.elapsedMs / 1000));
      console.error(`[ragcode] embedded ${progress.completedChunks}/${progress.totalChunks} chunks (${percent}%) batch ${progress.batchIndex}/${progress.batchCount} elapsed ${elapsedSeconds}s`);
    }
  });
}

function semanticMaxChunks(value: string | undefined, provider: EmbeddingProviderKind): number | undefined {
  if (value === "0" || value?.toLowerCase() === "all") return undefined;
  return optionalPositiveInteger(value) ?? (provider === "openai-compatible" ? 512 : undefined);
}

function enumValue<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
  if (!value) return fallback;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`Invalid semantic runtime value "${value}". Expected one of: ${allowed.join(", ")}.`);
}

function optionalPositiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid positive integer: ${value}`);
  }
  return parsed;
}
