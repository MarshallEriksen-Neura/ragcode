import type { EdgeKind, SearchHit } from "../core/types.js";
import type { ResolvedContextMode } from "./query-planner.js";
import type { TopologyDistance } from "./topology-distance.js";
import { classifyEvidencePath, isExplicitTestQuery, isTestPath } from "./path-classification.js";

export interface RankingSignalInput {
  hit: SearchHit;
  mode: ResolvedContextMode;
  query: string;
  distance?: TopologyDistance;
  hasStructuralSeeds: boolean;
}

export interface RankingSignalResult {
  score: number;
  adjustment: number;
  reason?: string;
}

export function applyRankingSignals(input: RankingSignalInput): RankingSignalResult {
  const reasons: string[] = [];
  let adjustment = 0;
  const distance = primaryDistanceFor(input);

  if (distance) {
    const proximity = graphProximityScore(distance.hops) * 1.6;
    const edgeBoost = edgeKindBoost(distance.edgeKinds);
    adjustment += proximity + edgeBoost;
    reasons.push(graphReason(distance, proximity + edgeBoost));
  } else if (input.hasStructuralSeeds && disconnectedPenaltyApplies(input.hit)) {
    const penalty = isTestPath(input.hit.chunk.filePath) ? 0.15 : 0.25;
    adjustment -= penalty;
    reasons.push(`graph disconnected from structural seeds (-${penalty.toFixed(2)})`);
  }

  const testAdjustment = testModeAdjustment(input);
  if (testAdjustment !== 0) {
    adjustment += testAdjustment;
    reasons.push(testAdjustment > 0
      ? `test relevance boost (+${testAdjustment.toFixed(2)})`
      : `test default demotion (${testAdjustment.toFixed(2)})`);
  }

  return {
    score: Math.max(0, input.hit.score + adjustment),
    adjustment,
    reason: reasons.length > 0 ? `graph rerank: ${reasons.join("; ")}` : undefined
  };
}

export function graphProximityScore(hops: number): number {
  if (hops <= 0) return 1;
  if (hops === 1) return 0.82;
  if (hops === 2) return 0.52;
  if (hops === 3) return 0.24;
  return 0;
}

export function edgeKindBoost(kinds: EdgeKind[]): number {
  if (kinds.length === 0) return 0;
  return Math.max(...kinds.map(edgeKindWeight)) * 0.42;
}

export function edgeKindWeight(kind: EdgeKind): number {
  if (kind === "calls" || kind === "calls_api" || kind === "routes_to" || kind === "handles_event" || kind === "handles_webhook") return 1;
  if (kind === "tested_by") return 0.9;
  if (kind === "uses_middleware") return 0.85;
  if (kind === "imports" || kind === "exports") return 0.75;
  if (kind === "reads_from" || kind === "writes_to" || kind === "references") return 0.55;
  if (kind === "contains") return 0.2;
  return 0.15;
}

function graphReason(distance: TopologyDistance, boost: number): string {
  if (distance.hops === 0) {
    const via = unique(distance.edgeKinds).slice(0, 2).join("/");
    return via ? `structural seed via ${via} (+${boost.toFixed(2)})` : `structural seed (+${boost.toFixed(2)})`;
  }
  const via = unique(distance.edgeKinds).slice(0, 3).join("/");
  return `graph proximity ${distance.hops} hop${distance.hops === 1 ? "" : "s"}${via ? ` via ${via}` : ""} (+${boost.toFixed(2)})`;
}

function testModeAdjustment(input: RankingSignalInput): number {
  if (!isTestPath(input.hit.chunk.filePath)) return 0;
  const explicitTestQuery = isExplicitTestQuery(input.query);
  if ((input.mode === "review" || input.mode === "debug" || explicitTestQuery) && input.distance) return 0.45;
  if (!explicitTestQuery && input.mode !== "review" && input.mode !== "debug") return -0.25;
  return 0;
}

function primaryDistanceFor(input: RankingSignalInput): TopologyDistance | undefined {
  if (!input.distance) return undefined;
  if (!isTestPath(input.hit.chunk.filePath)) return input.distance;
  if (input.mode === "review" || input.mode === "debug" || isExplicitTestQuery(input.query)) return input.distance;
  return undefined;
}

function disconnectedPenaltyApplies(hit: SearchHit): boolean {
  if (classifyEvidencePath(hit.chunk.filePath) !== "implementation") return true;
  if (hit.chunk.language === "markdown" || hit.chunk.language === "json") return true;
  return hit.source === "semantic" || hit.source === "keyword";
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
