import type { LanguageId } from "../../core/types.js";
import { fallbackAnalyzer } from "./fallback-analyzer.js";
import { goAnalyzer } from "./go-analyzer.js";
import { javaAnalyzer } from "./java-analyzer.js";
import { pythonAnalyzer } from "./python-analyzer.js";
import { rustAnalyzer } from "./rust-analyzer.js";
import { javascriptAnalyzer, typescriptAnalyzer } from "./typescript-analyzer.js";
import type { AnalyzeFileInput, FileAnalysis, LanguageAnalyzer } from "./types.js";

const analyzers = new Map<LanguageId, LanguageAnalyzer>([
  ["typescript", typescriptAnalyzer],
  ["javascript", javascriptAnalyzer],
  ["python", pythonAnalyzer],
  ["go", goAnalyzer],
  ["rust", rustAnalyzer],
  ["java", javaAnalyzer]
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
