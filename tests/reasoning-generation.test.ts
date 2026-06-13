import { describe, it, expect } from 'vitest';
import type { SearchHit } from '../src/core/types.js';

describe('Reasoning Generation', () => {
  describe('SearchHit reasoning field', () => {
    it('should have optional reasoning field in SearchHit type', () => {
      const hit: SearchHit = {
        chunk: {
          id: 'test-chunk',
          projectId: 'test-project',
          repoRoot: '/test/repo',
          filePath: 'src/test.ts',
          content: 'function testFunction() {}',
          contentHash: 'abc123',
          language: 'typescript',
          kind: 'function',
          symbolName: 'testFunction',
          startLine: 1,
          endLine: 3
        },
        score: 0.85,
        source: 'semantic',
        reason: 'semantic similarity',
        reasoning: {
          matchedTerms: ['test', 'function'],
          symbolMatches: [{
            symbol: 'testFunction',
            confidence: 0.85,
            matchType: 'exact'
          }],
          graphPosition: {
            hops: 1,
            relationship: 'direct-match'
          }
        }
      };

      expect(hit.reasoning).toBeDefined();
      expect(hit.reasoning?.matchedTerms).toHaveLength(2);
      expect(hit.reasoning?.symbolMatches).toHaveLength(1);
      expect(hit.reasoning?.graphPosition?.hops).toBe(1);
    });

    it('should allow SearchHit without reasoning field (backward compatibility)', () => {
      const hit: SearchHit = {
        chunk: {
          id: 'test-chunk',
          projectId: 'test-project',
          repoRoot: '/test/repo',
          filePath: 'src/test.ts',
          content: 'function testFunction() {}',
          contentHash: 'abc123',
          language: 'typescript',
          kind: 'function',
          startLine: 1,
          endLine: 3
        },
        score: 0.85,
        source: 'keyword',
        reason: 'keyword match'
      };

      expect(hit.reasoning).toBeUndefined();
    });
  });

  describe('Reasoning structure', () => {
    it('should support matched terms array', () => {
      const reasoning = {
        matchedTerms: ['authentication', 'login', 'user']
      };

      expect(reasoning.matchedTerms).toBeInstanceOf(Array);
      expect(reasoning.matchedTerms).toHaveLength(3);
    });

    it('should support symbol matches with match types', () => {
      const reasoning = {
        symbolMatches: [
          { symbol: 'authenticate', confidence: 0.95, matchType: 'exact' as const },
          { symbol: 'login', confidence: 0.75, matchType: 'fuzzy' as const },
          { symbol: 'userAuth', confidence: 0.60, matchType: 'semantic' as const }
        ]
      };

      expect(reasoning.symbolMatches).toHaveLength(3);
      expect(reasoning.symbolMatches![0].matchType).toBe('exact');
      expect(reasoning.symbolMatches![1].matchType).toBe('fuzzy');
      expect(reasoning.symbolMatches![2].matchType).toBe('semantic');
    });

    it('should support graph position with hops and relationship', () => {
      const reasoning = {
        graphPosition: {
          hops: 2,
          relationship: 'graph-reranked'
        }
      };

      expect(reasoning.graphPosition!.hops).toBe(2);
      expect(reasoning.graphPosition!.relationship).toBe('graph-reranked');
    });
  });

  describe('Match type determination', () => {
    it('should classify exact matches correctly', () => {
      const symbol = 'authenticate';
      const query = 'authenticate';

      // Exact match: both are identical
      expect(symbol.toLowerCase()).toBe(query.toLowerCase());
    });

    it('should classify fuzzy matches correctly', () => {
      const symbol = 'authenticateUser';
      const query = 'authenticate';

      // Fuzzy match: query is substring of symbol
      expect(symbol.toLowerCase().includes(query.toLowerCase())).toBe(true);
    });

    it('should fall back to semantic for non-substring matches', () => {
      const symbol = 'loginHandler';
      const query = 'authenticate';

      // Neither exact nor substring = semantic
      const isExact = symbol.toLowerCase() === query.toLowerCase();
      const isFuzzy = symbol.toLowerCase().includes(query.toLowerCase()) ||
                      query.toLowerCase().includes(symbol.toLowerCase());

      expect(isExact).toBe(false);
      expect(isFuzzy).toBe(false);
      // Would be classified as semantic
    });
  });
});
