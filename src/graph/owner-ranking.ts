import type { OwnerCandidate } from "../core/types.js";
import { isExplicitTestQuery, isTestPath } from "../retrieval/path-classification.js";

const DEFAULT_TEST_OWNER_MULTIPLIER = 0.55;
const TEST_OWNER_CEILING_RATIO = 0.95;
const EXPLICIT_TEST_OWNER_BOOST = 1;

export function applyOwnerPathIntent(candidates: OwnerCandidate[], query: string): OwnerCandidate[] {
  const explicitTestQuery = isExplicitTestQuery(query);
  const normalizedQuery = query.replaceAll("\\", "/").toLowerCase();
  const implementationScores = candidates
    .filter((candidate) => !isTestPath(candidate.filePath))
    .map((candidate) => candidate.score);
  const strongestImplementationScore = implementationScores.length > 0
    ? Math.max(...implementationScores)
    : undefined;

  return candidates.map((candidate) => {
    if (!isTestPath(candidate.filePath)) return candidate;

    if (explicitTestQuery || queryNamesPath(normalizedQuery, candidate.filePath)) {
      return {
        ...candidate,
        score: candidate.score + EXPLICIT_TEST_OWNER_BOOST,
        reasons: [...candidate.reasons, `test relevance boost (+${EXPLICIT_TEST_OWNER_BOOST.toFixed(2)}): explicit test query`]
      };
    }

    if (strongestImplementationScore === undefined) return candidate;

    const adjustedScore = Math.min(
      candidate.score * DEFAULT_TEST_OWNER_MULTIPLIER,
      strongestImplementationScore * TEST_OWNER_CEILING_RATIO
    );
    return {
      ...candidate,
      score: adjustedScore,
      reasons: [...candidate.reasons, `test default demotion (${formatScoreDelta(adjustedScore - candidate.score)}): owner query is implementation-oriented`]
    };
  });
}

function formatScoreDelta(delta: number): string {
  return delta.toFixed(2);
}

function queryNamesPath(normalizedQuery: string, filePath: string): boolean {
  const normalizedPath = filePath.replaceAll("\\", "/").toLowerCase();
  const basename = normalizedPath.split("/").pop();
  return normalizedQuery.includes(normalizedPath) || Boolean(basename && normalizedQuery.includes(basename));
}
