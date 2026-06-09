import type { GraphStore } from "../core/contracts.js";
import type { CodeChunk, SearchHit, SearchQuery } from "../core/types.js";
import { buildQueryMatchProfile, scoreChunkText, scoreSymbolText, splitIdentifier, textContainsTerm } from "./query-matching.js";
import { classifyEvidencePath, isExplicitSupportingEvidenceQuery, isExplicitTestQuery, isTestPath } from "./path-classification.js";
import { applyRankingSignals, edgeKindBoost, graphProximityScore } from "./ranking-signals.js";
import type { ResolvedContextMode } from "./query-planner.js";
import { buildFileGraph, computeTopologyDistances, graphDegree, type TopologyDistance } from "./topology-distance.js";

export interface GraphRerankerOptions {
  graphStore: GraphStore;
  maxHops?: number;
  maxSeeds?: number;
  maxExpansionCandidates?: number;
  maxExpansionHops?: number;
}

export async function rerankWithGraph(
  hits: SearchHit[],
  query: SearchQuery,
  mode: ResolvedContextMode,
  options: GraphRerankerOptions
): Promise<SearchHit[]> {
  if (hits.length === 0 || !query.repoRoot) return hits;

  try {
    const [symbols, edges] = await Promise.all([
      options.graphStore.getSymbols(query.repoRoot),
      options.graphStore.getEdges(query.repoRoot)
    ]);
    const scopedSymbols = query.projectId ? symbols.filter((symbol) => symbol.projectId === query.projectId) : symbols;
    const scopedEdges = query.projectId ? edges.filter((edge) => edge.projectId === query.projectId) : edges;
    const profile = buildQueryMatchProfile(query.query, scopedSymbols);
    const graph = buildFileGraph(scopedSymbols, scopedEdges, query.projectId);
    const seedFiles = selectStructuralSeeds(hits, graph, query.query, mode, options.maxSeeds ?? 6);
    if (seedFiles.length === 0) return hits;

    const maxHops = options.maxHops ?? 3;
    const expandedHits = await expandGraphHits({
      hits,
      query,
      mode,
      graphStore: options.graphStore,
      graph,
      symbols: scopedSymbols,
      seedFiles,
      maxHops: Math.min(options.maxExpansionHops ?? 2, maxHops),
      maxCandidates: options.maxExpansionCandidates ?? defaultExpansionCandidateCount(query.limit)
    });
    const candidateHits = appendUniqueHits(hits, expandedHits);
    const candidateFiles = candidateHits.map((hit) => hit.chunk.filePath);
    const distances = computeTopologyDistances(graph, seedFiles, candidateFiles, {
      projectId: query.projectId,
      maxHops
    });

    return candidateHits
      .map((hit) => {
        const distance = distances.get(hit.chunk.filePath) ?? inferRelatedTestDistance(hit.chunk.filePath, seedFiles, query.query, mode);
        const signal = applyRankingSignals({
          hit,
          mode,
          query: query.query,
          distance,
          hasStructuralSeeds: seedFiles.length > 0
        });
        const ownerIntentAdjustment = ownerIntentRerankAdjustment(hit, profile, query.query);
        const score = signal.score + ownerIntentAdjustment;
        const reason = [
          signal.reason ? `${hit.reason}; ${signal.reason}` : hit.reason,
          ownerIntentAdjustment > 0 ? `owner intent rerank (+${ownerIntentAdjustment.toFixed(2)})` : undefined
        ].filter(Boolean).join("; ");
        return signal.reason
          || ownerIntentAdjustment > 0
          ? {
            ...hit,
            score,
            scoreBreakdown: {
              ...hit.scoreBreakdown,
              graphAdjustment: (hit.scoreBreakdown?.graphAdjustment ?? 0) + signal.adjustment + ownerIntentAdjustment,
              final: score
            },
            reason
          }
          : hit;
      })
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.chunk.filePath.localeCompare(b.chunk.filePath);
      });
  } catch {
    return hits;
  }
}

interface GraphExpansionInput {
  hits: SearchHit[];
  query: SearchQuery;
  mode: ResolvedContextMode;
  graphStore: GraphStore;
  graph: ReturnType<typeof buildFileGraph>;
  symbols: Awaited<ReturnType<GraphStore["getSymbols"]>>;
  seedFiles: string[];
  maxHops: number;
  maxCandidates: number;
}

interface ExpansionCandidate {
  hit: SearchHit;
  rank: number;
}

