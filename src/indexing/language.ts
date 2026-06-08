import type { LanguageId } from "../core/types.js";

const EXTENSION_LANGUAGE: Record<string, LanguageId> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
  ".java": "java",
  ".md": "markdown",
  ".mdx": "markdown",
  ".json": "json"
};

export function detectLanguage(filePath: string): LanguageId {
  const dot = filePath.lastIndexOf(".");
  if (dot === -1) return "unknown";
  return EXTENSION_LANGUAGE[filePath.slice(dot).toLowerCase()] ?? "unknown";
}

export function isIndexableLanguage(language: LanguageId): boolean {
  return language !== "unknown";
}
