import fs from "node:fs/promises";
import path from "node:path";
import type { CodeFile } from "../core/types.js";
import { sha256 } from "../utils/hash.js";
import { normalizeRepoPath } from "../utils/path.js";
import { detectLanguage, isIndexableLanguage } from "./language.js";
import { shouldIgnoreDirectory, shouldIgnoreFile } from "./ignore-policy.js";

export interface ScanOptions {
  maxFileBytes?: number;
}

export interface ScanResult {
  files: CodeFile[];
  skippedFiles: Array<{ filePath: string; reason: string }>;
}

export async function scanRepo(repoRoot: string, projectId: string, options: ScanOptions = {}): Promise<ScanResult> {
  const absoluteRoot = path.resolve(repoRoot);
  const maxFileBytes = options.maxFileBytes ?? 512_000;
  const files: CodeFile[] = [];
  const skippedFiles: Array<{ filePath: string; reason: string }> = [];

  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const decision = shouldIgnoreDirectory(entry.name);
        if (decision.ignored) {
          skippedFiles.push({ filePath: normalizeRepoPath(absoluteRoot, absolutePath), reason: decision.reason ?? "ignored directory" });
        } else {
          await walk(absolutePath);
        }
        continue;
      }
      if (!entry.isFile()) continue;

      const relativePath = normalizeRepoPath(absoluteRoot, absolutePath);
      const stat = await fs.stat(absolutePath);
      const fileDecision = shouldIgnoreFile(relativePath, maxFileBytes, stat.size);
      if (fileDecision.ignored) {
        skippedFiles.push({ filePath: relativePath, reason: fileDecision.reason ?? "ignored file" });
        continue;
      }

      const language = detectLanguage(entry.name);
      if (!isIndexableLanguage(language)) continue;

      const content = await fs.readFile(absolutePath, "utf8");
      files.push({
        projectId,
        path: relativePath,
        absolutePath,
        language,
        sizeBytes: stat.size,
        contentHash: sha256(content),
        modifiedAtMs: stat.mtimeMs
      });
    }
  }

  await walk(absoluteRoot);
  return {
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
    skippedFiles: skippedFiles.sort((a, b) => a.filePath.localeCompare(b.filePath))
  };
}
