import type { OwnerCandidate } from "../core/types.js";
import type { SearchHit, SymbolNode } from "../core/types.js";
import { isExplicitTestQuery, isTestPath } from "../retrieval/path-classification.js";
import { splitIdentifier, type TextMatchScore } from "../retrieval/query-matching.js";

const DEFAULT_TEST_OWNER_MULTIPLIER = 0.55;
const TEST_OWNER_CEILING_RATIO = 0.95;
const EXPLICIT_TEST_OWNER_BOOST = 1;
const CHUNK_TOP_K = 4;
const CHUNK_PILE_LOG_BONUS = 0.1;
const SYMBOL_TOP_K = 4;
const SYMBOL_PILE_LOG_BONUS = 0.1;
const EXACT_IDENTIFIER_BOOST = 3.5;
const EXACT_SYMBOL_NAME_BOOST = 5;
const ENTRYPOINT_OWNER_BOOST = 0.5;

export interface OwnerSymbolMatch {
  symbol: SymbolNode;
  match: TextMatchScore;
}

export interface OwnerRankInput {
  hits: SearchHit[];
  query: string;
  symbolMatches: OwnerSymbolMatch[];
}

interface OwnerDraft {
  filePath: string;
  chunkHits: Array<{ score: number; reason: string }>;
  exactIdentifiers: Set<string>;
  symbolMatches: OwnerSymbolMatch[];
}

export function rankOwnerCandidates(input: OwnerRankInput): OwnerCandidate[] {
  const drafts = new Map<string, OwnerDraft>();
  const queryIdentifiers = exactQueryIdentifiers(input.query);
  for (const hit of input.hits) {
    const draft = ensureDraft(drafts, hit.chunk.filePath);
    draft.chunkHits.push({ score: hit.score, reason: hit.reason });
    addExactIdentifierMatches(draft, queryIdentifiers, [
      hit.chunk.filePath,
      hit.chunk.symbolName,
      hit.chunk.content
    ]);
  }

  for (const symbolMatch of input.symbolMatches) {
    const draft = ensureDraft(drafts, symbolMatch.symbol.filePath);
    draft.symbolMatches.push(symbolMatch);
    addExactIdentifierMatches(draft, queryIdentifiers, [
      symbolMatch.symbol.filePath,
      symbolMatch.symbol.name,
      symbolMatch.symbol.signature
    ]);
  }

  const candidates = [...drafts.values()].map((draft) => finalizeOwnerDraft(draft, queryIdentifiers));
  return applyOwnerPathIntent(candidates, input.query).sort((a, b) => b.score - a.score);
}

function ensureDraft(drafts: Map<string, OwnerDraft>, filePath: string): OwnerDraft {
  const existing = drafts.get(filePath);
  if (existing) return existing;
  const draft: OwnerDraft = { filePath, chunkHits: [], exactIdentifiers: new Set(), symbolMatches: [] };
  drafts.set(filePath, draft);
  return draft;
}

