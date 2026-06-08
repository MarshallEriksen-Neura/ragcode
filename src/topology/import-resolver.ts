import path from "node:path";
import type { CodeFile } from "../core/types.js";

const RESOLVABLE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"];

export function resolveImportPath(sourceFilePath: string, importSource: string, files: CodeFile[]): string | undefined {
  if (!importSource.startsWith(".") && !importSource.startsWith("/")) return undefined;

  const filePaths = new Set(files.map((file) => file.path));
  const sourceDir = path.posix.dirname(sourceFilePath);
  const base = normalizeImportCandidate(importSource.startsWith("/")
    ? importSource.slice(1)
    : path.posix.normalize(path.posix.join(sourceDir, importSource)));

  for (const candidate of candidatePaths(base)) {
    if (filePaths.has(candidate)) return candidate;
  }
  return undefined;
}

function candidatePaths(base: string): string[] {
  const candidates = [base];
  if (!RESOLVABLE_EXTENSIONS.some((extension) => base.endsWith(extension))) {
    for (const extension of RESOLVABLE_EXTENSIONS) candidates.push(`${base}${extension}`);
  }
  for (const extension of RESOLVABLE_EXTENSIONS) candidates.push(path.posix.join(base, `index${extension}`));
  return [...new Set(candidates.map(normalizeImportCandidate))];
}

function normalizeImportCandidate(candidate: string): string {
  return candidate.replaceAll("\\", "/").replace(/^\/+/, "");
}
