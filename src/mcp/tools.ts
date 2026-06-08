import { z } from "zod";
import type { ContextEngine } from "../core/contracts.js";

export const ToolNameSchema = z.enum([
  "index_repo",
  "refresh_index",
  "index_status",
  "search_code",
  "get_context",
  "topology_map",
  "find_symbol",
  "explain_file",
  "find_owner",
  "impact_analysis",
  "related_tests",
  "trace_flow",
  "review_diff"
]);
export type ToolName = z.infer<typeof ToolNameSchema>;

export const IndexRepoInput = z.object({ repoRoot: z.string().min(1) });
export const ContextModeSchema = z.enum(["auto", "debug", "feature", "refactor", "review", "explain"]);
export const WorkspaceHintInput = z.object({ root: z.string().min(1).optional(), filePath: z.string().min(1).optional() }).optional();
export const RefreshIndexInput = z.object({ repoRoot: z.string().min(1).optional(), workspace: WorkspaceHintInput });
export const IndexStatusInput = z.object({ repoRoot: z.string().min(1).optional(), workspace: WorkspaceHintInput });
export const SearchCodeInput = z.object({ repoRoot: z.string().min(1).optional(), workspace: WorkspaceHintInput, query: z.string().min(1), limit: z.number().int().positive().optional(), mode: ContextModeSchema.optional() });
export const GetContextInput = SearchCodeInput.extend({ budgetChars: z.number().int().positive().optional() });
export const TopologyMapInput = SearchCodeInput.extend({ budgetChars: z.number().int().positive().optional(), maxEdges: z.number().int().positive().optional() });
export const FindSymbolInput = z.object({ repoRoot: z.string().min(1).optional(), workspace: WorkspaceHintInput, name: z.string().min(1) });
export const ExplainFileInput = z.object({ repoRoot: z.string().min(1).optional(), workspace: WorkspaceHintInput, filePath: z.string().min(1) });
export const FindOwnerInput = z.object({ repoRoot: z.string().min(1).optional(), workspace: WorkspaceHintInput, query: z.string().min(1), limit: z.number().int().positive().optional() });
export const ImpactAnalysisInput = z.object({ repoRoot: z.string().min(1).optional(), workspace: WorkspaceHintInput, target: z.string().min(1) });
export const RelatedTestsInput = ImpactAnalysisInput;
export const TraceFlowInput = z.object({ repoRoot: z.string().min(1).optional(), workspace: WorkspaceHintInput, entry: z.string().min(1), maxSteps: z.number().int().positive().optional() });
export const ReviewDiffInput = z.object({ repoRoot: z.string().min(1).optional(), workspace: WorkspaceHintInput, diff: z.string().optional(), changedFiles: z.array(z.string()).optional() });

export interface McpToolDefinition {
  name: ToolName;
  description: string;
  inputSchema: Record<string, unknown>;
}

export function listToolDefinitions(): McpToolDefinition[] {
  return [
    {
      name: "index_repo",
      description: "Index or re-index a local repository into the structural graph and semantic store.",
      inputSchema: zodToJsonShape(IndexRepoInput)
    },
    {
      name: "refresh_index",
      description: "Force refresh the active indexed repository. Currently performs a full reindex; future versions can narrow to changed files.",
      inputSchema: zodToJsonShape(RefreshIndexInput)
    },
    {
      name: "index_status",
      description: "Report indexed file/chunk/symbol/edge counts plus freshness, stale, pending, and skipped file state for the active repository.",
      inputSchema: zodToJsonShape(IndexStatusInput)
    },
    {
      name: "search_code",
      description: "Run hybrid code search over keyword and semantic indexes.",
      inputSchema: zodToJsonShape(SearchCodeInput)
    },
    {
      name: "get_context",
      description: "Build an agent-ready context pack for a code question under a character budget.",
      inputSchema: zodToJsonShape(GetContextInput)
    },
    {
      name: "topology_map",
      description: "Return owner-chain and topology edges for a feature/domain query without full evidence snippets.",
      inputSchema: zodToJsonShape(TopologyMapInput)
    },
    {
      name: "find_symbol",
      description: "Find indexed symbols by name.",
      inputSchema: zodToJsonShape(FindSymbolInput)
    },
    {
      name: "explain_file",
      description: "Return indexed file metadata, chunks, and symbols for a file.",
      inputSchema: zodToJsonShape(ExplainFileInput)
    },
    {
      name: "find_owner",
      description: "Find likely owner files and symbols for a feature, bug, or architecture question.",
      inputSchema: zodToJsonShape(FindOwnerInput)
    },
    {
      name: "impact_analysis",
      description: "Estimate direct structural impact for a file or symbol using graph edges.",
      inputSchema: zodToJsonShape(ImpactAnalysisInput)
    },
    {
      name: "related_tests",
      description: "Find likely related test files for a file or symbol target.",
      inputSchema: zodToJsonShape(RelatedTestsInput)
    },
    {
      name: "trace_flow",
      description: "Trace outgoing call edges from an entry symbol or file hint.",
      inputSchema: zodToJsonShape(TraceFlowInput)
    },
    {
      name: "review_diff",
      description: "Review changed files or a unified diff for risk and related tests.",
      inputSchema: zodToJsonShape(ReviewDiffInput)
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
    case "find_owner": {
      const input = FindOwnerInput.parse(rawInput);
      return engine.findOwner(input.repoRoot ?? input.workspace?.root, input.query, input.limit);
    }
    case "impact_analysis": {
      const input = ImpactAnalysisInput.parse(rawInput);
      return engine.impactAnalysis(input.repoRoot ?? input.workspace?.root, input.target);
    }
    case "related_tests": {
      const input = RelatedTestsInput.parse(rawInput);
      return engine.relatedTests(input.repoRoot ?? input.workspace?.root, input.target);
    }
    case "trace_flow": {
      const input = TraceFlowInput.parse(rawInput);
      return engine.traceFlow(input.repoRoot ?? input.workspace?.root, input.entry, input.maxSteps);
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
