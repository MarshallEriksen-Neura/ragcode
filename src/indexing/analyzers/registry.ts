import type { LanguageId } from "../../core/types.js";
import { fallbackAnalyzer } from "./fallback-analyzer.js";
import { javascriptAnalyzer, typescriptAnalyzer } from "./typescript-analyzer.js";
import type { AnalyzeFileInput, FileAnalysis, LanguageAnalyzer } from "./types.js";
import { pythonTreeSitterAnalyzer } from "./python-treesitter-analyzer.js";
import { goTreeSitterAnalyzer } from "./go-treesitter-analyzer.js";
import { rustTreeSitterAnalyzer } from "./rust-treesitter-analyzer.js";
import { javaTreeSitterAnalyzer } from "./java-treesitter-analyzer.js";

const analyzers = new Map<LanguageId, LanguageAnalyzer>([
  ["typescript", typescriptAnalyzer],
  ["javascript", javascriptAnalyzer],
  ["python", pythonTreeSitterAnalyzer],
  ["go", goTreeSitterAnalyzer],
  ["rust", rustTreeSitterAnalyzer],
  ["java", javaTreeSitterAnalyzer]
]);

export function analyzerFor(language: LanguageId): LanguageAnalyzer {
  return analyzers.get(language) ?? fallbackAnalyzer;
}

export function listAnalyzers(): LanguageAnalyzer[] {
  return [...analyzers.values(), fallbackAnalyzer];
}

export function analyzeFileWithRegistry(input: AnalyzeFileInput): FileAnalysis {
  return analyzerFor(input.file.language).analyzeFile(input);
}