async function expandGraphHits(input: GraphExpansionInput): Promise<SearchHit[]> {
  if (!input.query.repoRoot || input.maxCandidates <= 0 || input.maxHops <= 0) return [];

  const chunks = await input.graphStore.getChunks(input.query.repoRoot);
  const scopedChunks = input.query.projectId ? chunks.filter((chunk) => chunk.projectId === input.query.projectId) : chunks;
  const chunksByFile = groupChunksByFile(scopedChunks);
  const symbolsByFile = groupSymbolsByFile(input.symbols);
  const existingFiles = new Set(input.hits.map((hit) => hit.chunk.filePath));
  const profile = buildQueryMatchProfile(input.query.query, input.symbols);
  const intentOwnerFiles = collectIntentOwnerFiles(chunksByFile, symbolsByFile, profile, input.query.query, input.mode);
  const reachableFiles = unique([...collectReachableFiles(input.graph, input.seedFiles, input.maxHops), ...intentOwnerFiles])
    .filter((filePath) => !existingFiles.has(filePath));
  if (reachableFiles.length === 0) return [];

  const distances = computeTopologyDistances(input.graph, input.seedFiles, reachableFiles, {
    projectId: input.query.projectId,
    maxHops: input.maxHops
  });
  const candidates: ExpansionCandidate[] = [];

  for (const filePath of reachableFiles) {
    const fileChunks = chunksByFile.get(filePath) ?? [];
    if (!shouldExpandFile(filePath, fileChunks, input.query.query, input.mode)) continue;

    const distance = distances.get(filePath);
    if (distance?.hops === 0) continue;

    const selected = selectExpansionChunk(fileChunks, profile);
    if (!selected) continue;

    const pathScore = scorePathMatch(filePath, profile.queryTermVariants);
    const fileNameScore = scoreFileNameMatch(filePath, profile.queryTermVariants);
    const symbolScore = bestSymbolScore(symbolsByFile.get(filePath) ?? [], profile);
    const centralityScore = scoreGraphCentrality(input.graph, filePath);
    const intentScore = scoreOwnerIntent(filePath, profile.queryTerms, profile.queryTermVariants, input.query.query);
    if (!hasExpansionEvidence(distance, selected.matchScore, pathScore + fileNameScore + intentScore, symbolScore)) continue;
    if (!isOwnerLikeExpansion(selected.chunk, selected.matchScore, pathScore, fileNameScore, symbolScore, centralityScore, intentScore)) continue;

    const baseScore = expansionBaseScore(distance, selected.matchScore, pathScore, fileNameScore, symbolScore, selected.kindScore, centralityScore, intentScore);
    const score = Math.max(0.05, baseScore);
    candidates.push({
      rank: score + (distance ? graphProximityScore(distance.hops) : 0) + centralityScore + fileNameScore + intentScore,
      hit: {
        chunk: selected.chunk,
        score,
        scoreBreakdown: {
          graphAdjustment: score,
          final: score
        },
        source: "graph",
        reason: graphExpansionReason(distance, selected.matchReason, pathScore, fileNameScore, symbolScore, centralityScore, intentScore)
      }
    });
  }

  return selectDiverseExpansionCandidates(candidates, input.maxCandidates).map((candidate) => candidate.hit);
}

function appendUniqueHits(hits: SearchHit[], expandedHits: SearchHit[]): SearchHit[] {
  if (expandedHits.length === 0) return hits;
  const seenChunks = new Set(hits.map((hit) => hit.chunk.id));
  const seenFiles = new Set(hits.map((hit) => hit.chunk.filePath));
  const output = [...hits];
  for (const hit of expandedHits) {
    if (seenChunks.has(hit.chunk.id) || seenFiles.has(hit.chunk.filePath)) continue;
    seenChunks.add(hit.chunk.id);
    seenFiles.add(hit.chunk.filePath);
    output.push(hit);
  }
  return output;
}

function selectDiverseExpansionCandidates(candidates: ExpansionCandidate[], maxCandidates: number): ExpansionCandidate[] {
  const selected: ExpansionCandidate[] = [];
  const byDirectory = new Map<string, number>();

  for (const candidate of candidates.sort((a, b) => b.rank - a.rank || a.hit.chunk.filePath.localeCompare(b.hit.chunk.filePath))) {
    const directory = parentDirectory(candidate.hit.chunk.filePath);
    const currentForDirectory = byDirectory.get(directory) ?? 0;
    if (currentForDirectory >= 2) continue;

    selected.push(candidate);
    byDirectory.set(directory, currentForDirectory + 1);
    if (selected.length >= maxCandidates) break;
  }

  return selected;
}

