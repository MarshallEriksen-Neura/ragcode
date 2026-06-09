import type { EmbeddingProvider, SemanticStore } from "../core/contracts.js";
import type { CodeChunk, SearchHit, SearchQuery } from "../core/types.js";

interface SemanticRecord {
  chunk: CodeChunk;
  embedding: number[];
}

export class InMemorySemanticStore implements SemanticStore {
  private readonly repos = new Map<string, SemanticRecord[]>();

  async resetRepo(repoRoot: string): Promise<void> {
    this.repos.set(repoRoot, []);
  }

  async deleteFile(repoRoot: string, projectId: string, filePath: string): Promise<void> {
    const existing = this.repos.get(repoRoot) ?? [];
    this.repos.set(repoRoot, existing.filter((record) => record.chunk.projectId !== projectId || record.chunk.filePath !== filePath));
  }

  async upsertChunks(chunks: CodeChunk[], provider: EmbeddingProvider, _generation?: number): Promise<void> {
    const grouped = new Map<string, SemanticRecord[]>();
    for (const chunk of chunks) {
      const embedding = await provider.embed(renderChunkForEmbedding(chunk));
      const records = grouped.get(chunk.repoRoot) ?? [];
      records.push({ chunk, embedding });
      grouped.set(chunk.repoRoot, records);
    }

    for (const [repoRoot, records] of grouped.entries()) {
      const existing = this.repos.get(repoRoot) ?? [];
      const byId = new Map(existing.map((record) => [record.chunk.id, record]));
      for (const record of records) byId.set(record.chunk.id, record);
      this.repos.set(repoRoot, [...byId.values()]);
    }
  }

  async search(query: SearchQuery, provider: EmbeddingProvider): Promise<SearchHit[]> {
    const repoRoot = requireRepoRoot(query.repoRoot);
    const queryEmbedding = await provider.embed(query.query);
    const limit = query.limit ?? 20;
    return (this.repos.get(repoRoot) ?? [])
      .filter((record) => !query.projectId || record.chunk.projectId === query.projectId)
      .map((record) => ({ record, score: cosineSimilarity(queryEmbedding, record.embedding) }))
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ record, score }) => ({
        chunk: record.chunk,
        score,
        source: "semantic",
        reason: "Vector similarity match"
      }));
  }
}

function requireRepoRoot(repoRoot: string | undefined): string {
  if (!repoRoot) throw new Error("Internal error: semantic search requires a resolved repoRoot.");
  return repoRoot;
}

export function renderChunkForEmbedding(chunk: CodeChunk): string {
  return [chunk.filePath, chunk.symbolName, chunk.language, chunk.content].filter(Boolean).join("\n");
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < length; i += 1) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}
