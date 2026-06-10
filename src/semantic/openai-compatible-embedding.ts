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
    index?: number;
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
    const [embedding] = await this.embedBatch([text]);
    return embedding;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const payload = await this.requestEmbeddings(texts.length === 1 ? texts[0] : texts);
    const rows = payload.data;
    if (!rows || rows.length !== texts.length) {
      throw new Error(`Embedding response returned ${rows?.length ?? 0} vector(s), expected ${texts.length}.`);
    }

    const embeddings = new Array<number[]>(texts.length);
    rows.forEach((row, position) => {
      const index = row.index ?? position;
      if (!Number.isInteger(index) || index < 0 || index >= texts.length) {
        throw new Error(`Embedding response included invalid index: ${String(row.index)}.`);
      }
      if (!row.embedding || !row.embedding.every((value) => Number.isFinite(value))) {
        throw new Error("Embedding response did not include a numeric embedding vector.");
      }
      embeddings[index] = row.embedding;
    });

    if (embeddings.some((embedding) => !embedding)) {
      throw new Error("Embedding response did not include all requested vectors.");
    }
    return embeddings;
  }

  private async requestEmbeddings(input: string | string[]): Promise<EmbeddingResponse> {
    const body: Record<string, unknown> = {
      model: this.options.model,
      input
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
    if (!response.ok) {
      let message = `Embedding request failed with HTTP ${response.status}.`;
      try {
        const errorPayload = await response.json() as EmbeddingResponse;
        if (errorPayload.error?.message) message = errorPayload.error.message;
      } catch {
        // Non-JSON error body (e.g. a proxy HTML page); keep the HTTP status message.
      }
      // Attach the status so retry classification can see 429/5xx instead of guessing from text.
      throw Object.assign(new Error(message), { status: response.status });
    }
    return await response.json() as EmbeddingResponse;
  }
}