function inferRelatedTestDistance(filePath: string, seedFiles: string[], query: string, mode: ResolvedContextMode) {
  if (!isTestPath(filePath)) return undefined;
  if (mode !== "review" && mode !== "debug" && !isExplicitTestQuery(query)) return undefined;

  const testBase = testSubjectName(filePath);
  if (!testBase) return undefined;
  const matchingSeed = seedFiles.find((seedFile) => fileSubjectName(seedFile) === testBase);
  if (!matchingSeed) return undefined;

  return {
    hops: 1,
    edgeKinds: ["tested_by" as const],
    path: [matchingSeed, filePath]
  };
}

function selectStructuralSeeds(
  hits: SearchHit[],
  graph: ReturnType<typeof buildFileGraph>,
  query: string,
  mode: ResolvedContextMode,
  maxSeeds: number
): string[] {
  const explicitTestQuery = isExplicitTestQuery(query);
  const byFile = new Map<string, { chunk: CodeChunk; score: number }>();

  for (const hit of hits) {
    const existing = byFile.get(hit.chunk.filePath);
    if (!existing || hit.score > existing.score) {
      byFile.set(hit.chunk.filePath, { chunk: hit.chunk, score: hit.score });
    }
  }

  return [...byFile.values()]
    .filter(({ chunk }) => isCodeChunk(chunk))
    .filter(({ chunk }) => graphDegree(graph, chunk.filePath) > 0)
    .filter(({ chunk }) => {
      if (!isTestPath(chunk.filePath)) return true;
      return explicitTestQuery && (mode === "review" || mode === "debug");
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.chunk.filePath.localeCompare(b.chunk.filePath);
    })
    .slice(0, maxSeeds)
    .map(({ chunk }) => chunk.filePath);
}

function isCodeChunk(chunk: CodeChunk): boolean {
  return chunk.language !== "markdown" && chunk.language !== "json" && chunk.language !== "unknown";
}

function collectReachableFiles(graph: ReturnType<typeof buildFileGraph>, seedFiles: string[], maxHops: number): string[] {
  const reachable = new Set<string>();
  const visited = new Map<string, number>();
  const queue = unique(seedFiles).map((filePath) => ({ filePath, hops: 0 }));

  for (const seedFile of seedFiles) visited.set(seedFile, 0);

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];
    if (current.hops >= maxHops) continue;

    for (const neighbor of graph.adjacency.get(current.filePath) ?? []) {
      const nextHops = current.hops + 1;
      const existing = visited.get(neighbor.filePath);
      if (existing !== undefined && existing <= nextHops) continue;
      visited.set(neighbor.filePath, nextHops);
      reachable.add(neighbor.filePath);
      queue.push({ filePath: neighbor.filePath, hops: nextHops });
    }
  }

  return [...reachable];
}

function shouldExpandFile(filePath: string, chunks: CodeChunk[], query: string, mode: ResolvedContextMode): boolean {
  if (!chunks.some(isCodeChunk)) return false;
  const evidenceKind = classifyEvidencePath(filePath);
  if (evidenceKind === "implementation") return true;
  if (evidenceKind === "test") return isExplicitTestQuery(query) && (mode === "review" || mode === "debug");
  return isExplicitSupportingEvidenceQuery(query);
}

function selectExpansionChunk(
  chunks: CodeChunk[],
  profile: ReturnType<typeof buildQueryMatchProfile>
): { chunk: CodeChunk; matchScore: number; matchReason?: string; kindScore: number } | undefined {
  return chunks
    .filter(isCodeChunk)
    .map((chunk) => {
      const match = scoreChunkText(chunk, profile);
      const kindScore = chunkKindScore(chunk);
      return {
        chunk,
        matchScore: match?.score ?? 0,
        matchReason: match?.reason,
        kindScore,
        rank: (match?.score ?? 0) + kindScore + chunkCompactnessScore(chunk)
      };
    })
    .sort((a, b) => b.rank - a.rank || a.chunk.filePath.localeCompare(b.chunk.filePath) || a.chunk.startLine - b.chunk.startLine)[0];
}

