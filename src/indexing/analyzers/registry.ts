import type { LanguageId } from "../../core/types.js";
import { fallbackAnalyzer } from "./fallback-analyzer.js";
import { goAnalyzer } from "./go-analyzer.js";
import { javaAnalyzer } from "./java-analyzer.js";
import { pythonAnalyzer } from "./python-analyzer.js";
import { rustAnalyzer } from "./rust-analyzer.js";
import { javascriptAnalyzer, typescriptAnalyzer } from "./typescript-analyzer.js";
import type { AnalyzeFileInput, FileAnalysis, LanguageAnalyzer } from "./types.js";

// Tree-sitter analyzers - import directly when feature flag is enabled
import { pythonTreeSitterAnalyzer } from "./python-treesitter-analyzer.js";
import { goTreeSitterAnalyzer } from "./go-treesitter-analyzer.js";
import { rustTreeSitterAnalyzer } from "./rust-treesitter-analyzer.js";
import { javaTreeSitterAnalyzer } from "./java-treesitter-analyzer.js";

// Feature flag: set to true to use tree-sitter analyzers
const USE_TREE_SITTER = process.env.RAGCODE_USE_TREESITTER === "true";

const regexAnalyzers = new Map<LanguageId, LanguageAnalyzer>([
  ["typescript", typescriptAnalyzer],
  ["javascript", javascriptAnalyzer],
  ["python", pythonAnalyzer],
  ["go", goAnalyzer],
  ["rust", rustAnalyzer],
  ["java", javaAnalyzer]
]);

const treeSitterAnalyzers = new Map<LanguageId, LanguageAnalyzer>([
  ["python", pythonTreeSitterAnalyzer],
  ["go", goTreeSitterAnalyzer],
  ["rust", rustTreeSitterAnalyzer],
  ["java", javaTreeSitterAnalyzer]
]);

export function analyzerFor(language: LanguageId): LanguageAnalyzer {
  // TypeScript always uses the official compiler API
  if (language === "typescript" || language === "javascript") {
    return regexAnalyzers.get(language) ?? fallbackAnalyzer;
  }

  // Use tree-sitter if enabled
  if (USE_TREE_SITTER) {
    const tsAnalyzer = treeSitterAnalyzers.get(language);
    if (tsAnalyzer) return tsAnalyzer;
  }

  // Fall back to regex analyzers
  return regexAnalyzers.get(language) ?? fallbackAnalyzer;
}

export function listAnalyzers(): LanguageAnalyzer[] {
  if (USE_TREE_SITTER) {
    return [...regexAnalyzers.values(), ...treeSitterAnalyzers.values(), fallbackAnalyzer];
  }
  return [...regexAnalyzers.values(), fallbackAnalyzer];
}

export function analyzeFileWithRegistry(input: AnalyzeFileInput): FileAnalysis {
  return analyzerFor(input.file.language).analyzeFile(input);
}
