import type { CodeFile, GraphEdge, SymbolNode } from "../../core/types.js";
import { sha256, stableId } from "../../utils/hash.js";
import type { AnalyzeFileInput, FileAnalysis, LanguageAnalyzer } from "./types.js";

export const fallbackAnalyzer: LanguageAnalyzer = {
  language: "unknown",
  capabilities: [],
  analyzeFile: ({ repoRoot, file, content }) => fallbackFileAnalysis(repoRoot, file, content)
};

export function fallbackFileAnalysis(
  repoRoot: string,
  file: CodeFile,
  content: string,
  existingFileSymbol?: SymbolNode,
  existingEdges: GraphEdge[] = []
): FileAnalysis {
  const lines = content.split(/\r?\n/);
  const fileSymbol = existingFileSymbol ?? createFileSymbol(repoRoot, file, lines.length);
  const chunks = [];
  for (let start = 0; start < lines.length; start += 80) {
    const end = Math.min(lines.length, start + 80);
    const chunkContent = lines.slice(start, end).join("\n");
    if (!chunkContent.trim()) continue;
    chunks.push({
      id: stableId([repoRoot, file.path, start + 1, end, sha256(chunkContent)]),
      projectId: file.projectId,
      repoRoot,
      filePath: file.path,
      language: file.language,
      kind: "block" as const,
      startLine: start + 1,
      endLine: end,
      content: chunkContent,
      contentHash: sha256(chunkContent)
    });
  }
  return { chunks, symbols: [fileSymbol], edges: existingEdges };
}

export function createFileSymbol(repoRoot: string, file: CodeFile, lineCount: number): SymbolNode {
  return {
    id: stableId([repoRoot, file.path, "file"]),
    projectId: file.projectId,
    filePath: file.path,
    name: file.path,
    kind: "file",
    language: file.language,
    startLine: 1,
    endLine: Math.max(1, lineCount)
  };
}

export function analyzeFallbackFile(input: AnalyzeFileInput): FileAnalysis {
  return fallbackFileAnalysis(input.repoRoot, input.file, input.content);
}
