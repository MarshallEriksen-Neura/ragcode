import type { CodeFile } from "../core/types.js";
import { analyzeFileWithRegistry } from "./analyzers/registry.js";
import type { FileAnalysis } from "./analyzers/types.js";

export type { AnalyzerCapability, AnalyzeFileInput, FileAnalysis, LanguageAnalyzer } from "./analyzers/types.js";
export { analyzerFor, analyzeFileWithRegistry, listAnalyzers } from "./analyzers/registry.js";
export { fallbackAnalyzer } from "./analyzers/fallback-analyzer.js";
export { goAnalyzer } from "./analyzers/go-analyzer.js";
export { javaAnalyzer } from "./analyzers/java-analyzer.js";
export { pythonAnalyzer } from "./analyzers/python-analyzer.js";
export { rustAnalyzer } from "./analyzers/rust-analyzer.js";
export { javascriptAnalyzer, typescriptAnalyzer } from "./analyzers/typescript-analyzer.js";

export function analyzeFile(repoRoot: string, file: CodeFile, content: string): FileAnalysis {
  return analyzeFileWithRegistry({ repoRoot, file, content });
}
