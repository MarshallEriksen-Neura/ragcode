import { z } from "zod";
import type { ContextEngine } from "../core/contracts.js";
import { buildExplainImpactReport } from "../subgraph/impact-explainer.js";
import { expandNode, parseNodeRef } from "../subgraph/node-expander.js";
import { applyExplainImpactOutputPreset, applySubgraphOutputPreset } from "../subgraph/output-preset.js";

export const ToolNameSchema = z.enum([
  "index_repo",
  "refresh_index",
  "index_status",
  "record_file_events",
  "search_code",
  "get_context",
  "topology_map",
  "find_symbol",
  "explain_file",
  "expand_node",
  "find_owner",
  "find_reuse_candidates",
  "impact_analysis",
  "explain_impact",
  "related_tests",
  "trace_flow",
  "trace_request_flow",
  "review_diff"
]);
export type ToolName = z.infer<typeof ToolNameSchema>;

export const IndexRepoInput = z.object({ repoRoot: z.string().min(1) });
export const ContextModeSchema = z.enum(["auto", "debug", "feature", "refactor", "review", "explain"]);
export const ExpansionLevelSchema = z.enum(["file_card", "skeleton", "focused_body", "full_body"]);
export const SubgraphOutputPresetSchema = z.enum(["compact", "agent_edit", "debug_trace", "review_risk"]);
export const WorkspaceHintInput = z.object({ root: z.string().min(1).optional(), filePath: z.string().min(1).optional() }).optional();
export const RefreshIndexInput = z.object({ repoRoot: z.string().min(1).optional(), workspace: WorkspaceHintInput });
export const IndexStatusInput = z.object({ repoRoot: z.string().min(1).optional(), workspace: WorkspaceHintInput });
export const RecordFileEventsInput = z.object({
  repoRoot: z.string().min(1).optional(),
  workspace: WorkspaceHintInput,
  filePaths: z.array(z.string().min(1)).min(1),
  burstThreshold: z.number().int().positive().optional(),
  maxDirtyFiles: z.number().int().positive().optional()
});
export const SearchCodeInput = z.object({ repoRoot: z.string().min(1).optional(), workspace: WorkspaceHintInput, query: z.string().min(1), limit: z.number().int().positive().optional(), mode: ContextModeSchema.optional() });
export const GetContextInput = SearchCodeInput.extend({ budgetChars: z.number().int().positive().optional() });
export const TopologyMapInput = SearchCodeInput.extend({ budgetChars: z.number().int().positive().optional(), maxEdges: z.number().int().positive().optional() });
export const FindSymbolInput = z.object({ repoRoot: z.string().min(1).optional(), workspace: WorkspaceHintInput, name: z.string().min(1) });
export const ExplainFileInput = z.object({ repoRoot: z.string().min(1).optional(), workspace: WorkspaceHintInput, filePath: z.string().min(1) });
export const ExpandNodeInput = z.object({
  repoRoot: z.string().min(1).optional(),
  workspace: WorkspaceHintInput,
  nodeRef: z.string().min(1),
  expansionLevel: ExpansionLevelSchema.optional(),
  budgetChars: z.number().int().positive().optional()
});
export const FindOwnerInput = z.object({ repoRoot: z.string().min(1).optional(), workspace: WorkspaceHintInput, query: z.string().min(1), limit: z.number().int().positive().optional() });
export const FindReuseCandidatesInput = FindOwnerInput;
export const ImpactAnalysisInput = z.object({ repoRoot: z.string().min(1).optional(), workspace: WorkspaceHintInput, target: z.string().min(1) });
export const ExplainImpactInput = ImpactAnalysisInput.extend({ budgetChars: z.number().int().positive().optional(), maxHops: z.number().int().positive().optional(), preset: SubgraphOutputPresetSchema.optional() });
export const RelatedTestsInput = ImpactAnalysisInput;
export const TraceFlowInput = z.object({ repoRoot: z.string().min(1).optional(), workspace: WorkspaceHintInput, entry: z.string().min(1), maxSteps: z.number().int().positive().optional() });
export const TraceRequestFlowInput = z.object({
  repoRoot: z.string().min(1).optional(),
  workspace: WorkspaceHintInput,
  entry: z.string().min(1),
  query: z.string().min(1).optional(),
  budgetChars: z.number().int().positive().optional(),
  maxHops: z.number().int().positive().optional(),
  preset: SubgraphOutputPresetSchema.optional()
});
export const ReviewDiffInput = z.object({ repoRoot: z.string().min(1).optional(), workspace: WorkspaceHintInput, diff: z.string().optional(), changedFiles: z.array(z.string()).optional() });

