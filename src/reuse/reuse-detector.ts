import ts from "typescript";
import type {
  CodeChunk,
  ContextSnippet,
  GraphEdge,
  OwnerCandidate,
  ReuseCandidate,
  ReuseCandidateKind,
  ReuseCandidateReport,
  ReuseGuard,
  SearchHit,
  SymbolNode
} from "../core/types.js";
import { renderSnippet } from "../context/snippet-renderer.js";
import { sha256 } from "../utils/hash.js";

export interface ReuseDetectorInput {
  query: string;
  hits: SearchHit[];
  owners: OwnerCandidate[];
  symbols: SymbolNode[];
  edges: GraphEdge[];
  chunks: CodeChunk[];
  limit?: number;
  reuseGuard?: boolean;
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

interface SymbolStructure {
  symbol: SymbolNode;
  chunk?: CodeChunk;
  bodyFingerprint?: string;
  duplicateCount: number;
  signatureTokens: Set<string>;
  imports: Set<string>;
  callees: Set<string>;
  signatureSimilarity: number;
  importOverlap: number;
  calleeOverlap: number;
}

interface StructureIndex {
  bySymbolId: Map<string, SymbolStructure>;
  byFingerprint: Map<string, SymbolStructure[]>;
}

export function buildReuseCandidateReport(input: ReuseDetectorInput): ReuseCandidateReport {
  const limit = input.limit ?? 8;
  const drafts = new Map<string, CandidateDraft>();
  const symbolsById = new Map(input.symbols.map((symbol) => [symbol.id, symbol]));
  const expandedTerms = expandedQueryTerms(input.query);
  const structureIndex = buildStructureIndex(input.symbols, input.edges, input.chunks, symbolsById);

  for (const hit of input.hits) {
    const symbol = symbolForHit(hit, input.symbols);
    addDraft(drafts, {
      filePath: hit.chunk.filePath,
      symbolName: hit.chunk.symbolName,
      symbol,
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

  expandStructuralDuplicates(drafts, structureIndex);

  const candidates = [...drafts.values()]
    .map((draft) => finalizeCandidate(draft, input.edges, input.chunks, symbolsById, input.query, structureIndex))
    .sort((a, b) => b.score - a.score || a.filePath.localeCompare(b.filePath))
    .slice(0, limit);

  const decision = decisionFor(candidates);
  const confidence = reportConfidence(candidates);
  const duplicateRisk = duplicateRiskFor(candidates);
  const reuseGuard = reuseGuardFor(candidates, Boolean(input.reuseGuard));
  const missingEvidence = missingEvidenceFor(candidates);

  return {
    query: input.query,
    decision,
    confidence,
    candidates,
    duplicateRisk,
    reuseGuard,
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
  query: string,
  structureIndex: StructureIndex
): ReuseCandidate {
  const symbolId = draft.symbol?.id;
  const callerCount = symbolId ? edges.filter((edge) => edge.targetId === symbolId && edge.kind === "calls").length : 0;
  const relatedTestCount = symbolId ? edges.filter((edge) => edge.sourceId === symbolId && edge.kind === "tested_by").length : 0;
  const structure = symbolId ? structureIndex.bySymbolId.get(symbolId) : undefined;
  const structuralSignals = structuralSignalsFor(structure);
  const structuralScore = structuralScoreFor(structuralSignals);
  const score = draft.score
    + (draft.exported ? 1.2 : 0)
    + Math.min(2, callerCount * 0.4)
    + Math.min(1.5, relatedTestCount * 0.8)
    + structuralScore;
  const kind = candidateKind(draft);
  const snippet = candidateSnippet(draft, chunks, query);
  const confidence = score >= 3.5 ? "high" : score >= 2 ? "medium" : "low";
  const whyReuse = [
    draft.exported ? "Exported/public symbol is available to call or wrap." : "Candidate is private; prefer extending nearby code before creating a duplicate.",
    callerCount > 0 ? `${callerCount} indexed caller(s) already depend on it.` : "No indexed callers were found.",
    relatedTestCount > 0 ? `${relatedTestCount} related test edge(s) cover it.` : "No explicit tested_by edge was found.",
    ...whyReuseFromStructure(structuralSignals)
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
    structuralSignals,
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
  if (candidates.some((candidate) => candidate.structuralSignals.bodyDuplicateCount > 0 && candidate.confidence === "high")) return "high";
  if (top.confidence === "high" || close >= 2) return "high";
  if (top.confidence === "medium" || candidates.length > 1) return "medium";
  return "low";
}

function reuseGuardFor(candidates: ReuseCandidate[], enabled: boolean): ReuseGuard {
  const structuralBlockers = candidates
    .filter((candidate) => candidate.exported && candidate.confidence === "high" && candidate.structuralSignals.bodyDuplicateCount > 0)
    .slice(0, 5);
  if (structuralBlockers.length > 0) {
    return {
      status: enabled ? "block_new" : "review_required",
      reason: enabled
        ? "reuse_guard is enabled and high-confidence normalized duplicate implementations already exist. Reuse or extend them instead of implementing a new copy."
        : "High-confidence normalized duplicate implementations already exist; enable reuseGuard to hard block new duplicate work.",
      candidates: guardCandidates(structuralBlockers)
    };
  }

  const highReuse = candidates.filter((candidate) => candidate.exported && candidate.confidence === "high").slice(0, 5);
  if (!enabled && highReuse.length > 0) {
    return {
      status: "review_required",
      reason: "High-confidence reusable candidates exist. Review them before implementing new code.",
      candidates: guardCandidates(highReuse)
    };
  }

  return {
    status: "allow_new",
    reason: enabled ? "No high-confidence structural duplicate blocks new implementation." : "No reuse guard blockers were found.",
    candidates: []
  };
}

function guardCandidates(candidates: ReuseCandidate[]): ReuseGuard["candidates"] {
  return candidates.map((candidate) => ({
    filePath: candidate.filePath,
    symbolName: candidate.symbolName,
    score: candidate.score,
    confidence: candidate.confidence
  }));
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

function symbolForHit(hit: SearchHit, symbols: SymbolNode[]): SymbolNode | undefined {
  if (!hit.chunk.symbolName) return undefined;
  return symbols.find((symbol) => symbol.filePath === hit.chunk.filePath && symbol.name === hit.chunk.symbolName);
}

function expandStructuralDuplicates(drafts: Map<string, CandidateDraft>, structureIndex: StructureIndex): void {
  const initialDrafts = [...drafts.values()];
  for (const draft of initialDrafts) {
    if (!draft.symbol) continue;
    const structure = structureIndex.bySymbolId.get(draft.symbol.id);
    if (!structure?.bodyFingerprint) continue;
    const duplicates = structureIndex.byFingerprint.get(structure.bodyFingerprint) ?? [];
    for (const duplicate of duplicates) {
      if (duplicate.symbol.id === draft.symbol.id) continue;
      addDraft(drafts, {
        filePath: duplicate.symbol.filePath,
        symbolName: duplicate.symbol.name,
        symbol: duplicate.symbol,
        score: Math.max(1.5, draft.score * 0.6),
        reason: `Normalized body fingerprint matches ${draft.symbol.name}.`
      });
    }
  }
}

function buildStructureIndex(symbols: SymbolNode[], edges: GraphEdge[], chunks: CodeChunk[], symbolsById: Map<string, SymbolNode>): StructureIndex {
  const bySymbolId = new Map<string, SymbolStructure>();
  const byFingerprint = new Map<string, SymbolStructure[]>();

  // Pre-group chunks/edges once so each symbol's structure lookup scans only its own
  // file slice instead of the full arrays. Turns the former O(symbols × (chunks + edges))
  // into O(chunks + edges + symbols), which matters on large repos.
  const chunksByFile = groupBy(chunks, (chunk) => chunk.filePath);
  const importEdgesByFile = new Map<string, GraphEdge[]>();
  const callEdgesByFile = new Map<string, GraphEdge[]>();
  const callEdgesBySourceId = new Map<string, GraphEdge[]>();
  for (const edge of edges) {
    if (edge.kind === "imports") {
      const sourceFile = stringMetadata(edge, "sourceFile");
      if (sourceFile) pushToGroup(importEdgesByFile, sourceFile, edge);
    } else if (edge.kind === "calls") {
      const sourceFile = stringMetadata(edge, "sourceFile");
      if (sourceFile) pushToGroup(callEdgesByFile, sourceFile, edge);
      pushToGroup(callEdgesBySourceId, edge.sourceId, edge);
    }
  }

  for (const symbol of symbols) {
    if (symbol.kind === "file") continue;
    const chunk = chunkForSymbol(symbol, chunksByFile.get(symbol.filePath) ?? []);
    const bodyFingerprint = chunk ? normalizedBodyFingerprint(chunk) : undefined;
    const structure: SymbolStructure = {
      symbol,
      chunk,
      bodyFingerprint,
      duplicateCount: 0,
      signatureTokens: normalizedSignatureTokens(symbol.signature ?? ""),
      imports: importsForSymbol(importEdgesByFile.get(symbol.filePath) ?? []),
      callees: calleesForSymbol(symbol, callEdgesByFile.get(symbol.filePath) ?? [], callEdgesBySourceId.get(symbol.id) ?? [], symbolsById),
      signatureSimilarity: 0,
      importOverlap: 0,
      calleeOverlap: 0
    };
    bySymbolId.set(symbol.id, structure);
    if (bodyFingerprint) {
      const group = byFingerprint.get(bodyFingerprint) ?? [];
      group.push(structure);
      byFingerprint.set(bodyFingerprint, group);
    }
  }

  for (const group of byFingerprint.values()) {
    if (group.length < 2) continue;
    // Pairwise similarity inside one fingerprint group is O(group²); a degenerate group
    // (thousands of same-shaped boilerplate functions) made this pass take ~40s. Cap each
    // structure's comparison pool to a fixed window so the pass stays linear in group size.
    // For oversized groups the signals become a sampled lower bound — acceptable, because a
    // shape shared by hundreds of functions is boilerplate, not a meaningful reuse target.
    const pool = group.length > FINGERPRINT_COMPARISON_WINDOW + 1
      ? group.slice(0, FINGERPRINT_COMPARISON_WINDOW + 1)
      : group;
    for (const structure of group) {
      const others = pool.filter((candidate) => candidate.symbol.id !== structure.symbol.id);
      // A shared body fingerprint over-matches on its own: identifiers and literals are
      // normalized away, so e.g. `enable(id)` and `remove(id)` collapse to one shape.
      // Require callee overlap (Jaccard >= 0.5) so only behavioral copies — not every
      // same-shaped function — count as duplicates and can trip reuseGuard.
      const confirmedDuplicates = others.filter((candidate) => jaccard(structure.callees, candidate.callees) >= 0.5);
      structure.duplicateCount = confirmedDuplicates.length;
      structure.signatureSimilarity = maxSimilarity(structure.signatureTokens, others.map((candidate) => candidate.signatureTokens));
      structure.importOverlap = maxSimilarity(structure.imports, others.map((candidate) => candidate.imports));
      structure.calleeOverlap = maxSimilarity(structure.callees, others.map((candidate) => candidate.callees));
    }
  }

  return { bySymbolId, byFingerprint };
}

function groupBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) pushToGroup(groups, keyOf(item), item);
  return groups;
}

function pushToGroup<T>(groups: Map<string, T[]>, key: string, item: T): void {
  const group = groups.get(key);
  if (group) group.push(item);
  else groups.set(key, [item]);
}

function chunkForSymbol(symbol: SymbolNode, fileChunks: CodeChunk[]): CodeChunk | undefined {
  return fileChunks.find((chunk) => chunk.symbolName === symbol.name)
    ?? fileChunks.find((chunk) => chunk.startLine <= symbol.startLine && chunk.endLine >= symbol.endLine);
}

function importsForSymbol(fileImportEdges: GraphEdge[]): Set<string> {
  const imports = new Set<string>();
  for (const edge of fileImportEdges) {
    const source = stringMetadata(edge, "source");
    if (source) imports.add(source);
    const bindings = edge.metadata?.bindings;
    if (Array.isArray(bindings)) {
      for (const binding of bindings) {
        if (!binding || typeof binding !== "object") continue;
        const record = binding as Record<string, unknown>;
        if (typeof record.imported === "string") imports.add(record.imported);
        if (typeof record.local === "string") imports.add(record.local);
      }
    }
  }
  return imports;
}

function calleesForSymbol(symbol: SymbolNode, fileCallEdges: GraphEdge[], sourceIdCallEdges: GraphEdge[], symbolsById: Map<string, SymbolNode>): Set<string> {
  const callees = new Set<string>();
  const addCallee = (edge: GraphEdge): void => {
    const targetName = stringMetadata(edge, "targetName") ?? symbolsById.get(edge.targetId)?.name;
    if (targetName) callees.add(targetName);
  };
  // sourceId match: the edge's source IS this symbol, regardless of line metadata.
  for (const edge of sourceIdCallEdges) addCallee(edge);
  // file + line-range match: unresolved calls located only by file/line.
  for (const edge of fileCallEdges) {
    const line = numberMetadata(edge, "line");
    if (line !== undefined && line >= symbol.startLine && line <= symbol.endLine) addCallee(edge);
  }
  return callees;
}

function structuralSignalsFor(structure: SymbolStructure | undefined): ReuseCandidate["structuralSignals"] {
  return {
    bodyFingerprint: structure?.bodyFingerprint,
    bodyDuplicateCount: structure?.duplicateCount ?? 0,
    signatureSimilarity: roundSignal(structure?.signatureSimilarity ?? 0),
    importOverlap: roundSignal(structure?.importOverlap ?? 0),
    calleeOverlap: roundSignal(structure?.calleeOverlap ?? 0)
  };
}

function structuralScoreFor(signals: ReuseCandidate["structuralSignals"]): number {
  let score = 0;
  if (signals.bodyDuplicateCount > 0) score += 2.5;
  if (signals.signatureSimilarity >= 0.75) score += 0.7;
  if (signals.importOverlap >= 0.5) score += 0.5;
  if (signals.calleeOverlap >= 0.5) score += 0.5;
  return score;
}

function whyReuseFromStructure(signals: ReuseCandidate["structuralSignals"]): string[] {
  const reasons: string[] = [];
  if (signals.bodyDuplicateCount > 0) reasons.push(`Normalized body fingerprint matches ${signals.bodyDuplicateCount} other indexed symbol(s).`);
  if (signals.signatureSimilarity >= 0.75) reasons.push(`Signature shape similarity is ${signals.signatureSimilarity}.`);
  if (signals.importOverlap >= 0.5) reasons.push(`Import overlap with duplicate implementation is ${signals.importOverlap}.`);
  if (signals.calleeOverlap >= 0.5) reasons.push(`Callee overlap with duplicate implementation is ${signals.calleeOverlap}.`);
  return reasons;
}

// A fingerprint depends only on (language, script kind, content), and contentHash already keys
// the content — so cache by hash to skip re-running ts.createSourceFile on every chunk for every
// reuse query. The per-chunk AST parse is the dominant fixed cost of buildStructureIndex
// (~1.1s per 4k chunks measured); repeated queries in one process now pay it once.
const fingerprintCache = new Map<string, string>();
const FINGERPRINT_CACHE_MAX_ENTRIES = 100_000;

function normalizedBodyFingerprint(chunk: CodeChunk): string {
  const key = `${chunk.language}|${scriptKindForPath(chunk.filePath)}|${chunk.contentHash}`;
  const cached = fingerprintCache.get(key);
  if (cached !== undefined) return cached;
  const fingerprint = computeBodyFingerprint(chunk);
  if (fingerprintCache.size >= FINGERPRINT_CACHE_MAX_ENTRIES) fingerprintCache.clear();
  fingerprintCache.set(key, fingerprint);
  return fingerprint;
}

function computeBodyFingerprint(chunk: CodeChunk): string {
  if (chunk.language === "typescript" || chunk.language === "javascript") {
    const sourceFile = ts.createSourceFile(chunk.filePath, chunk.content, ts.ScriptTarget.Latest, true, scriptKindForPath(chunk.filePath));
    const parts: string[] = [];
    function visit(node: ts.Node): void {
      if (node.kind === ts.SyntaxKind.SourceFile || node.kind === ts.SyntaxKind.EndOfFileToken) {
        ts.forEachChild(node, visit);
        return;
      }
      if (ts.isIdentifier(node)) {
        parts.push("Identifier");
        return;
      }
      if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node) || node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) {
        parts.push("Literal");
        return;
      }
      parts.push(ts.SyntaxKind[node.kind] ?? String(node.kind));
      ts.forEachChild(node, visit);
    }
    ts.forEachChild(sourceFile, visit);
    return sha256(parts.join("|")).slice(0, 32);
  }
  return sha256(chunk.content.replace(/[A-Za-z_$][\w$]*/g, "Identifier").replace(/\d+(?:\.\d+)?|(['\"]).*?\1/g, "Literal").replace(/\s+/g, " ").trim()).slice(0, 32);
}

function normalizedSignatureTokens(signature: string): Set<string> {
  const normalized = signature
    .replace(/(['\"]).*?\1/g, " Literal ")
    .replace(/\b\d+(?:\.\d+)?\b/g, " Literal ")
    .replace(/[A-Za-z_$][\w$]*/g, (token) => signatureKeywordTokens.has(token) ? token : "Identifier");
  return new Set(tokenize(normalized));
}

function maxSimilarity(base: Set<string>, candidates: Set<string>[]): number {
  let max = 0;
  for (const candidate of candidates) max = Math.max(max, jaccard(base, candidate));
  return max;
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 && right.size === 0) return 0;
  const union = new Set([...left, ...right]);
  let intersection = 0;
  for (const value of left) {
    if (right.has(value)) intersection += 1;
  }
  return intersection / union.size;
}

function roundSignal(value: number): number {
  return Number(value.toFixed(3));
}

function stringMetadata(edge: GraphEdge, key: string): string | undefined {
  const value = edge.metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

function numberMetadata(edge: GraphEdge, key: string): number | undefined {
  const value = edge.metadata?.[key];
  return typeof value === "number" ? value : undefined;
}

function scriptKindForPath(filePath: string): ts.ScriptKind {
  if (filePath.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (filePath.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (filePath.endsWith(".js") || filePath.endsWith(".mjs") || filePath.endsWith(".cjs")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

const signatureKeywordTokens = new Set(["export", "default", "async", "function", "class", "interface", "type", "const", "let", "var", "string", "number", "boolean", "void", "Promise"]);

const FINGERPRINT_COMPARISON_WINDOW = 64;
