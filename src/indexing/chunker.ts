import fs from "node:fs/promises";
import type { CodeChunk, CodeFile, GraphEdge, IndexAnalysisWarning, SymbolNode } from "../core/types.js";
import { resolveCallDefinitionsWithTypeScript } from "../lsp/definition-resolver.js";
import type { TypeScriptSourceFile } from "../lsp/typescript-language-service.js";
import { buildFrameworkTopologyEdges } from "../topology/framework-topology.js";
import { buildOrmTopologyEdges } from "../topology/orm-topology.js";
import { buildRuntimeTopologyEdges } from "../topology/runtime-topology.js";
import { resolveGraphEdges } from "../topology/symbol-resolver.js";
import { buildTestTopologyEdges } from "../topology/test-topology.js";
import { analyzeFile } from "./ast-analyzer.js";

export interface ChunkingResult {
  chunks: CodeChunk[];
  symbols: SymbolNode[];
  edges: GraphEdge[];
  warnings?: IndexAnalysisWarning[];
}

export interface ChunkOptions {
  targetLines?: number;
}

export async function chunkFiles(repoRoot: string, files: CodeFile[], options: ChunkOptions = {}): Promise<ChunkingResult> {
  const analyzed = await analyzeFiles(repoRoot, files);
  const chunkDedupe = uniqueById(analyzed.chunks, "deduped_chunks", "Duplicate chunk ids removed before graph persistence");
  const symbolDedupe = uniqueById(analyzed.symbols, "deduped_symbols", "Duplicate symbol ids removed before graph persistence");
  const chunks = chunkDedupe.items;
  const symbols = symbolDedupe.items;
  return {
    chunks,
    symbols,
    edges: resolveChunkEdges(repoRoot, files, analyzed.sources, symbols, analyzed.edges),
    warnings: compactWarnings([...analyzed.warnings, ...definedWarnings([chunkDedupe.warning, symbolDedupe.warning])])
  };
}

export async function chunkFilesIncremental(
  repoRoot: string,
  files: CodeFile[],
  filesToAnalyze: CodeFile[],
  cached: ChunkingResult,
  options: ChunkOptions = {}
): Promise<ChunkingResult> {
  const analyzedPaths = new Set(filesToAnalyze.map((file) => file.path));
  const currentPaths = new Set(files.map((file) => file.path));
  const currentCached = filterCachedChunking(cached, currentPaths, analyzedPaths);
  if (analyzedPaths.size === 0) return currentCached;

  const analyzed = await analyzeFiles(repoRoot, filesToAnalyze);
  const chunks = [
    ...currentCached.chunks,
    ...analyzed.chunks
  ];
  const symbols = [
    ...currentCached.symbols,
    ...analyzed.symbols
  ];
  const chunkDedupe = uniqueById(chunks, "deduped_chunks", "Duplicate chunk ids removed before graph persistence");
  const symbolDedupe = uniqueById(symbols, "deduped_symbols", "Duplicate symbol ids removed before graph persistence");
  const uniqueSymbols = symbolDedupe.items;
  const refreshedEdges = resolveChunkEdges(repoRoot, files, analyzed.sources, uniqueSymbols, analyzed.edges, routeCatalogEdges(cached.edges, currentPaths, analyzedPaths))
    .filter((edge) => {
      const sourceFile = edgeSourceFile(edge);
      return sourceFile ? analyzedPaths.has(sourceFile) : false;
    });

  return {
    chunks: chunkDedupe.items,
    symbols: uniqueSymbols,
    edges: dedupeEdges([...currentCached.edges, ...refreshedEdges]),
    warnings: compactWarnings([...analyzed.warnings, ...definedWarnings([chunkDedupe.warning, symbolDedupe.warning])])
  };
}

interface AnalyzedFiles {
  chunks: CodeChunk[];
  symbols: SymbolNode[];
  edges: GraphEdge[];
  sources: TypeScriptSourceFile[];
  warnings: IndexAnalysisWarning[];
}

async function analyzeFiles(repoRoot: string, files: CodeFile[]): Promise<AnalyzedFiles> {
  const chunks: CodeChunk[] = [];
  const symbols: SymbolNode[] = [];
  const edges: GraphEdge[] = [];
  const sources: TypeScriptSourceFile[] = [];
  const warnings: IndexAnalysisWarning[] = [];

  for (const file of files) {
    const content = await fs.readFile(file.absolutePath, "utf8");
    if (file.language === "typescript" || file.language === "javascript") {
      sources.push({ filePath: file.path, absolutePath: file.absolutePath, content });
    }
    const analysis = analyzeFile(repoRoot, file, content);
    chunks.push(...analysis.chunks);
    symbols.push(...analysis.symbols);
    edges.push(...analysis.edges);
    warnings.push(...analysis.warnings ?? []);
  }

  return { chunks, symbols, edges, sources, warnings };
}

function resolveChunkEdges(
  repoRoot: string,
  files: CodeFile[],
  sources: TypeScriptSourceFile[],
  symbols: SymbolNode[],
  edges: GraphEdge[],
  priorEdges: GraphEdge[] = []
): GraphEdge[] {
  const importResolvedEdges = resolveGraphEdges(files, symbols, edges);
  const lspResolvedEdges = resolveCallDefinitionsWithTypeScript(repoRoot, sources, symbols, importResolvedEdges);
  const testEdges = buildTestTopologyEdges(symbols, lspResolvedEdges);
  const frameworkEdges = buildFrameworkTopologyEdges(files, sources, symbols, lspResolvedEdges, priorEdges);
  const runtimeEdges = buildRuntimeTopologyEdges(repoRoot, files, sources, symbols);
  const ormEdges = buildOrmTopologyEdges(repoRoot, files, sources, symbols);
  return [...lspResolvedEdges, ...testEdges, ...frameworkEdges, ...runtimeEdges, ...ormEdges];
}

