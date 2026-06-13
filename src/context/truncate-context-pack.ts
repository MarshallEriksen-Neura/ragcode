/**
 * Budget enforcement: truncate ContextPack to fit within character budget.
 *
 * Strategy:
 * 1. Aggressively limit freshness metadata arrays (stale/pending files)
 * 2. Keep highest-scored snippets until budget * 0.9
 * 3. Add truncation notice to missingEvidence
 */
export function truncateContextPack(pack: any, budget: number): any {
  const truncated = { ...pack };

  // Aggressively truncate freshness metadata to fit budget
  if (truncated.freshness) {
    truncated.freshness = {
      projectId: truncated.freshness.projectId,
      indexGeneration: truncated.freshness.indexGeneration,
      indexedAtMs: truncated.freshness.indexedAtMs,
      graphFresh: truncated.freshness.graphFresh,
      semanticFresh: truncated.freshness.semanticFresh,
      semanticCoverage: truncated.freshness.semanticCoverage,
      // Severely limit arrays - these can be huge (1000+ files)
      staleFiles: (truncated.freshness.staleFiles || []).slice(0, 3),
      pendingFiles: (truncated.freshness.pendingFiles || []).slice(0, 3),
      indexingFiles: (truncated.freshness.indexingFiles || []).slice(0, 3)
    };
  }

  truncated.ownerChain = (truncated.ownerChain || []).slice(0, 3);
  truncated.relationships = (truncated.relationships || []).slice(0, 4);
  truncated.topology = (truncated.topology || []).slice(0, 4);
  truncated.nextQueries = (truncated.nextQueries || []).slice(0, 2);

  // Calculate fixed overhead (metadata without snippets)
  const fixedSize = JSON.stringify({ ...truncated, snippets: [] }).length;

  // Sort snippets by score, keep highest until budget
  const sortedSnippets = [...pack.snippets].sort((a: any, b: any) => b.score - a.score);
  truncated.snippets = [];

  let currentSize = fixedSize;
  for (const snippet of sortedSnippets) {
    const snippetSize = JSON.stringify(snippet).length;
    if (currentSize + snippetSize > budget * 0.9 && truncated.snippets.length > 0) break;
    if (currentSize + snippetSize > budget * 0.9 && pack.snippets.length > 1 && snippetSize > budget) continue;

    truncated.snippets.push(snippet);
    currentSize += snippetSize;
  }

  // Record truncation with explicit user-facing notice
  const omittedSnippets = pack.snippets.length - truncated.snippets.length;
  const omittedFiles = {
    stale: (pack.freshness?.staleFiles?.length || 0) - (truncated.freshness?.staleFiles?.length || 0),
    pending: (pack.freshness?.pendingFiles?.length || 0) - (truncated.freshness?.pendingFiles?.length || 0)
  };

  const totalOmitted = omittedFiles.stale + omittedFiles.pending;

  truncated.missingEvidence = [
    // Remove completeness info (it's in freshness now)
    ...pack.missingEvidence.filter((m: string) => !m.includes('Index completeness')),
    `⚠️ Results truncated to fit ${budget.toLocaleString()} char budget: ${truncated.snippets.length}/${pack.snippets.length} snippets shown. ${totalOmitted > 0 ? `${totalOmitted} file status entries omitted. ` : ''}Increase --budget for full details.`
  ];

  return truncated;
}
