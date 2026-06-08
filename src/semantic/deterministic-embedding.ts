import type { EmbeddingProvider } from "../core/contracts.js";

export class DeterministicEmbeddingProvider implements EmbeddingProvider {
  constructor(readonly dimensions = 64) {}

  async embed(text: string): Promise<number[]> {
    const vector = new Array<number>(this.dimensions).fill(0);
    for (const token of text.toLowerCase().split(/[^a-z0-9_]+/i).filter(Boolean)) {
      const index = hashToken(token) % this.dimensions;
      vector[index] += 1;
    }
    return normalize(vector);
  }
}

function hashToken(token: string): number {
  let hash = 2166136261;
  for (let i = 0; i < token.length; i += 1) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function normalize(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (magnitude === 0) return vector;
  return vector.map((value) => value / magnitude);
}
