import path from "node:path";

export function normalizeRepoPath(repoRoot: string, candidate: string): string {
  return path.relative(repoRoot, candidate).split(path.sep).join("/");
}

export function normalizeUserPath(candidate: string): string {
  return candidate.split(path.sep).join("/");
}
