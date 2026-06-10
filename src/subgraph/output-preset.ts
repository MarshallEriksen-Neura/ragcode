import type { ExplainImpactReport, SubgraphOutputPreset, VerifiedCodeSubgraph } from "../core/types.js";

export function applySubgraphOutputPreset(subgraph: VerifiedCodeSubgraph, preset: SubgraphOutputPreset = "agent_edit"): unknown {
  if (preset === "agent_edit") {
    return {
      query: subgraph.query,
      mode: subgraph.mode,
      answerable: subgraph.answerable,
      confidence: subgraph.confidence,
      coverageSummary: subgraph.coverageSummary,
      whyTheseFiles: subgraph.whyTheseFiles,
      snippets: subgraph.snippets,
      missingEvidence: subgraph.missingEvidence,
      nextQueries: subgraph.nextQueries,
      budgetChars: subgraph.budgetChars,
      usedChars: subgraph.usedChars
    };
  }
  if (preset === "debug_trace") {
    return {
      query: subgraph.query,
      mode: subgraph.mode,
      answerable: subgraph.answerable,
      confidence: subgraph.confidence,
      paths: subgraph.paths,
      edges: subgraph.edges,
      coverage: subgraph.coverage,
      coverageSummary: subgraph.coverageSummary,
      missingEvidence: subgraph.missingEvidence,
      nextQueries: subgraph.nextQueries
    };
  }
  if (preset === "review_risk") {
    return {
      query: subgraph.query,
      mode: subgraph.mode,
      answerable: subgraph.answerable,
      confidence: subgraph.confidence,
      coverageSummary: subgraph.coverageSummary,
      whyTheseFiles: subgraph.whyTheseFiles,
      riskEvidence: subgraph.edges.filter((edge) => edge.confidence !== "high" || edge.source === "heuristic"),
      coverage: subgraph.coverage.filter((signal) => signal.status !== "pass"),
      missingEvidence: subgraph.missingEvidence,
      nextQueries: subgraph.nextQueries
    };
  }
  return {
    query: subgraph.query,
    repoRoot: subgraph.repoRoot,
    projectId: subgraph.projectId,
    mode: subgraph.mode,
    answerable: subgraph.answerable,
    confidence: subgraph.confidence,
    coverageSummary: subgraph.coverageSummary,
    whyTheseFiles: subgraph.whyTheseFiles,
    nodes: subgraph.nodes.map((node) => ({
      id: node.id,
      filePath: node.filePath,
      symbolName: node.symbolName,
      kind: node.kind,
      role: node.role,
      confidence: node.confidence,
      citation: node.citation
    })),
    edges: subgraph.edges.map((edge) => ({
      fromNodeId: edge.fromNodeId,
      toNodeId: edge.toNodeId,
      kind: edge.kind,
      confidence: edge.confidence,
      source: edge.source,
      sourceFile: edge.sourceFile,
      targetFile: edge.targetFile,
      line: edge.line,
      targetName: edge.targetName
    })),
    paths: subgraph.paths,
    coverage: subgraph.coverage,
    missingEvidence: subgraph.missingEvidence,
    nextQueries: subgraph.nextQueries,
    budgetChars: subgraph.budgetChars,
    usedChars: subgraph.usedChars
  };
}

export function applyExplainImpactOutputPreset(report: ExplainImpactReport, preset: SubgraphOutputPreset = "agent_edit"): unknown {
  if (preset === "agent_edit" || preset === "debug_trace" || preset === "review_risk") {
    return {
      target: report.target,
      riskLevel: report.riskLevel,
      riskScore: report.riskScore,
      riskReasons: report.riskReasons,
      editReadiness: report.editReadiness,
      subgraph: applySubgraphOutputPreset(report.subgraph, preset)
    };
  }
  return {
    target: report.target,
    riskLevel: report.riskLevel,
    riskScore: report.riskScore,
    riskReasons: report.riskReasons,
    editReadiness: report.editReadiness,
    subgraph: applySubgraphOutputPreset(report.subgraph, preset)
  };
}