export interface McpToolDefinition {
  name: ToolName;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpRuntimeToolDefinition {
  name: ToolName;
  description: string;
  inputSchema: z.ZodType;
}

export function listToolDefinitions(): McpToolDefinition[] {
  return listRuntimeToolDefinitions().map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: zodToJsonShape(tool.inputSchema)
  }));
}

export function listRuntimeToolDefinitions(): McpRuntimeToolDefinition[] {
  return [
    {
      name: "index_repo",
      description: "Index or re-index a local repository into the structural graph and semantic store.",
      inputSchema: IndexRepoInput
    },
    {
      name: "refresh_index",
      description: "Force refresh the active indexed repository. Currently performs a full reindex; future versions can narrow to changed files.",
      inputSchema: RefreshIndexInput
    },
    {
      name: "index_status",
      description: "Report indexed file/chunk/symbol/edge counts plus freshness, stale, pending, and skipped file state for the active repository.",
      inputSchema: IndexStatusInput
    },
    {
      name: "record_file_events",
      description: "Record watcher file events as coalesced dirty-file state without indexing immediately.",
      inputSchema: RecordFileEventsInput
    },
    {
      name: "search_code",
      description: "Run hybrid code search over keyword and semantic indexes.",
      inputSchema: SearchCodeInput
    },
    {
      name: "get_context",
      description: "Build an agent-ready context pack for a code question under a character budget.",
      inputSchema: GetContextInput
    },
    {
      name: "topology_map",
      description: "Return owner-chain and topology edges for a feature/domain query without full evidence snippets.",
      inputSchema: TopologyMapInput
    },
    {
      name: "find_symbol",
      description: "Find indexed symbols by name.",
      inputSchema: FindSymbolInput
    },
    {
      name: "explain_file",
      description: "Return indexed file metadata, chunks, and symbols for a file.",
      inputSchema: ExplainFileInput
    },
    {
      name: "expand_node",
      description: "Expand one node from a compact subgraph as a focused body, skeleton, file card, or full body under budget.",
      inputSchema: ExpandNodeInput
    },
    {
      name: "find_owner",
      description: "Find likely owner files and symbols for a feature, bug, or architecture question.",
      inputSchema: FindOwnerInput
    },
    {
      name: "find_reuse_candidates",
      description: "Find existing helpers, services, hooks, components, wrappers, schemas, or fixtures that should be reused before writing new code.",
      inputSchema: FindReuseCandidatesInput
    },
    {
      name: "impact_analysis",
      description: "Estimate direct structural impact for a file or symbol using graph edges.",
      inputSchema: ImpactAnalysisInput
    },
    {
      name: "explain_impact",
      description: "Return a verified minimal blast-radius subgraph with coverage signals, risk score, and edit-readiness guidance.",
      inputSchema: ExplainImpactInput
    },
    {
      name: "related_tests",
      description: "Find likely related test files for a file or symbol target.",
      inputSchema: RelatedTestsInput
    },
    {
      name: "trace_flow",
      description: "Trace outgoing call edges from an entry symbol or file hint.",
      inputSchema: TraceFlowInput
    },
    {
      name: "trace_request_flow",
      description: "Return an ordered verified request/data-flow subgraph from an entry symbol or file hint.",
      inputSchema: TraceRequestFlowInput
    },
    {
      name: "review_diff",
      description: "Review changed files or a unified diff for risk and related tests.",
      inputSchema: ReviewDiffInput
    }
  ];
}