function collectIntentOwnerFiles(
  chunksByFile: Map<string, CodeChunk[]>,
  symbolsByFile: Map<string, Awaited<ReturnType<GraphStore["getSymbols"]>>>,
  profile: ReturnType<typeof buildQueryMatchProfile>,
  query: string,
  mode: ResolvedContextMode
): string[] {
  const candidates: Array<{ filePath: string; score: number }> = [];
  for (const [filePath, chunks] of chunksByFile) {
    if (!shouldExpandFile(filePath, chunks, query, mode)) continue;
    const selected = selectExpansionChunk(chunks, profile);
    if (!selected) continue;
    const pathScore = scorePathMatch(filePath, profile.queryTermVariants);
    const fileNameScore = scoreFileNameMatch(filePath, profile.queryTermVariants);
    const symbolScore = bestSymbolScore(symbolsByFile.get(filePath) ?? [], profile);
    const intentScore = scoreOwnerIntent(filePath, profile.queryTerms, profile.queryTermVariants, query);
    const score = selected.matchScore + pathScore + fileNameScore + symbolScore + intentScore;
    if (score < 0.7 && intentScore < 0.35) continue;
    candidates.push({ filePath, score });
  }
  return candidates
    .sort((a, b) => b.score - a.score || a.filePath.localeCompare(b.filePath))
    .slice(0, 24)
    .map((candidate) => candidate.filePath);
}

function chunkKindScore(chunk: CodeChunk): number {
  if (chunk.kind === "function" || chunk.kind === "class" || chunk.kind === "method") return 0.28;
  if (chunk.kind === "type" || chunk.kind === "variable") return 0.2;
  if (chunk.kind === "file") return 0.12;
  return 0.08;
}

function scorePathMatch(filePath: string, queryTermVariants: string[]): number {
  if (queryTermVariants.length === 0) return 0;
  const pathText = `${filePath}\n${splitIdentifier(filePath).join(" ")}`.toLowerCase();
  const matchedTerms = queryTermVariants.filter((term) => textContainsTerm(pathText, term)).length;
  return Math.min(0.55, matchedTerms * 0.12);
}

function scoreFileNameMatch(filePath: string, queryTermVariants: string[]): number {
  if (queryTermVariants.length === 0) return 0;
  const baseName = filePath.split("/").pop()?.replace(/\.[^.]+$/, "") ?? filePath;
  const fileNameText = `${baseName}\n${splitIdentifier(baseName).join(" ")}`.toLowerCase();
  const matchedTerms = queryTermVariants.filter((term) => textContainsTerm(fileNameText, term)).length;
  return Math.min(0.45, matchedTerms * 0.18);
}

function bestSymbolScore(
  symbols: Awaited<ReturnType<GraphStore["getSymbols"]>>,
  profile: ReturnType<typeof buildQueryMatchProfile>
): number {
  let best = 0;
  for (const symbol of symbols) {
    const match = scoreSymbolText(symbol, profile);
    if (match && match.score > best) best = match.score;
  }
  return Math.min(0.8, best);
}

function scoreGraphCentrality(graph: ReturnType<typeof buildFileGraph>, filePath: string): number {
  return Math.min(0.8, graphDegree(graph, filePath) * 0.02);
}

function chunkCompactnessScore(chunk: CodeChunk): number {
  const lines = Math.max(1, chunk.endLine - chunk.startLine + 1);
  if (lines <= 80) return 0.16;
  if (lines <= 180) return 0.1;
  if (lines <= 320) return 0.04;
  return 0;
}

function hasExpansionEvidence(distance: TopologyDistance | undefined, chunkScore: number, pathScore: number, symbolScore: number): boolean {
  if (chunkScore > 0 || pathScore > 0 || symbolScore > 0) return true;
  if (!distance) return false;
  return distance.edgeKinds.some((kind) =>
    kind === "calls" ||
    kind === "calls_api" ||
    kind === "routes_to" ||
    kind === "handles_event" ||
    kind === "handles_webhook" ||
    kind === "imports" ||
    kind === "exports" ||
    kind === "uses_middleware"
  );
}

function isOwnerLikeExpansion(chunk: CodeChunk, chunkScore: number, pathScore: number, fileNameScore: number, symbolScore: number, centralityScore: number, intentScore: number): boolean {
  if (chunk.kind === "variable" && fileNameScore === 0) return false;

  const lineCount = Math.max(1, chunk.endLine - chunk.startLine + 1);
  if (lineCount > 240 && fileNameScore === 0 && pathScore + intentScore < 0.18) return false;

  const hasTextualEvidence = chunkScore > 0 || pathScore > 0 || fileNameScore > 0 || symbolScore > 0;
  const fileNameEvidence = fileNameScore > 0 && (chunkScore >= 0.5 || symbolScore >= 0.5 || centralityScore >= 0.5);

  return (centralityScore >= 0.7 && hasTextualEvidence) || fileNameEvidence || intentScore >= 0.35 || symbolScore >= 0.7 || chunkScore >= 0.9;
}

