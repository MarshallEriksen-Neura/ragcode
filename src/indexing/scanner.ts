import fs from "node:fs/promises";
import path from "node:path";
import type { CodeFile, SkippedFile } from "../core/types.js";
import { sha256 } from "../utils/hash.js";
import { normalizeRepoPath } from "../utils/path.js";
import { detectLanguage, isIndexableLanguage } from "./language.js";
import { classifyRepoFile, shouldIgnoreDirectory, shouldIgnoreFile, skippedFile } from "./ignore-policy.js";

export interface ScanOptions {
  maxFileBytes?: number;
  filePaths?: string[];
}

export interface ScanResult {
  files: CodeFile[];
  skippedFiles: SkippedFile[];
}

export interface IndexableFileInventory {
  filePaths: string[];
  skippedFiles: SkippedFile[];
}

export async function listIndexableFilePaths(repoRoot: string, options: Pick<ScanOptions, "maxFileBytes"> = {}): Promise<IndexableFileInventory> {
  const absoluteRoot = path.resolve(repoRoot);
  const maxFileBytes = options.maxFileBytes ?? 512_000;
  const filePaths: string[] = [];
  const skippedFiles: SkippedFile[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const decision = shouldIgnoreDirectory(entry.name);
        if (decision.ignored) {
          skippedFiles.push(skippedFile(normalizeRepoPath(absoluteRoot, absolutePath), decision));
        } else {
          await walk(absolutePath);
        }
        continue;
      }
      if (!entry.isFile()) continue;

      const relativePath = normalizeRepoPath(absoluteRoot, absolutePath);
      const stat = await fs.stat(absolutePath).catch((error: unknown) => {
        if (isNotFound(error)) return undefined;
        throw error;
      });
      if (!stat?.isFile()) continue;
      const decision = shouldIgnoreFile(relativePath, maxFileBytes, stat.size);
      if (decision.ignored) {
        skippedFiles.push(skippedFile(relativePath, decision));
        continue;
      }
      const language = detectLanguage(path.basename(relativePath));
      if (!isIndexableLanguage(language)) continue;
      filePaths.push(relativePath);
    }
  }

  await walk(absoluteRoot);
  return {
    filePaths: [...new Set(filePaths)].sort(),
    skippedFiles: skippedFiles.sort((a, b) => a.filePath.localeCompare(b.filePath))
  };
}

export async function scanRepo(repoRoot: string, projectId: string, options: ScanOptions = {}): Promise<ScanResult> {
  const absoluteRoot = path.resolve(repoRoot);
  const maxFileBytes = options.maxFileBytes ?? 512_000;
  const files: CodeFile[] = [];
  const skippedFiles: SkippedFile[] = [];

  if (options.filePaths?.length) {
    for (const filePath of [...new Set(options.filePaths.map((candidate) => candidate.replaceAll("\\", "/")))].sort()) {
      await scanOne(filePath);
    }
    return {
      files: files.sort((a, b) => a.path.localeCompare(b.path)),
      skippedFiles: skippedFiles.sort((a, b) => a.filePath.localeCompare(b.filePath))
    };
  }

  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const decision = shouldIgnoreDirectory(entry.name);
        if (decision.ignored) {
          skippedFiles.push(skippedFile(normalizeRepoPath(absoluteRoot, absolutePath), decision));
        } else {
          await walk(absolutePath);
        }
        continue;
      }
      if (!entry.isFile()) continue;

      const relativePath = normalizeRepoPath(absoluteRoot, absolutePath);
      await scanFile(absolutePath, relativePath);
    }
  }

  await walk(absoluteRoot);
  return {
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
    skippedFiles: skippedFiles.sort((a, b) => a.filePath.localeCompare(b.filePath))
  };

  async function scanOne(relativePath: string): Promise<void> {
    if (!relativePath || relativePath === "." || relativePath.startsWith("..") || path.isAbsolute(relativePath)) return;
    const parts = relativePath.split("/");
    const ignoredDirectory = parts.find((part) => shouldIgnoreDirectory(part).ignored);
    if (ignoredDirectory) {
      skippedFiles.push(skippedFile(relativePath, shouldIgnoreDirectory(ignoredDirectory)));
      return;
    }
    await scanFile(path.join(absoluteRoot, relativePath), relativePath);
  }

  async function scanFile(absolutePath: string, relativePath: string): Promise<void> {
    const stat = await fs.stat(absolutePath).catch((error: unknown) => {
      if (isNotFound(error)) return undefined;
      throw error;
    });
    if (!stat?.isFile()) return;

    const fileDecision = shouldIgnoreFile(relativePath, maxFileBytes, stat.size);
    if (fileDecision.ignored) {
      skippedFiles.push(skippedFile(relativePath, fileDecision));
      return;
    }

    const language = detectLanguage(path.basename(relativePath));
    if (!isIndexableLanguage(language)) return;

    const content = await fs.readFile(absolutePath, "utf8");
    files.push({
      projectId,
      path: relativePath,
      absolutePath,
      language,
      sizeBytes: stat.size,
      contentHash: sha256(content),
      modifiedAtMs: stat.mtimeMs,
      classification: classifyRepoFile(relativePath)
    });
  }
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT");
}
