import fs from "node:fs/promises";
import path from "node:path";
import type { ProjectIdentity } from "../core/types.js";
import { sha256 } from "../utils/hash.js";

export async function createProjectIdentity(repoRoot: string): Promise<ProjectIdentity> {
  const resolvedRoot = path.resolve(repoRoot);
  const canonicalRoot = await fs.realpath(resolvedRoot).catch(() => resolvedRoot);
  const gitRemote = await readGitRemote(canonicalRoot);
  return {
    projectId: sha256([canonicalRoot.toLowerCase(), gitRemote ?? ""].join("::")).slice(0, 24),
    repoRoot: resolvedRoot,
    canonicalRoot,
    displayName: path.basename(canonicalRoot),
    gitRemote,
    createdAtMs: Date.now()
  };
}

async function readGitRemote(repoRoot: string): Promise<string | undefined> {
  const configPath = path.join(repoRoot, ".git", "config");
  const config = await fs.readFile(configPath, "utf8").catch(() => undefined);
  if (!config) return undefined;
  const match = /\[remote "origin"\][\s\S]*?url\s*=\s*(.+)/.exec(config);
  return match?.[1]?.trim();
}
