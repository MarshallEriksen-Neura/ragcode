import fs from "node:fs/promises";
import type { CodeChunk, CodeFile, GraphEdge, SymbolNode } from "../core/types.js";
import { resolveCallDefinitionsWithTypeScript } from "../lsp/definition-resolver.js";
import type { TypeScriptSourceFile } from "../lsp/typescript-language-service.js";
import { buildFrameworkTopologyEdges } from "../topology/framework-topology.js";
import { buildRuntimeTopologyEdges } from "../topology/runtime-topology.js";
import { resolveGraphEdges } from "../topology/symbol-resolver.js";
import { buildTestTopologyEdges } from "../topology/test-topology.js";
import { analyzeFile } from "./ast-analyzer.js";

export interface ChunkingResult {
  chunks: CodeChunk[];
  symbols: SymbolNode[];
  edges: GraphEdge[];
}

export interface ChunkOptions {
  targetLines?: number;
}

export async function chunkFiles(repoRoot: string, files: CodeFile[], options: ChunkOptions = {}): Promise<ChunkingResult> {
  const analyzed = await analyzeFiles(repoRoot, files);
  return {
    chunks: analyzed.chunks,
    symbols: analyzed.symbols,
    edges: resolveChunkEdges(repoRoot, files, analyzed.sources, analyzed.symbols, analyzed.edges)
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
  const refreshedEdges = resolveChunkEdges(repoRoot, files, analyzed.sources, symbols, analyzed.edges)
    .filter((edge) => {
      const sourceFile = edgeSourceFile(edge);
      return sourceFile ? analyzedPaths.has(sourceFile) : false;
    });

  return { chunks, symbols, edges: dedupeEdges([...currentCached.edges, ...refreshedEdges]) };
}

interface AnalyzedFiles {
  chunks: CodeChunk[];
  symbols: SymbolNode[];
  edges: GraphEdge[];
  sources: TypeScriptSourceFile[];
}

async function analyzeFiles(repoRoot: string, files: CodeFile[]): Promise<AnalyzedFiles> {
  const chunks: CodeChunk[] = [];
  const symbols: SymbolNode[] = [];
  const edges: GraphEdge[] = [];
  const sources: TypeScriptSourceFile[] = [];

  for (const file of files) {
    const content = await fs.readFile(file.absolutePath, "utf8");
    if (file.language === "typescript" || file.language === "javascript") {
      sources.push({ filePath: file.path, absolutePath: file.absolutePath, content });
    }
    const analysis = analyzeFile(repoRoot, file, content);
    chunks.push(...analysis.chunks);
    symbols.push(...analysis.symbols);
    edges.push(...analysis.edges);
  }

  return { chunks, symbols, edges, sources };
}

function resolveChunkEdges(
  repoRoot: string,
  files: CodeFile[],
  sources: TypeScriptSourceFile[],
  symbols: SymbolNode[],
  edges: GraphEdge[]
): GraphEdge[] {
  const importResolvedEdges = resolveGraphEdges(files, symbols, edges);
  const lspResolvedEdges = resolveCallDefinitionsWithTypeScript(repoRoot, sources, symbols, importResolvedEdges);
  const testEdges = buildTestTopologyEdges(symbols, lspResolvedEdges);
  const frameworkEdges = buildFrameworkTopologyEdges(files, sources, symbols, lspResolvedEdges);
  const runtimeEdges = buildRuntimeTopologyEdges(repoRoot, files, sources, symbols);
  return [...lspResolvedEdges, ...testEdges, ...frameworkEdges, ...runtimeEdges];
}

function edgeSourceFile(edge: GraphEdge): string | undefined {
  return typeof edge.metadata?.sourceFile === "string" ? edge.metadata.sourceFile : undefined;
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
