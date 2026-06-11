import { performance } from "node:perf_hooks";
import { loadRuntimeConfig, type RuntimeConfig, type RuntimeConfigOverrides } from "../config/runtime-config.js";
import { DeterministicEmbeddingProvider } from "../semantic/deterministic-embedding.js";
import { OpenAICompatibleEmbeddingProvider } from "../semantic/openai-compatible-embedding.js";

export type EmbeddingFailureKind =
  | "missing_key"
  | "auth_failure"
  | "model_not_found"
  | "network_failure"
  | "dimensions_mismatch"
  | "unsupported_dimensions_request"
  | "unknown";

export interface EmbeddingTestResult {
  ok: boolean;
  provider: RuntimeConfig["semantic"]["embeddingProvider"];
  model?: string;
  baseUrl?: string;
  requestedDimensions?: number;
  dimensions?: number;
  latencyMs?: number;
  failure?: {
    kind: EmbeddingFailureKind;
    message: string;
  };
}

export interface EmbeddingTestOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  overrides?: RuntimeConfigOverrides;
  fetchImpl?: typeof fetch;
  sampleText?: string;
}

export async function runEmbeddingTest(options: EmbeddingTestOptions = {}): Promise<EmbeddingTestResult> {
  const config = loadRuntimeConfig({ cwd: options.cwd, env: options.env, overrides: options.overrides });
  return testEmbeddingForConfig(config, options);
}

// Runs one small embedding request against the effective provider and classifies failures.
// Never includes the API key in the result; baseUrl/model are not secrets and stay visible
// so doctor/configure output remains actionable.
export async function testEmbeddingForConfig(
  config: RuntimeConfig,
  options: Pick<EmbeddingTestOptions, "fetchImpl" | "sampleText"> = {}
): Promise<EmbeddingTestResult> {
  const semantic = config.semantic;
  const base: EmbeddingTestResult = {
    ok: false,
    provider: semantic.embeddingProvider,
    model: semantic.embeddingModel,
    baseUrl: semantic.embeddingProvider === "openai-compatible" ? semantic.embeddingBaseUrl : undefined,
    requestedDimensions: semantic.embeddingDimensions
  };

  if (semantic.embeddingProvider === "openai-compatible" && !config.embeddingApiKey) {
    return {
      ...base,
      failure: {
        kind: "missing_key",
        message: "No embedding API key configured. Set RAGCODE_EMBEDDING_API_KEY (or OPENAI_API_KEY), or run `ragcode configure`."
      }
    };
  }

  const provider = semantic.embeddingProvider === "deterministic"
    ? new DeterministicEmbeddingProvider(semantic.embeddingDimensions ?? 64)
    : new OpenAICompatibleEmbeddingProvider({
      apiKey: config.embeddingApiKey ?? "",
      model: semantic.embeddingModel ?? "text-embedding-3-small",
      baseUrl: semantic.embeddingBaseUrl,
      dimensions: semantic.embeddingDimensions,
      requestDimensions: semantic.embeddingRequestDimensions,
      fetch: options.fetchImpl
    });

  const startedAt = performance.now();
  try {
    const vector = await provider.embed(options.sampleText ?? "ragcode embedding connectivity test");
    const latencyMs = Math.round(performance.now() - startedAt);
    if (semantic.embeddingDimensions !== undefined && vector.length !== semantic.embeddingDimensions) {
      return {
        ...base,
        dimensions: vector.length,
        latencyMs,
        failure: {
          kind: "dimensions_mismatch",
          message: `Provider returned ${vector.length} dimensions but ${semantic.embeddingDimensions} are configured. Align embeddingDimensions or enable embeddingRequestDimensions if the provider supports it.`
        }
      };
    }
    return { ...base, ok: true, dimensions: vector.length, latencyMs };
  } catch (error) {
    return {
      ...base,
      latencyMs: Math.round(performance.now() - startedAt),
      failure: classifyEmbeddingFailure(error)
    };
  }
}

function classifyEmbeddingFailure(error: unknown): NonNullable<EmbeddingTestResult["failure"]> {
  const candidate = error as { status?: number; message?: string; cause?: { code?: string } };
  const message = candidate?.message ?? String(error);
  const lowered = message.toLowerCase();
  const causeCode = candidate?.cause?.code ?? "";

  if (candidate?.status === 401 || candidate?.status === 403 || /unauthorized|invalid api key|incorrect api key|forbidden/.test(lowered)) {
    return { kind: "auth_failure", message: "Authentication failed. Check the embedding API key." };
  }
  if ((candidate?.status === 404 && /model/.test(lowered)) || /model.*(not found|does not exist)/.test(lowered)) {
    return { kind: "model_not_found", message: `Embedding model rejected by the provider: ${message}` };
  }
  if (/dimensions?.*(unsupported|not supported|invalid)|unsupported.*dimensions?|does not support.*dimensions?/.test(lowered)) {
    return { kind: "unsupported_dimensions_request", message: `Provider rejected the dimensions request: ${message}` };
  }
  if (/^(ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN)$/.test(causeCode) || /fetch failed|network|econnrefused|enotfound|etimedout/.test(lowered)) {
    return { kind: "network_failure", message: `Could not reach the embedding endpoint: ${message}` };
  }
  return { kind: "unknown", message };
}