export async function callTool(engine: ContextEngine, name: ToolName, rawInput: unknown): Promise<unknown> {
  switch (name) {
    case "index_repo": {
      const input = IndexRepoInput.parse(rawInput);
      return engine.indexRepo(input.repoRoot);
    }
    case "refresh_index": {
      const input = RefreshIndexInput.parse(rawInput);
      return engine.refreshIndex(input.repoRoot ?? input.workspace?.root);
    }
    case "index_status": {
      const input = IndexStatusInput.parse(rawInput);
      return engine.indexStatus(input.repoRoot ?? input.workspace?.root);
    }
    case "record_file_events": {
      const input = RecordFileEventsInput.parse(rawInput);
      return engine.recordFileEvents(input.repoRoot ?? input.workspace?.root, input.filePaths, {
        burstThreshold: input.burstThreshold,
        maxDirtyFiles: input.maxDirtyFiles
      });
    }
    case "search_code": {
      const input = SearchCodeInput.parse(rawInput);
      return engine.searchCode(input);
    }
    case "get_context": {
      const input = GetContextInput.parse(rawInput);
      return engine.getContext(input);
    }
    case "topology_map": {
      const input = TopologyMapInput.parse(rawInput);
      return engine.topologyMap(input);
    }
    case "find_symbol": {
      const input = FindSymbolInput.parse(rawInput);
      return engine.findSymbol(input.repoRoot ?? input.workspace?.root, input.name);
    }
    case "explain_file": {
      const input = ExplainFileInput.parse(rawInput);
      return engine.explainFile(input.repoRoot ?? input.workspace?.root, input.filePath);
    }
    case "expand_node": {
      const input = ExpandNodeInput.parse(rawInput);
      const parsed = parseNodeRef(input.nodeRef);
      const indexedFile = await engine.explainFile(input.repoRoot ?? input.workspace?.root, parsed.filePath);
      return expandNode({
        nodeRef: input.nodeRef,
        chunks: indexedFile.chunks,
        symbols: indexedFile.symbols,
        expansionLevel: input.expansionLevel,
        budgetChars: input.budgetChars
      });
    }
    case "find_owner": {
      const input = FindOwnerInput.parse(rawInput);
      return engine.findOwner(input.repoRoot ?? input.workspace?.root, input.query, input.limit);
    }
    case "find_reuse_candidates": {
      const input = FindReuseCandidatesInput.parse(rawInput);
      return engine.findReuseCandidates(input);
    }
    case "impact_analysis": {
      const input = ImpactAnalysisInput.parse(rawInput);
      return engine.impactAnalysis(input.repoRoot ?? input.workspace?.root, input.target);
    }
    case "explain_impact": {
      const input = ExplainImpactInput.parse(rawInput);
      const subgraph = await engine.verifiedSubgraph({
        repoRoot: input.repoRoot ?? input.workspace?.root,
        workspace: input.workspace,
        query: input.target,
        seed: input.target,
        mode: "impact",
        budgetChars: input.budgetChars,
        maxHops: input.maxHops
      });
      return applyExplainImpactOutputPreset(buildExplainImpactReport(input.target, subgraph), input.preset);
    }
    case "related_tests": {
      const input = RelatedTestsInput.parse(rawInput);
      return engine.relatedTests(input.repoRoot ?? input.workspace?.root, input.target);
    }
    case "trace_flow": {
      const input = TraceFlowInput.parse(rawInput);
      return engine.traceFlow(input.repoRoot ?? input.workspace?.root, input.entry, input.maxSteps);
    }
    case "trace_request_flow": {
      const input = TraceRequestFlowInput.parse(rawInput);
      const subgraph = await engine.verifiedSubgraph({
        repoRoot: input.repoRoot ?? input.workspace?.root,
        workspace: input.workspace,
        query: input.query ?? input.entry,
        seed: input.entry,
        mode: "flow",
        budgetChars: input.budgetChars,
        maxHops: input.maxHops
      });
      return applySubgraphOutputPreset(subgraph, input.preset);
    }
    case "review_diff": {
      const input = ReviewDiffInput.parse(rawInput);
      return engine.reviewDiff(input.repoRoot ?? input.workspace?.root, input.diff, input.changedFiles);
    }
  }
}

function zodToJsonShape(schema: z.ZodType): Record<string, unknown> {
  // Keep this intentionally lightweight for the foundation. The SDK server can
  // later use zod directly; this shape is enough for docs/tests/tool listing.
  return {
    type: "object",
    description: schema.description ?? "See tool input contract in src/mcp/tools.ts"
  };
}
