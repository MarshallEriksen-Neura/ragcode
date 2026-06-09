import path from "node:path";
import type { ProjectIdentity } from "../core/types.js";
import { createProjectIdentity } from "./project-identity.js";

export class ProjectRegistry {
  private readonly byId = new Map<string, ProjectIdentity>();
  private readonly byRoot = new Map<string, ProjectIdentity>();

  async register(repoRoot: string): Promise<ProjectIdentity> {
    const identity = await createProjectIdentity(repoRoot);
    const existing = this.byId.get(identity.projectId);
    const merged = {
      ...(existing ?? identity),
      ...identity,
      createdAtMs: existing?.createdAtMs ?? identity.createdAtMs,
      lastIndexedAtMs: Date.now()
    };
    return this.upsert(merged);
  }

  upsert(project: ProjectIdentity): ProjectIdentity {
    const existing = this.byId.get(project.projectId);
    const merged = {
      ...(existing ?? project),
      ...project,
      createdAtMs: existing?.createdAtMs ?? project.createdAtMs
    };
    this.byId.set(merged.projectId, merged);
    this.byRoot.set(normalizeRoot(merged.repoRoot), merged);
    this.byRoot.set(normalizeRoot(merged.canonicalRoot), merged);
    return merged;
  }

  getByProjectId(projectId: string): ProjectIdentity | undefined {
    return this.byId.get(projectId);
  }

  findByRoot(root: string): ProjectIdentity | undefined {
    return this.byRoot.get(normalizeRoot(root));
  }

  findContainingPath(filePath: string): ProjectIdentity[] {
    const absolute = path.resolve(filePath);
    return [...this.byId.values()].filter((project) => isInside(project.canonicalRoot, absolute) || isInside(project.repoRoot, absolute));
  }

  list(): ProjectIdentity[] {
    return [...this.byId.values()].sort((a, b) => a.canonicalRoot.localeCompare(b.canonicalRoot));
  }
}

export function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeRoot(root: string): string {
  return path.resolve(root).toLowerCase();
}