function edgeSourceFile(edge: GraphEdge): string | undefined {
  return typeof edge.metadata?.sourceFile === "string" ? edge.metadata.sourceFile : undefined;
}

function routeCatalogEdges(edges: GraphEdge[], currentPaths: Set<string>, analyzedPaths: Set<string>): GraphEdge[] {
  return edges.filter((edge) => {
    if (edge.kind !== "calls_api" && edge.kind !== "routes_to" && edge.kind !== "handles_webhook") return false;
    const routeFile = stringMetadata(edge, "routeFile") ?? stringMetadata(edge, "targetFile");
    if (!routeFile || !currentPaths.has(routeFile)) return false;
    return !analyzedPaths.has(routeFile);
  });
}

function filterCachedChunking(cached: ChunkingResult, currentPaths: Set<string>, analyzedPaths: Set<string>): ChunkingResult {
  return {
    chunks: cached.chunks.filter((chunk) => currentPaths.has(chunk.filePath) && !analyzedPaths.has(chunk.filePath)),
    symbols: cached.symbols.filter((symbol) => currentPaths.has(symbol.filePath) && !analyzedPaths.has(symbol.filePath)),
    edges: cached.edges.filter((edge) => {
      const sourceFile = edgeSourceFile(edge);
      return Boolean(sourceFile && currentPaths.has(sourceFile) && !analyzedPaths.has(sourceFile));
    })
  };
}

function dedupeEdges(edges: GraphEdge[]): GraphEdge[] {
  const seen = new Set<string>();
  const unique: GraphEdge[] = [];
  for (const edge of edges) {
    const key = edgeDedupeKey(edge);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(edge);
  }
  return unique;
}

function edgeDedupeKey(edge: GraphEdge): string {
  const metadata = edge.metadata;
  return [
    edge.projectId,
    edge.sourceId,
    edge.targetId,
    edge.kind,
    scalarMetadata(metadata, "sourceFile"),
    scalarMetadata(metadata, "targetFile"),
    scalarMetadata(metadata, "targetName"),
    scalarMetadata(metadata, "source"),
    scalarMetadata(metadata, "name"),
    scalarMetadata(metadata, "line"),
    scalarMetadata(metadata, "position"),
    scalarMetadata(metadata, "resolution"),
    scalarMetadata(metadata, "importedName"),
    scalarMetadata(metadata, "localName"),
    scalarMetadata(metadata, "route"),
    scalarMetadata(metadata, "requestPath"),
    scalarMetadata(metadata, "framework"),
    scalarMetadata(metadata, "resource"),
    scalarMetadata(metadata, "operation"),
    scalarMetadata(metadata, "event"),
    scalarMetadata(metadata, "handler"),
    scalarMetadata(metadata, "testFile"),
    scalarMetadata(metadata, "colocated"),
    bindingsMetadata(metadata)
  ].map(escapeKeyPart).join("\u001f");
}

function scalarMetadata(metadata: GraphEdge["metadata"], key: string): string {
  const value = metadata?.[key];
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function stringMetadata(edge: GraphEdge, key: string): string | undefined {
  const value = edge.metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

function bindingsMetadata(metadata: GraphEdge["metadata"]): string {
  const value = metadata?.bindings;
  if (!Array.isArray(value)) return "";
  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") return "";
      const binding = entry as Record<string, unknown>;
      const imported = typeof binding.imported === "string" ? binding.imported : "";
      const local = typeof binding.local === "string" ? binding.local : "";
      return `${imported}->${local}`;
    })
    .sort()
    .join("|");
}

function escapeKeyPart(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\u001f", "\\u001f");
}

function uniqueById<T extends { id: string; filePath?: string }>(items: T[], kind: IndexAnalysisWarning["kind"], message: string): { items: T[]; warning?: IndexAnalysisWarning } {
  const seen = new Map<string, T>();
  const duplicateSamples: string[] = [];
  let duplicateCount = 0;
  for (const item of items) {
    if (seen.has(item.id)) {
      duplicateCount += 1;
      if (duplicateSamples.length < 8) duplicateSamples.push(item.filePath ?? item.id);
    }
    seen.set(item.id, item);
  }
  return {
    items: [...seen.values()],
    warning: duplicateCount > 0 ? { kind, message, count: duplicateCount, samples: duplicateSamples } : undefined
  };
}

function definedWarnings(warnings: Array<IndexAnalysisWarning | undefined>): IndexAnalysisWarning[] {
  return warnings.filter((warning): warning is IndexAnalysisWarning => Boolean(warning));
}

function compactWarnings(warnings: IndexAnalysisWarning[]): IndexAnalysisWarning[] | undefined {
  if (warnings.length === 0) return undefined;
  const compacted = new Map<string, IndexAnalysisWarning>();
  for (const warning of warnings) {
    const key = `${warning.kind}\0${warning.message}`;
    const current = compacted.get(key);
    if (!current) {
      compacted.set(key, { ...warning, samples: warning.samples.slice(0, 8) });
      continue;
    }
    current.count += warning.count;
    current.samples = [...new Set([...current.samples, ...warning.samples])].slice(0, 8);
  }
  return [...compacted.values()];
}
