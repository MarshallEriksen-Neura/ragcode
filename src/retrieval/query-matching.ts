import snowball from "snowball-stemmers";
import type { CodeChunk, SymbolNode } from "../core/types.js";

const englishStemmer = snowball.newStemmer("english");

export interface QueryMatchProfile {
  queryTerms: string[];
  queryTermVariants: string[];
  expandedTerms: string[];
  expandedSymbolNames: string[];
  ftsTerms: string[];
}

export interface TextMatchScore {
  score: number;
  matchedQueryTerms: number;
  matchedExpandedTerms: number;
  matchedSymbolName?: string;
  reason: string;
}

export function buildQueryMatchProfile(query: string, symbols: SymbolNode[] = []): QueryMatchProfile {
  const queryTerms = tokenizeQuery(query);
  const queryTermVariants = expandTermVariants(queryTerms);
  const expandedSymbolNames = matchingSymbolNames(queryTermVariants, symbols);
  const expandedTerms = [...new Set(expandedSymbolNames.map(normalizeIdentifier).filter(Boolean))];
  return {
    queryTerms,
    queryTermVariants,
    expandedTerms,
    expandedSymbolNames,
    ftsTerms: [...new Set([...queryTerms, ...expandedTerms])]
  };
}

export function scoreChunkText(chunk: CodeChunk, profile: QueryMatchProfile): TextMatchScore | undefined {
  const text = searchableChunkText(chunk);
  const matchedQueryTerms = countQueryTermMatches(text, profile.queryTerms);
  const matchedExpandedTerms = countMatches(text, profile.expandedTerms);
  const symbolScore = chunk.symbolName ? scoreSymbolName(chunk.symbolName, profile.queryTermVariants) : undefined;
  if (matchedQueryTerms === 0 && matchedExpandedTerms === 0 && !symbolScore) return undefined;

  const queryCoverage = profile.queryTerms.length > 0 ? matchedQueryTerms / profile.queryTerms.length : 0;
  const expansionScore = Math.min(0.45, matchedExpandedTerms * 0.15);
  const symbolBoost = symbolScore ? 0.85 * symbolScore.coverage : 0;
  const reasons = [`Matched ${matchedQueryTerms}/${profile.queryTerms.length} query term(s)`];
  if (symbolScore) reasons.push(`symbol expansion matched ${symbolScore.name}`);
  else if (matchedExpandedTerms > 0) reasons.push(`matched ${matchedExpandedTerms} expanded symbol term(s)`);

  return {
    score: queryCoverage + expansionScore + symbolBoost,
    matchedQueryTerms,
    matchedExpandedTerms,
    matchedSymbolName: symbolScore?.name,
    reason: reasons.join("; ")
  };
}

export function scoreSymbolText(symbol: SymbolNode, profile: QueryMatchProfile): TextMatchScore | undefined {
  const text = searchableSymbolText(symbol);
  const matchedQueryTerms = countQueryTermMatches(text, profile.queryTerms);
  const matchedExpandedTerms = countMatches(text, profile.expandedTerms);
  const symbolScore = scoreSymbolName(symbol.name, profile.queryTermVariants);
  if (matchedQueryTerms === 0 && matchedExpandedTerms === 0 && !symbolScore) return undefined;

  const queryCoverage = profile.queryTerms.length > 0 ? matchedQueryTerms / profile.queryTerms.length : 0;
  const symbolBoost = symbolScore ? 1.2 * symbolScore.coverage : 0;
  const expansionScore = Math.min(0.4, matchedExpandedTerms * 0.15);
  return {
    score: queryCoverage + symbolBoost + expansionScore,
    matchedQueryTerms,
    matchedExpandedTerms,
    matchedSymbolName: symbolScore?.name,
    reason: symbolScore ? `Symbol expansion match: ${symbol.name}` : `Symbol match: ${symbol.name}`
  };
}

export function tokenizeQuery(query: string): string[] {
  const tokens: string[] = [];
  for (const rawPart of query.split(/[^a-z0-9_./:-]+/i)) {
    const part = rawPart.trim();
    if (!part) continue;
    tokens.push(part.toLowerCase());
    if (isCamelOrPascalIdentifier(part)) tokens.push(...splitIdentifier(part));
  }
  return [...new Set(tokens)];
}

export function splitIdentifier(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^a-z0-9]+/i)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

export function normalizeIdentifier(value: string): string {
  return splitIdentifier(value).join("");
}

function isCamelOrPascalIdentifier(value: string): boolean {
  return !/[._/:-]/.test(value) && /(?:[a-z0-9][A-Z]|[A-Z]{2,}[a-z])/.test(value);
}

function searchableChunkText(chunk: CodeChunk): string {
  return searchableText([chunk.filePath, chunk.symbolName, chunk.content]);
}

function searchableSymbolText(symbol: SymbolNode): string {
  return searchableText([symbol.name, symbol.filePath, symbol.signature]);
}

function searchableText(parts: Array<string | undefined>): string {
  const raw = parts.filter(Boolean).join("\n");
  return `${raw}\n${splitIdentifier(raw).join(" ")}`.toLowerCase();
}

function matchingSymbolNames(queryTermVariants: string[], symbols: SymbolNode[]): string[] {
  const queryTerms = new Set(queryTermVariants);
  const matches: Array<{ name: string; score: number }> = [];
  for (const symbol of symbols) {
    if (symbol.kind === "file") continue;
    const parts = splitIdentifier(symbol.name);
    if (parts.length < 2) continue;
    const variants = parts.map((part) => expandTermVariants([part]));
    const matchedParts = variants.filter((partVariants) => partVariants.some((part) => queryTerms.has(part))).length;
    const requiredParts = Math.min(2, parts.length);
    if (matchedParts < requiredParts) continue;
    matches.push({ name: symbol.name, score: matchedParts / parts.length });
  }
  return [...new Map(matches
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, 48)
    .map((match) => [match.name, match.name])).values()];
}

function scoreSymbolName(name: string, queryTermVariants: string[]): { name: string; coverage: number } | undefined {
  const queryTerms = new Set(queryTermVariants);
  const parts = splitIdentifier(name);
  if (parts.length < 2) return undefined;
  const matchedParts = parts.filter((part) => expandTermVariants([part]).some((variant) => queryTerms.has(variant))).length;
  const requiredParts = Math.min(2, parts.length);
  if (matchedParts < requiredParts) return undefined;
  return { name, coverage: matchedParts / parts.length };
}

function expandTermVariants(terms: string[]): string[] {
  const variants = new Set<string>();
  for (const term of terms) {
    variants.add(term);
    const stem = stemTerm(term);
    if (stem && stem !== term) variants.add(stem);
  }
  return [...variants];
}

function stemTerm(term: string): string | undefined {
  if (!/^[a-z]+$/i.test(term)) return undefined;
  return englishStemmer.stem(term.toLowerCase());
}

function countMatches(text: string, terms: string[]): number {
  let count = 0;
  for (const term of terms) {
    if (term && text.includes(term)) count += 1;
  }
  return count;
}

function countQueryTermMatches(text: string, terms: string[]): number {
  let count = 0;
  for (const term of terms) {
    if (expandTermVariants([term]).some((variant) => text.includes(variant))) count += 1;
  }
  return count;
}
