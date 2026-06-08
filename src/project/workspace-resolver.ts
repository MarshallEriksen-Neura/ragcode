import path from "node:path";
import type { ProjectIdentity, WorkspaceHint, WorkspaceSession } from "../core/types.js";
import { ProjectRegistry } from "./project-registry.js";

export interface WorkspaceResolverOptions {
  cwd?: string;
  roots?: string[];
}

export class WorkspaceResolver {
  private active?: WorkspaceSession;

  constructor(private readonly registry: ProjectRegistry, private readonly options: WorkspaceResolverOptions = {}) {}

  setActive(project: ProjectIdentity, resolvedFrom: WorkspaceSession["resolvedFrom"] = "active_session"): WorkspaceSession {
    this.active = {
      activeProjectId: project.projectId,
      activeRepoRoot: project.repoRoot,
      knownProjects: this.registry.list(),
      resolvedFrom
    };
    return this.active;
  }

  resolve(input: { repoRoot?: string; workspace?: WorkspaceHint } = {}): WorkspaceSession {
    if (input.workspace?.filePath) return this.fromFilePath(input.workspace.filePath);
    if (input.workspace?.root) return this.fromRoot(input.workspace.root, "root");
    if (input.repoRoot) return this.fromRoot(input.repoRoot, "repoRoot");

    for (const root of this.options.roots ?? []) {
      const project = this.registry.findByRoot(root);
      if (project) return this.setActive(project, "mcp_roots");
    }

    if (this.active) return this.active;

    if (this.options.cwd) {
      const project = this.registry.findByRoot(this.options.cwd);
      if (project) return this.setActive(project, "cwd");
    }

    const projects = this.registry.list();
    if (projects.length === 1) return this.setActive(projects[0]!, "single_project");
    if (projects.length > 1) throw new Error(`Ambiguous workspace: ${projects.length} indexed projects are available. Provide workspace.root or workspace.filePath.`);
    throw new Error("Missing workspace: index a repository or provide workspace.root before retrieval.");
  }

  getActive(): WorkspaceSession | undefined {
    return this.active;
  }

  private fromFilePath(filePath: string): WorkspaceSession {
    const matches = this.registry.findContainingPath(path.resolve(filePath));
    if (matches.length === 1) return this.setActive(matches[0]!, "filePath");
    if (matches.length > 1) throw new Error(`Ambiguous workspace for filePath: ${filePath}`);
    throw new Error(`No indexed workspace contains filePath: ${filePath}`);
  }

  private fromRoot(root: string, resolvedFrom: WorkspaceSession["resolvedFrom"]): WorkspaceSession {
    const project = this.registry.findByRoot(root);
    if (!project) throw new Error(`Workspace is not indexed: ${root}`);
    return this.setActive(project, resolvedFrom);
  }
}
