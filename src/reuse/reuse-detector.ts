import type {
  CodeChunk,
  ContextSnippet,
  GraphEdge,
  OwnerCandidate,
  ReuseCandidate,
  ReuseCandidateKind,
  ReuseCandidateReport,
  SearchHit,
  SymbolNode
} from "../core/types.js";
import { renderSnippet } from "../context/snippet-renderer.js";

export interface ReuseDetectorInput {
  query: string;
  hits: SearchHit[];
  owners: OwnerCandidate[];
  symbols: SymbolNode[];
  edges: GraphEdge[];
  chunks: CodeChunk[];
  limit?: number;
}

interface CandidateDraft {
  filePath: string;
  symbolName?: string;
  symbol?: SymbolNode;
  score: number;
  exported: boolean;
  reasons: string[];
  snippets: SearchHit[];
}

export function buildReuseCandidateReport(input: ReuseDetectorInput): ReuseCandidateReport {
  const limit = input.limit ?? 8;
  const drafts = new Map<string, CandidateDraft>();
  const symbolsById = new Map(input.symbols.map((symbol) => [symbol.id, symbol]));
  const expandedTerms = expandedQueryTerms(input.query);

  for (const hit of input.hits) {
    addDraft(drafts, {
      filePath: hit.chunk.filePath,
      symbolName: hit.chunk.symbolName,
      score: Math.max(0.1, hit.score * 2),
      reason: hit.reason,
      hit
    });
  }

  for (const owner of input.owners) {
    const ownerSymbols = owner.symbols.length > 0 ? owner.symbols : input.symbols.filter((symbol) => symbol.filePath === owner.filePath && symbol.kind !== "file").slice(0, 2);
    if (ownerSymbols.length === 0) {
      addDraft(drafts, {
        filePath: owner.filePath,
        score: owner.score,
        reason: owner.reasons.join("; ")
      });
      continue;
    }
    for (const symbol of ownerSymbols) {
      addDraft(drafts, {
        filePath: symbol.filePath,
        symbolName: symbol.name,
        symbol,
        score: owner.score + 0.5,
        reason: `Owner candidate: ${owner.reasons.join("; ")}`
      });
    }
  }

  for (const symbol of input.symbols) {
    if (symbol.kind === "file") continue;
    const matchScore = symbolSimilarity(symbol, expandedTerms);
    if (matchScore <= 0) continue;
    addDraft(drafts, {
      filePath: symbol.filePath,
      symbolName: symbol.name,
      symbol,
      score: matchScore,
      reason: `Symbol/API similarity to query terms: ${symbol.name}`
    });
  }

  const candidates = [...drafts.values()]
    .map((draft) => finalizeCandidate(draft, input.edges, input.chunks, symbolsById, input.query))
    .sort((a, b) => b.score - a.score || a.filePath.localeCompare(b.filePath))
    .slice(0, limit);

  const decision = decisionFor(candidates);
  const confidence = reportConfidence(candidates);
  const duplicateRisk = duplicateRiskFor(candidates);
  const missingEvidence = missingEvidenceFor(candidates);

  return {
    query: input.query,
    decision,
    confidence,
    candidates,
    duplicateRisk,
    missingEvidence,
    nextQueries: nextQueriesFor(candidates)
  };
}

function addDraft(drafts: Map<string, CandidateDraft>, input: {
  filePath: string;
  symbolName?: string;
  symbol?: SymbolNode;
  score: number;
  reason: string;
  hit?: SearchHit;
}): void {
  const key = `${input.filePath}:${input.symbolName ?? "__file__"}`;
  const current = drafts.get(key) ?? {
    filePath: input.filePath,
    symbolName: input.symbolName,
    symbol: input.symbol,
    score: 0,
    exported: Boolean(input.symbol?.exported),
    reasons: [],
    snippets: []
  };
  current.score += input.score;
  current.symbol = current.symbol ?? input.symbol;
  current.exported = current.exported || Boolean(input.symbol?.exported);
  current.reasons.push(input.reason);
  if (input.hit) current.snippets.push(input.hit);
  drafts.set(key, current);
}

function finalizeCandidate(
  draft: CandidateDraft,
  edges: GraphEdge[],
  chunks: CodeChunk[],
  symbolsById: Map<string, SymbolNode>,
  query: string
): ReuseCandidate {
  const symbolId = draft.symbol?.id;
  const callerCount = symbolId ? edges.filter((edge) => edge.targetId === symbolId && edge.kind === "calls").length : 0;
  const relatedTestCount = symbolId ? edges.filter((edge) => edge.sourceId === symbolId && edge.kind === "tested_by").length : 0;
  const score = draft.score
    + (draft.exported ? 1.2 : 0)
    + Math.min(2, callerCount * 0.4)
    + Math.min(1.5, relatedTestCount * 0.8);
  const kind = candidateKind(draft);
  const snippet = candidateSnippet(draft, chunks, query);
  const confidence = score >= 3.5 ? "high" : score >= 2 ? "medium" : "low";
  const whyReuse = [
    draft.exported ? "Exported/public symbol is available to call or wrap." : "Candidate is private; prefer extending nearby code before creating a duplicate.",
    callerCount > 0 ? `${callerCount} indexed caller(s) already depend on it.` : "No indexed callers were found.",
    relatedTestCount > 0 ? `${relatedTestCount} related test edge(s) cover it.` : "No explicit tested_by edge was found."
  ];

  return {
    filePath: draft.filePath,
    symbolName: draft.symbolName,
    kind,
    score: Number(score.toFixed(3)),
    confidence,
    exported: draft.exported,
    callerCount,
    relatedTestCount,
    reasons: [...new Set(draft.reasons)].slice(0, 6),
    whyReuse,
    snippet
  };
}