function expansionBaseScore(
  distance: TopologyDistance | undefined,
  chunkScore: number,
  pathScore: number,
  fileNameScore: number,
  symbolScore: number,
  kindScore: number,
  centralityScore: number,
  intentScore: number
): number {
  return 0.25 + chunkScore + pathScore + fileNameScore + symbolScore + kindScore + centralityScore + intentScore + (distance ? (graphProximityScore(distance.hops) * 0.55) + edgeKindBoost(distance.edgeKinds) : 0);
}

function graphExpansionReason(
  distance: TopologyDistance | undefined,
  matchReason: string | undefined,
  pathScore: number,
  fileNameScore: number,
  symbolScore: number,
  centralityScore: number,
  intentScore: number
): string {
  const via = distance ? unique(distance.edgeKinds).slice(0, 3).join("/") : "";
  const parts = [distance
    ? `graph expansion: ${distance.hops} hop${distance.hops === 1 ? "" : "s"}${via ? ` via ${via}` : ""}`
    : "owner intent expansion"];
  if (matchReason) parts.push(matchReason);
  if (pathScore > 0) parts.push(`path match +${pathScore.toFixed(2)}`);
  if (fileNameScore > 0) parts.push(`file match +${fileNameScore.toFixed(2)}`);
  if (symbolScore > 0) parts.push(`symbol match +${symbolScore.toFixed(2)}`);
  if (centralityScore > 0) parts.push(`graph centrality +${centralityScore.toFixed(2)}`);
  if (intentScore > 0) parts.push(`owner intent +${intentScore.toFixed(2)}`);
  return parts.join("; ");
}

function ownerIntentRerankAdjustment(
  hit: SearchHit,
  profile: ReturnType<typeof buildQueryMatchProfile>,
  query: string
): number {
  if (hit.reason.includes("owner intent +")) return 0;
  const intentScore = scoreOwnerIntent(hit.chunk.filePath, profile.queryTerms, profile.queryTermVariants, query);
  if (intentScore < 0.55) return 0;
  return Math.min(3.4, intentScore * 4.2);
}

function scoreOwnerIntent(filePath: string, queryTerms: string[], queryTermVariants: string[], query: string): number {
  const rawSegments = filePath.replaceAll("\\", "/").split("/");
  const segments = rawSegments.map((segment) => segment.toLowerCase());
  const rawBaseName = rawSegments[rawSegments.length - 1]?.replace(/\.[^.]+$/, "") ?? "";
  const baseName = rawBaseName.toLowerCase();
  const baseParts = splitIdentifier(rawBaseName);
  const matchedBaseParts = baseParts.filter((part) => queryTermVariants.includes(part)).length;
  const hasExactBaseIntent = baseParts.length >= 2 && queryTermVariants.some((term) => term === baseName || term === baseParts.join(""));
  const hasCompleteBaseIntent = matchedBaseParts === baseParts.length && baseParts.length >= 2;
  const hasSingleBaseIntent = baseParts.length === 1 && queryTermVariants.includes(baseName) && !isGenericOwnerTerm(baseName);
  const hasEntryPointIntent = baseName === "index" && pathHasMatchedOwnerSegment(segments, queryTermVariants);
  const hasFocusedFileNameIntent = hasExactBaseIntent || hasCompleteBaseIntent || hasSingleBaseIntent || hasEntryPointIntent;
  let score = 0;

  if (hasExactBaseIntent) score += 0.38;
  if (hasCompleteBaseIntent) score += 0.42;
  else if (matchedBaseParts >= 2) score += 0.18;
  if (hasSingleBaseIntent) score += 0.28;
  if (hasEntryPointIntent) score += 0.46;
  if (queryTerms.some((term) => term === "command" || term === "commands") && segments.includes("commands")) score += 0.3;
  if (segments.some((segment) => splitIdentifier(segment).some((part) => queryTermVariants.includes(part) && !isGenericOwnerTerm(part)))) score += 0.22;
  if (hasSingleBaseIntent && baseName === "compose" && queryHasAny(queryTermVariants, ["middleware", "handler", "chain"])) score += 0.34;
  if (hasSingleBaseIntent && baseName === "build" && queryHasAny(queryTermVariants, ["hook", "hooks", "plugin", "plugins"])) score += 0.24;
  if (hasSingleBaseIntent && baseName === "schema" && pathHasTerm(segments, queryTermVariants, "registry")) score += 0.28;
  if (baseParts.includes("base") && queryHasAny(queryTermVariants, ["middleware", "handler", "chain"])) score += 0.56;
  if (hasFocusedFileNameIntent && pathHasTerm(segments, queryTermVariants, "operations", "operation")) score += 0.36;
  if (hasFocusedFileNameIntent && pathHasTerm(segments, queryTermVariants, "local")) score += 0.22;
  if (hasFocusedFileNameIntent && pathHasTerm(segments, queryTermVariants, "collections", "collection")) score += 0.18;
  if (hasFocusedFileNameIntent && pathHasTerm(segments, queryTermVariants, "auth")) score += 0.18;
  if (hasFocusedFileNameIntent && pathHasTerm(segments, queryTermVariants, "strategies", "strategy")) score += 0.24;
  if (/\b(cache|core|manager|notify|observer|resolver|request)\b/i.test(query) && segments.some((segment) => segment.includes("-core") || segment === "core")) score += 0.3;
  if (isMismatchedQueryAdapterPackage(segments, queryTermVariants)) score -= 0.35;

  return Math.max(0, Math.min(1.15, score));
}

