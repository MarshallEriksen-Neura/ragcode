import type { GraphStore } from "../core/contracts.js";

export interface CompletenessAssessment {
  score: number; // 0-1
  indexFreshness: {
    totalFiles: number;
    freshFiles: number;
    staleFiles: number;
    staleness: 'fresh' | 'moderate' | 'stale';
  };
  coverage: {
    filesIndexed: number;
    filesInRepo: number;
    coveragePercent: number;
  };
  recommendations: string[];
  explanation: string;
}

export async function assessCompleteness(
  graphStore: GraphStore,
  repoRoot: string
): Promise<CompletenessAssessment> {
  // Get index stats from actual files
  const files = await graphStore.getFiles(repoRoot);
  const skippedFiles = await graphStore.getSkippedFiles(repoRoot);

  // Calculate freshness (simplified - would need file watcher state in real impl)
  const totalFiles = files.length;
  const staleFiles = 0; // Would check file modification times vs index times
  const freshFiles = totalFiles - staleFiles;

  let staleness: 'fresh' | 'moderate' | 'stale' = 'fresh';
  if (staleFiles > totalFiles * 0.3) staleness = 'stale';
  else if (staleFiles > totalFiles * 0.1) staleness = 'moderate';

  // Calculate coverage (simplified - would need actual repo file count)
  const filesIndexed = totalFiles;
  const filesInRepo = totalFiles + skippedFiles.length; // Indexed + skipped = total discovered
  const coveragePercent = filesInRepo > 0 ? (filesIndexed / filesInRepo) * 100 : 100;

  // Generate recommendations
  const recommendations: string[] = [];

  if (staleness === 'stale') {
    recommendations.push('⚠️ Index is stale. Run `ragcode index` to refresh.');
  } else if (staleness === 'moderate') {
    recommendations.push('⏱️ Index is moderately stale. Consider running `ragcode index`.');
  }

  if (coveragePercent < 90) {
    recommendations.push(`📊 Only ${coveragePercent.toFixed(0)}% of repository indexed. Check .gitignore patterns.`);
  }

  if (skippedFiles.length > 0) {
    recommendations.push(`ℹ️ ${skippedFiles.length} files skipped (binary, large, or unsupported types).`);
  }

  if (totalFiles === 0) {
    recommendations.push('❌ Index is empty. Run `ragcode init` followed by `ragcode index`.');
  }

  // Calculate overall score
  const freshnessScore = staleness === 'fresh' ? 1.0 : staleness === 'moderate' ? 0.7 : 0.3;
  const coverageScore = coveragePercent / 100;
  const score = (freshnessScore + coverageScore) / 2;

  // Generate explanation
  let explanation = `Index completeness: ${(score * 100).toFixed(0)}%. `;
  explanation += `${freshFiles} files indexed (${staleness} freshness). `;

  if (recommendations.length > 0) {
    explanation += `Recommended actions: ${recommendations.join(' ')}`;
  } else {
    explanation += 'Index is current and complete.';
  }

  return {
    score,
    indexFreshness: {
      totalFiles,
      freshFiles,
      staleFiles,
      staleness
    },
    coverage: {
      filesIndexed,
      filesInRepo,
      coveragePercent
    },
    recommendations,
    explanation
  };
}
