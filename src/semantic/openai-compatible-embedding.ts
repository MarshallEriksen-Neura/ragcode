import type { EmbeddingProvider } from "../core/contracts.js";

export interface OpenAICompatibleEmbeddingProviderOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  dimensions?: number;
  requestDimensions?: boolean;
  fetch?: typeof fetch;
}

interface EmbeddingResponse {
  data?: Array<{
    embedding?: number[];
  }>;
  error?: {
    message?: string;
  };
}

export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions?: number;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OpenAICompatibleEmbeddingProviderOptions) {
    if (!options.apiKey) throw new Error("OpenAI-compatible embedding provider requires an API key.");
    if (!options.model) throw new Error("OpenAI-compatible embedding provider requires a model.");
    this.baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    this.dimensions = options.dimensions;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async embed(text: string): Promise<number[]> {
    const body: Record<string, unknown> = {
      model: this.options.model,
      input: text
    };
    if (this.options.requestDimensions && this.options.dimensions) {
      body.dimensions = this.options.dimensions;
    }

    const response = await this.fetchImpl(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${this.options.apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    });
    const payload = await response.json() as EmbeddingResponse;
    if (!response.ok) {
      throw new Error(payload.error?.message ?? `Embedding request failed with HTTP ${response.status}.`);
    }

    const embedding = payload.data?.[0]?.embedding;
    if (!embedding || !embedding.every((value) => Number.isFinite(value))) {
      throw new Error("Embedding response did not include a numeric embedding vector.");
    }
    return embedding;
  }
}
