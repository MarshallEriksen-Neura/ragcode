import fs from "node:fs/promises";
import type { CodeChunk, CodeFile, GraphEdge, SymbolNode } from "../core/types.js";
import { resolveCallDefinitionsWithTypeScript } from "../lsp/definition-resolver.js";
import type { TypeScriptSourceFile } from "../lsp/typescript-language-service.js";
import { buildFrameworkTopologyEdges } from "../topology/framework-topology.js";
import { resolveGraphEdges } from "../topology/symbol-resolver.js";
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

  const importResolvedEdges = resolveGraphEdges(files, symbols, edges);
  const lspResolvedEdges = resolveCallDefinitionsWithTypeScript(repoRoot, sources, symbols, importResolvedEdges);
  const frameworkEdges = buildFrameworkTopologyEdges(files, sources, symbols, lspResolvedEdges);
  return { chunks, symbols, edges: [...lspResolvedEdges, ...frameworkEdges] };
}