function pathHasMatchedOwnerSegment(segments: string[], queryTermVariants: string[]): boolean {
  return segments.some((segment) => splitIdentifier(segment).some((part) => queryTermVariants.includes(part) && !isGenericOwnerTerm(part)));
}

function queryHasAny(queryTermVariants: string[], terms: string[]): boolean {
  return terms.some((term) => queryTermVariants.some((variant) => textContainsTerm(term, variant) || textContainsTerm(variant, term)));
}

function pathHasTerm(segments: string[], queryTermVariants: string[], segmentName: string, queryTerm = segmentName): boolean {
  return segments.some((segment) => textContainsTerm(segment, segmentName))
    && queryTermVariants.some((term) => textContainsTerm(queryTerm, term) || textContainsTerm(term, queryTerm));
}

function isGenericOwnerTerm(term: string): boolean {
  return term === "core"
    || term === "index"
    || term === "query"
    || term === "src"
    || term === "type"
    || term === "types"
    || term === "util"
    || term === "utils";
}

function isMismatchedQueryAdapterPackage(segments: string[], queryTermVariants: string[]): boolean {
  const packageIndex = segments.indexOf("packages");
  if (packageIndex < 0) return false;
  const packageName = segments[packageIndex + 1];
  if (!packageName || packageName === "query-core" || !packageName.endsWith("-query")) return false;

  const packageParts = packageName.split("-").filter((part) => !isGenericOwnerTerm(part));
  if (packageParts.length === 0 || packageParts.some((part) => queryTermVariants.includes(part))) return false;
  return queryTermVariants.some((term) => packageAdapterTerms.has(term));
}

const packageAdapterTerms = new Set(["angular", "preact", "react", "solid", "svelte", "vue"]);

function parentDirectory(filePath: string): string {
  const normalized = filePath.replaceAll("\\", "/");
  return normalized.includes("/") ? normalized.slice(0, normalized.lastIndexOf("/")) : "";
}

function groupChunksByFile(chunks: CodeChunk[]): Map<string, CodeChunk[]> {
  const byFile = new Map<string, CodeChunk[]>();
  for (const chunk of chunks) {
    const current = byFile.get(chunk.filePath) ?? [];
    current.push(chunk);
    byFile.set(chunk.filePath, current);
  }
  return byFile;
}

function groupSymbolsByFile(symbols: Awaited<ReturnType<GraphStore["getSymbols"]>>): Map<string, Awaited<ReturnType<GraphStore["getSymbols"]>>> {
  const byFile = new Map<string, Awaited<ReturnType<GraphStore["getSymbols"]>>>();
  for (const symbol of symbols) {
    const current = byFile.get(symbol.filePath) ?? [];
    current.push(symbol);
    byFile.set(symbol.filePath, current);
  }
  return byFile;
}

function testSubjectName(filePath: string): string | undefined {
  const base = filePath.split("/").pop()?.replace(/\.[jt]sx?$/, "") ?? "";
  return base.replace(/\.(test|spec)$/i, "") || undefined;
}

function fileSubjectName(filePath: string): string | undefined {
  const base = filePath.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "";
  return base || undefined;
}

function defaultExpansionCandidateCount(limit: number | undefined): number {
  return Math.min(12, Math.max(8, (limit ?? 8) + 4));
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