function candidateSnippet(draft: CandidateDraft, chunks: CodeChunk[], query: string): ContextSnippet | undefined {
  const hit = draft.snippets.sort((a, b) => b.score - a.score)[0];
  if (hit) return renderSnippet(hit, query, "review");
  const chunk = chunks.find((item) => item.filePath === draft.filePath && item.symbolName === draft.symbolName)
    ?? chunks.find((item) => item.filePath === draft.filePath);
  if (!chunk) return undefined;
  return renderSnippet({
    chunk,
    score: draft.score,
    source: "graph",
    reason: `Reuse candidate ${draft.symbolName ?? draft.filePath}`
  }, query, "review");
}

function candidateKind(draft: CandidateDraft): ReuseCandidateKind {
  const symbol = draft.symbolName ?? "";
  const file = draft.filePath;
  if (/(^|\/)(__tests__|tests?)(\/|$)|\.(test|spec)\.[jt]sx?$/.test(file)) return "test_fixture";
  if (/\.tsx?$/.test(file) && /^use[A-Z]/.test(symbol)) return "react_hook";
  if (/\.tsx$/.test(file) && /^[A-Z]/.test(symbol)) return "component";
  if (/api|client|sdk|fetch/i.test(file) || /api|client|fetch/i.test(symbol)) return "api_wrapper";
  if (draft.symbol?.kind === "type" || /schema|type|interface/i.test(file)) return "type_or_schema";
  if (/config|constant|env/i.test(file) || /^[A-Z0-9_]+$/.test(symbol)) return "config_constant";
  if (/service|billing|repo|repository/i.test(file) || draft.symbol?.kind === "method") return "service_method";
  if (draft.symbol?.kind === "function") return "helper";
  return "unknown";
}

function expandedQueryTerms(query: string): string[] {
  const base = tokenize(query);
  const expanded = new Set(base);
  const text = query.toLowerCase();
  if (/rate[-\s]?limit|limiting|throttle/.test(text)) {
    for (const term of ["rate", "limit", "limiter", "throttle", "throttlerequest", "token", "bucket", "tokenbucket"]) expanded.add(term);
  }
  if (/payment|billing|checkout/.test(text)) {
    for (const term of ["payment", "billing", "checkout", "charge", "invoice"]) expanded.add(term);
  }
  if (/auth|login|session/.test(text)) {
    for (const term of ["auth", "login", "session", "user"]) expanded.add(term);
  }
  return [...expanded];
}

function symbolSimilarity(symbol: SymbolNode, terms: string[]): number {
  const haystack = `${symbol.name} ${splitIdentifier(symbol.name).join(" ")} ${symbol.filePath} ${symbol.signature ?? ""}`.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (haystack.includes(term)) score += Math.min(1.2, term.length / 5);
  }
  if (symbol.exported) score += 0.5;
  return score;
}

function decisionFor(candidates: ReuseCandidate[]): ReuseCandidateReport["decision"] {
  const top = candidates[0];
  if (!top) return "implement_new";
  if (top.confidence === "high" && top.exported) return "reuse";
  if (top.confidence === "high") return "extend";
  if (top.confidence === "medium" && top.exported) return "wrap";
  return "uncertain";
}

function reportConfidence(candidates: ReuseCandidate[]): ReuseCandidateReport["confidence"] {
  const top = candidates[0];
  if (!top) return "low";
  return top.confidence;
}

function duplicateRiskFor(candidates: ReuseCandidate[]): ReuseCandidateReport["duplicateRisk"] {
  if (candidates.length === 0) return "low";
  const top = candidates[0]!;
  const close = candidates.slice(1).filter((candidate) => top.score - candidate.score < 1).length;
  if (top.confidence === "high" || close >= 2) return "high";
  if (top.confidence === "medium" || candidates.length > 1) return "medium";
  return "low";
}

function missingEvidenceFor(candidates: ReuseCandidate[]): string[] {
  if (candidates.length === 0) return ["No indexed reusable candidate matched the request."];
  const missing: string[] = [];
  if (!candidates.some((candidate) => candidate.exported)) missing.push("No exported reusable candidate was found.");
  if (!candidates.some((candidate) => candidate.relatedTestCount > 0)) missing.push("No candidate has explicit tested_by evidence.");
  return missing;
}

function nextQueriesFor(candidates: ReuseCandidate[]): string[] {
  return candidates.slice(0, 5).flatMap((candidate) => {
    const nodeRef = `${candidate.filePath}${candidate.symbolName ? `:${candidate.symbolName}` : ""}`;
    return [`expand_node ${nodeRef}`, `explain_impact ${nodeRef}`];
  }).slice(0, 8);
}

function tokenize(query: string): string[] {
  return query.toLowerCase().split(/[^a-z0-9_]+/i).map((part) => part.trim()).filter(Boolean);
}

function splitIdentifier(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^a-z0-9]+/i)
    .map((part) => part.toLowerCase())
    .filter(Boolean);
}
