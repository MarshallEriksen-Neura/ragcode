import type { ExplainImpactReport, VerifiedCodeSubgraph } from "../core/types.js";

export function buildExplainImpactReport(target: string, subgraph: VerifiedCodeSubgraph): ExplainImpactReport {
  const callerCount = subgraph.nodes.filter((node) => node.role === "caller").length;
  const routeCount = subgraph.nodes.filter((node) => node.role === "route").length;
  const testCount = subgraph.nodes.filter((node) => node.role === "test").length;
  const exportedTargets = subgraph.nodes.filter((node) => node.role === "target" && node.exported).length;
  const unresolvedCount = subgraph.edges.filter((edge) => edge.confidence === "low" || edge.source === "heuristic").length;
  const truncated = subgraph.coverage.some((signal) => signal.name === "budget_truncated" && signal.status === "fail");
  const noPrimaryOwner = subgraph.coverage.some((signal) => signal.name === "primary_owner_found" && signal.status === "fail");

  let riskScore = 0;
  riskScore += callerCount * 2;
  riskScore += routeCount * 2;
  riskScore += exportedTargets * 3;
  riskScore += unresolvedCount * 3;
  if (testCount === 0) riskScore += 2;
  if (truncated) riskScore += 2;
  if (noPrimaryOwner) riskScore += 5;

  const riskReasons: string[] = [];
  if (callerCount > 0) riskReasons.push(`${callerCount} caller node(s) are in the blast radius.`);
  if (routeCount > 0) riskReasons.push(`${routeCount} route/API node(s) are in the blast radius.`);
  if (exportedTargets > 0) riskReasons.push(`${exportedTargets} exported target node(s) may be public API surface.`);
  if (testCount === 0) riskReasons.push("No explicit tested_by edge was found for the selected target.");
  if (unresolvedCount > 0) riskReasons.push(`${unresolvedCount} unresolved or heuristic edge(s) need manual verification.`);
  if (truncated) riskReasons.push("The impact subgraph was truncated by budget.");
  if (noPrimaryOwner) riskReasons.push("No primary indexed owner matched the impact target.");
  if (riskReasons.length === 0) riskReasons.push("Impact is limited to a small verified internal subgraph with test evidence.");

  const riskLevel = riskScore >= 9 ? "high" : riskScore >= 4 ? "medium" : "low";
  const editReadiness = readinessFor(subgraph, riskLevel, noPrimaryOwner, truncated, unresolvedCount);

  return {
    target,
    riskLevel,
    riskScore,
    riskReasons,
    editReadiness,
    subgraph
  };
}

function readinessFor(
  subgraph: VerifiedCodeSubgraph,
  riskLevel: ExplainImpactReport["riskLevel"],
  noPrimaryOwner: boolean,
  truncated: boolean,
  unresolvedCount: number
): ExplainImpactReport["editReadiness"] {
  if (!subgraph.answerable || noPrimaryOwner || truncated) return "not_enough_context";
  if (riskLevel === "high" || unresolvedCount > 0) return "investigate_only";
  return "safe_to_edit_after_reading";
}
