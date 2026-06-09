import type { CodeChunk, CodeFile, GraphEdge, LanguageId, SymbolNode } from "../../core/types.js";

export interface FileAnalysis {
  chunks: CodeChunk[];
  symbols: SymbolNode[];
  edges: GraphEdge[];
}

export interface AnalyzeFileInput {
  repoRoot: string;
  file: CodeFile;
  content: string;
}

export type AnalyzerCapability =
  | "symbols"
  | "imports"
  | "exports"
  | "calls"
  | "definitions"
  | "framework_routes"
  | "tests";

export interface LanguageAnalyzer {
  language: LanguageId;
  capabilities: AnalyzerCapability[];
  analyzeFile(input: AnalyzeFileInput): FileAnalysis;
}
