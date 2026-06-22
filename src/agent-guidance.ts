import fs from "node:fs/promises";
import path from "node:path";

export const DEFAULT_AGENT_GUIDANCE_FILE = "AGENTS.md";
export const AGENT_GUIDANCE_START = "<!-- RAGCODE:AGENT-GUIDANCE:START -->";
export const AGENT_GUIDANCE_END = "<!-- RAGCODE:AGENT-GUIDANCE:END -->";

export interface AgentGuidanceStatus {
  installed: boolean;
  path: string;
  message: string;
}

export interface InstallAgentGuidanceOptions {
  repoRoot: string;
  fileName?: string;
  dryRun?: boolean;
}

export interface InstallAgentGuidanceResult extends AgentGuidanceStatus {
  created: boolean;
  updated: boolean;
  dryRun: boolean;
}

export function buildAgentGuidanceBlock(): string {
  return [
    AGENT_GUIDANCE_START,
    "## RagCode Agent Guidance",
    "",
    "This repository has RagCode code intelligence available. Use RagCode proactively; do not wait for the user to name it.",
    "",
    "- For questions about current implementation, ownership, architecture, request flow, reusable code, impact, tests, debugging, review, or where to edit, call RagCode before manual grep or broad file reads.",
    "- Start broad work with `get_context` using an appropriate mode. Use `find_owner` when locating the owner, `find_reuse_candidates` before adding new helpers/components/services, `trace_request_flow` for runtime flow, `explain_impact` or `impact_analysis` before risky edits, and `related_tests` before choosing verification.",
    "- Check `index_status` or `watch_status` when results look stale, incomplete, slow, or inconsistent. Refresh or report freshness gaps before claiming repo truth.",
    "- Use direct file reads after RagCode has identified the relevant files or when validating exact lines. Report RagCode quality issues explicitly instead of silently replacing the tool with manual search.",
    AGENT_GUIDANCE_END
  ].join("\n");
}

export async function inspectAgentGuidance(repoRoot: string, fileName = DEFAULT_AGENT_GUIDANCE_FILE): Promise<AgentGuidanceStatus> {
  const guidancePath = resolveGuidancePath(repoRoot, fileName);
  const content = await fs.readFile(guidancePath, "utf8").catch(() => undefined);
  const installed = Boolean(content?.includes(AGENT_GUIDANCE_START) && content.includes(AGENT_GUIDANCE_END));
  return {
    installed,
    path: guidancePath,
    message: installed
      ? `RagCode agent guidance is installed in ${path.basename(guidancePath)}.`
      : `RagCode agent guidance is not installed. Run \`ragcode install-guidance ${repoRoot}\` so agents proactively call RagCode.`
  };
}

export async function installAgentGuidance(options: InstallAgentGuidanceOptions): Promise<InstallAgentGuidanceResult> {
  const guidancePath = resolveGuidancePath(options.repoRoot, options.fileName ?? DEFAULT_AGENT_GUIDANCE_FILE);
  await assertRepoDirectory(options.repoRoot);

  const existing = await fs.readFile(guidancePath, "utf8").catch(() => undefined);
  const block = buildAgentGuidanceBlock();
  const next = mergeGuidance(existing, block);
  const created = existing === undefined;
  const updated = existing !== next;

  if (!options.dryRun && updated) {
    await fs.writeFile(guidancePath, next, "utf8");
  }

  return {
    installed: true,
    path: guidancePath,
    created,
    updated,
    dryRun: Boolean(options.dryRun),
    message: updated
      ? `${options.dryRun ? "Would install" : "Installed"} RagCode agent guidance in ${path.basename(guidancePath)}.`
      : `RagCode agent guidance is already current in ${path.basename(guidancePath)}.`
  };
}

function resolveGuidancePath(repoRoot: string, fileName: string): string {
  if (path.isAbsolute(fileName)) return fileName;
  return path.join(path.resolve(repoRoot), fileName);
}

async function assertRepoDirectory(repoRoot: string): Promise<void> {
  const stat = await fs.stat(repoRoot).catch((error) => {
    throw new Error(`repoRoot is not readable: ${repoRoot}. ${error instanceof Error ? error.message : String(error)}`);
  });
  if (!stat.isDirectory()) {
    throw new Error(`repoRoot is not a directory: ${repoRoot}`);
  }
}

function mergeGuidance(existing: string | undefined, block: string): string {
  if (!existing || existing.trim().length === 0) return `${block}\n`;

  const start = existing.indexOf(AGENT_GUIDANCE_START);
  const end = existing.indexOf(AGENT_GUIDANCE_END);
  if (start >= 0 && end >= start) {
    const endAfterMarker = end + AGENT_GUIDANCE_END.length;
    return `${existing.slice(0, start)}${block}${existing.slice(endAfterMarker)}`;
  }

  const trimmedEnd = existing.endsWith("\n") ? existing : `${existing}\n`;
  return `${trimmedEnd}\n${block}\n`;
}
