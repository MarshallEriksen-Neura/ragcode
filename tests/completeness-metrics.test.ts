import { describe, it, expect, vi } from 'vitest';
import { assessCompleteness } from '../src/context/completeness-scorer.js';
import type { GraphStore } from '../src/core/contracts.js';

describe('Completeness Metrics', () => {
  it('should assess completeness with empty index', async () => {
    const mockStore: GraphStore = {
      getFiles: vi.fn().mockResolvedValue([]),
      getSkippedFiles: vi.fn().mockResolvedValue([]),
      resetRepo: vi.fn(),
      upsertIndex: vi.fn(),
      getChunks: vi.fn(),
      getChunksForFiles: vi.fn(),
      getSymbols: vi.fn(),
      getSymbolsForFiles: vi.fn(),
      getEdges: vi.fn(),
      getEdgesForFiles: vi.fn(),
      getEdgesForScope: vi.fn(),
      findSymbol: vi.fn(),
      explainFile: vi.fn(),
      searchText: vi.fn(),
      findOwner: vi.fn(),
      impactAnalysis: vi.fn(),
      relatedTests: vi.fn(),
      traceFlow: vi.fn(),
      reviewDiff: vi.fn()
    };

    const result = await assessCompleteness(mockStore, '/test/repo');

    expect(result.score).toBeLessThanOrEqual(1.0);
    expect(result.recommendations.length).toBeGreaterThan(0);
    expect(result.recommendations.some(r => r.includes('Index is empty'))).toBe(true);
    expect(result.indexFreshness.totalFiles).toBe(0);
  });

  it('should assess completeness with healthy index', async () => {
    const mockFiles = Array.from({ length: 100 }, (_, i) => ({
      projectId: 'test',
      path: `src/file${i}.ts`,
      absolutePath: `/test/repo/src/file${i}.ts`,
      language: 'typescript' as const,
      sizeBytes: 1000,
      contentHash: `hash${i}`,
      modifiedAtMs: Date.now()
    }));

    const mockStore: GraphStore = {
      getFiles: vi.fn().mockResolvedValue(mockFiles),
      getSkippedFiles: vi.fn().mockResolvedValue([]),
      resetRepo: vi.fn(),
      upsertIndex: vi.fn(),
      getChunks: vi.fn(),
      getChunksForFiles: vi.fn(),
      getSymbols: vi.fn(),
      getSymbolsForFiles: vi.fn(),
      getEdges: vi.fn(),
      getEdgesForFiles: vi.fn(),
      getEdgesForScope: vi.fn(),
      findSymbol: vi.fn(),
      explainFile: vi.fn(),
      searchText: vi.fn(),
      findOwner: vi.fn(),
      impactAnalysis: vi.fn(),
      relatedTests: vi.fn(),
      traceFlow: vi.fn(),
      reviewDiff: vi.fn()
    };

    const result = await assessCompleteness(mockStore, '/test/repo');

    expect(result.score).toBe(1.0);
    expect(result.recommendations).toHaveLength(0);
    expect(result.indexFreshness.totalFiles).toBe(100);
    expect(result.indexFreshness.staleness).toBe('fresh');
  });

  it('should handle skipped files', async () => {
    const mockFiles = Array.from({ length: 50 }, (_, i) => ({
      projectId: 'test',
      path: `src/file${i}.ts`,
      absolutePath: `/test/repo/src/file${i}.ts`,
      language: 'typescript' as const,
      sizeBytes: 1000,
      contentHash: `hash${i}`,
      modifiedAtMs: Date.now()
    }));

    const mockSkipped = Array.from({ length: 10 }, (_, i) => ({
      filePath: `binary${i}.bin`,
      reason: 'binary file'
    }));

    const mockStore: GraphStore = {
      getFiles: vi.fn().mockResolvedValue(mockFiles),
      getSkippedFiles: vi.fn().mockResolvedValue(mockSkipped),
      resetRepo: vi.fn(),
      upsertIndex: vi.fn(),
      getChunks: vi.fn(),
      getChunksForFiles: vi.fn(),
      getSymbols: vi.fn(),
      getSymbolsForFiles: vi.fn(),
      getEdges: vi.fn(),
      getEdgesForFiles: vi.fn(),
      getEdgesForScope: vi.fn(),
      findSymbol: vi.fn(),
      explainFile: vi.fn(),
      searchText: vi.fn(),
      findOwner: vi.fn(),
      impactAnalysis: vi.fn(),
      relatedTests: vi.fn(),
      traceFlow: vi.fn(),
      reviewDiff: vi.fn()
    };

    const result = await assessCompleteness(mockStore, '/test/repo');

    expect(result.recommendations).toContain('ℹ️ 10 files skipped (binary, large, or unsupported types).');
    expect(result.coverage.filesInRepo).toBe(60); // 50 indexed + 10 skipped
  });
});