function finalizeOwnerDraft(draft: OwnerDraft, queryIdentifiers: Set<string>): OwnerCandidate {
  const sortedChunkHits = [...draft.chunkHits].sort((a, b) => b.score - a.score);
  const topChunkHits = sortedChunkHits.slice(0, CHUNK_TOP_K);
  const chunkScore = topChunkHits.reduce((sum, hit, index) => sum + hit.score * Math.pow(0.5, index), 0);
  const chunkOverflowCount = Math.max(0, sortedChunkHits.length - topChunkHits.length);
  const chunkOverflowBonus = chunkOverflowCount > 0 ? Math.log1p(chunkOverflowCount) * CHUNK_PILE_LOG_BONUS : 0;
  const sortedSymbolMatches = [...draft.symbolMatches].sort((a, b) => symbolMatchScore(b) - symbolMatchScore(a));
  const topSymbols = sortedSymbolMatches.slice(0, SYMBOL_TOP_K);
  const symbolScore = topSymbols.reduce((sum, item, index) => sum + symbolMatchScore(item) * Math.pow(0.5, index), 0);
  const symbolOverflowCount = Math.max(0, sortedSymbolMatches.length - topSymbols.length);
  const symbolOverflowBonus = symbolOverflowCount > 0 ? Math.log1p(symbolOverflowCount) * SYMBOL_PILE_LOG_BONUS : 0;
  const exactIdentifiers = [...draft.exactIdentifiers].sort();
  const exactBoost = Math.pow(exactIdentifiers.length, 2) * EXACT_IDENTIFIER_BOOST;
  const exactSymbolNames = sortedSymbolMatches
    .filter(({ symbol }) => queryIdentifiers.has(normalizeExactIdentifier(symbol.name)))
    .map(({ symbol }) => symbol.name);
  const exactSymbolBoost = exactSymbolNames.length * EXACT_SYMBOL_NAME_BOOST;
  const entrypointBoost = isEntrypointPath(draft.filePath) ? ENTRYPOINT_OWNER_BOOST : 0;
  const score = chunkScore + chunkOverflowBonus + symbolScore + symbolOverflowBonus + exactBoost + exactSymbolBoost + entrypointBoost;
  const reasons = [
    ...topChunkHits.map((hit, index) => `${hit.reason} (+${(hit.score * Math.pow(0.5, index)).toFixed(2)} saturated chunk rank ${index + 1})`),
    ...(chunkOverflowCount > 0 ? [`chunk pile normalization: capped ${sortedChunkHits.length} text matches to top ${CHUNK_TOP_K} plus log bonus +${chunkOverflowBonus.toFixed(2)}`] : []),
    ...topSymbols.map(({ match, symbol }, index) => `${match.reason} (+${(symbolMatchScore({ match, symbol }) * Math.pow(0.5, index)).toFixed(2)} saturated symbol rank ${index + 1})`),
    ...(symbolOverflowCount > 0 ? [`symbol pile normalization: capped ${sortedSymbolMatches.length} symbol matches to top ${SYMBOL_TOP_K} plus log bonus +${symbolOverflowBonus.toFixed(2)}`] : []),
    ...(exactIdentifiers.length > 0 ? [`exact identifier owner boost (+${exactBoost.toFixed(2)}): ${exactIdentifiers.join(", ")}`] : []),
    ...(exactSymbolNames.length > 0 ? [`exact symbol-name owner boost (+${exactSymbolBoost.toFixed(2)}): ${exactSymbolNames.join(", ")}`] : []),
    ...(entrypointBoost > 0 ? [`entrypoint owner boost (+${ENTRYPOINT_OWNER_BOOST.toFixed(2)}): index file`] : [])
  ];

  return {
    filePath: draft.filePath,
    score,
    reasons: [...new Set(reasons)],
    symbols: uniqueSymbols(sortedSymbolMatches.map(({ symbol }) => symbol))
  };
}

function symbolMatchScore(match: OwnerSymbolMatch): number {
  return 1 + match.match.score;
}

function exactQueryIdentifiers(query: string): Set<string> {
  const identifiers = new Set<string>();
  for (const rawPart of query.split(/[^a-z0-9_./:-]+/i)) {
    const part = rawPart.trim();
    if (!part) continue;
    if (isSpecificIdentifier(part)) identifiers.add(normalizeExactIdentifier(part));
  }
  return identifiers;
}

function addExactIdentifierMatches(draft: OwnerDraft, queryIdentifiers: Set<string>, parts: Array<string | undefined>): void {
  const text = parts.filter(Boolean).join("\n").toLowerCase();
  for (const identifier of queryIdentifiers) {
    if (text.includes(identifier)) draft.exactIdentifiers.add(identifier);
  }
}

function isSpecificIdentifier(value: string): boolean {
  if (/[._/:-]/.test(value)) return value.length >= 8;
  if (value.length < 5) return false;
  return splitIdentifier(value).length >= 2 || /[A-Z]/.test(value);
}

function normalizeExactIdentifier(value: string): string {
  return value.toLowerCase();
}

function isEntrypointPath(filePath: string): boolean {
  return /(^|\/)index\.[cm]?[jt]sx?$/.test(filePath.replaceAll("\\", "/").toLowerCase());
}

function uniqueSymbols(symbols: SymbolNode[]): SymbolNode[] {
  return [...new Map(symbols.map((symbol) => [symbol.id, symbol])).values()];
}

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
