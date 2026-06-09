import type { CodeFile } from "../core/types.js";
import { analyzeFileWithRegistry } from "./analyzers/registry.js";
import type { FileAnalysis } from "./analyzers/types.js";

export type { AnalyzerCapability, AnalyzeFileInput, FileAnalysis, LanguageAnalyzer } from "./analyzers/types.js";
export { analyzerFor, analyzeFileWithRegistry, listAnalyzers } from "./analyzers/registry.js";
export { fallbackAnalyzer } from "./analyzers/fallback-analyzer.js";
export { goTreeSitterAnalyzer, goTreeSitterAnalyzer as goAnalyzer } from "./analyzers/go-treesitter-analyzer.js";
export { javaTreeSitterAnalyzer, javaTreeSitterAnalyzer as javaAnalyzer } from "./analyzers/java-treesitter-analyzer.js";
export { pythonTreeSitterAnalyzer, pythonTreeSitterAnalyzer as pythonAnalyzer } from "./analyzers/python-treesitter-analyzer.js";
export { rustTreeSitterAnalyzer, rustTreeSitterAnalyzer as rustAnalyzer } from "./analyzers/rust-treesitter-analyzer.js";
export { javascriptAnalyzer, typescriptAnalyzer } from "./analyzers/typescript-analyzer.js";

export function analyzeFile(repoRoot: string, file: CodeFile, content: string): FileAnalysis {
  return analyzeFileWithRegistry({ repoRoot, file, content });
}
