import type { ContextMode, SearchHit } from "../core/types.js";
import { classifyEvidencePath, isExplicitSupportingEvidenceQuery } from "./path-classification.js";

export type ResolvedContextMode = Exclude<ContextMode, "auto">;

const MODE_KEYWORDS: Record<ResolvedContextMode, string[]> = {
  debug: ["error", "bug", "fail", "failure", "stack", "trace", "exception", "crash", "log", "fix"],
  feature: ["add", "create", "implement", "feature", "ui", "api", "route", "flow"],
  refactor: ["refactor", "cleanup", "rename", "move", "simplify", "replace", "migrate"],
  review: ["review", "diff", "risk", "regression", "test", "pr"],
  explain: ["explain", "how", "why", "architecture", "overview", "onboard", "understand"]
};

export function resolveContextMode(query: string, explicit: ContextMode | undefined): ResolvedContextMode {
  if (explicit && explicit !== "auto") return explicit;
  const queryTokens = new Set(query.toLowerCase().split(/[^a-z0-9]+/i).filter(Boolean));
  let best: { mode: ResolvedContextMode; score: number } = { mode: "explain", score: 0 };
  for (const [mode, words] of Object.entries(MODE_KEYWORDS) as Array<[ResolvedContextMode, string[]]>) {
    const score = words.filter((word) => queryTokens.has(word)).length;
    if (score > best.score) best = { mode, score };
  }
  return best.mode;
}

export function applyModeBoost(hit: SearchHit, mode: ResolvedContextMode, query = ""): SearchHit {
  const text = `${hit.chunk.filePath}\n${hit.chunk.symbolName ?? ""}\n${hit.chunk.content}`.toLowerCase();
  const explicitSupportingQuery = isExplicitSupportingEvidenceQuery(query);
  const evidenceKind = classifyEvidencePath(hit.chunk.filePath);
  let boost = 0;
  if (mode === "debug") {
    boost += containsAny(text, ["error", "catch", "throw", "log", "trace", "exception"]) ? 0.35 : 0;
  } else if (mode === "feature") {
    boost += containsAny(text, ["route", "handler", "component", "service", "controller", "store"]) ? 0.3 : 0;
  } else if (mode === "refactor") {
    boost += containsAny(text, ["export", "interface", "type", "class", "function"]) ? 0.25 : 0;
  } else if (mode === "review") {
    boost += containsAny(text, ["test", "spec", "assert", "expect", "mock"]) ? 0.3 : 0;
  } else if (mode === "explain") {
    boost += containsAny(text, ["readme", "architecture", "index", "main", "server"]) ? 0.2 : 0;
  }
  if ((mode === "feature" || mode === "refactor" || mode === "explain") && !explicitSupportingQuery) {
    if (evidenceKind === "implementation") {
      boost += 0.25;
    } else {
      const penalty = evidenceKind === "test" ? 0.65 : 0.55;
      boost -= penalty;
    }
  }
  if (boost === 0) return hit;
  const score = Math.max(0, hit.score + boost);
  return {
    ...hit,
    score,
    scoreBreakdown: {
      ...hit.scoreBreakdown,
      modeBoost: (hit.scoreBreakdown?.modeBoost ?? 0) + boost,
      final: score
    },
    reason: `${hit.reason}; ${mode} mode boost`
  };
}

export function nextQueriesForMode(query: string, mode: ResolvedContextMode): string[] {
  if (mode === "debug") return [`owner chain for ${query}`, `related tests for ${query}`, `error handling around ${query}`];
  if (mode === "feature") return [`entry points for ${query}`, `state and API owners for ${query}`, `tests for ${query}`];
  if (mode === "refactor") return [`callers of ${query}`, `impact analysis for ${query}`, `public exports for ${query}`];
  if (mode === "review") return [`changed files impact`, `related tests`, `risk hotspots`];
  return [`module overview for ${query}`, `key symbols for ${query}`, `main execution flow for ${query}`];
}

function containsAny(text: string, needles: string[]): boolean {
  return needles.some((needle) => text.includes(needle));
}
