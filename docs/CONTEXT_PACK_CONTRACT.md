# Context Pack Contract

`get_context` is the central agent-facing compiler. It does not return raw vector hits or a raw list of files. It returns the smallest currently indexed task context pack that can help an agent answer, debug, modify, or review code.

The AI-facing output is:

```text
brief -> freshness -> ownerChain -> topology -> evidence snippets -> missingEvidence -> nextQueries
```

Snippets are evidence. They are not the primary organization of the result.

## Request

```ts
interface ContextRequest {
  repoRoot: string;
  query: string;
  limit?: number;
  mode?: "auto" | "debug" | "feature" | "refactor" | "review" | "explain";
  budgetChars?: number;
  diff?: string;
  changedFiles?: string[];
}
```

## Response

```ts
interface ContextPack {
  query: string;
  repoRoot: string;
  mode: "debug" | "feature" | "refactor" | "review" | "explain";
  answerable: boolean;
  confidence: "low" | "medium" | "high";
  brief: string;
  freshness: FreshnessReport;
  ownerChain: OwnerNode[];
  topology: TopologyEdge[];
  snippets: EvidenceSnippet[];
  relationships: RelationshipEvidence[];
  missingEvidence: string[];
  nextQueries: string[];
  budgetChars: number;
  usedChars: number;
}
```

`ContextSnippet` must not imply that full source is always returned. Large files should be shaped before reaching the AI.

```ts
type ExpansionLevel =
  | "file_card"
  | "skeleton"
  | "focused_body"
  | "full_body";

interface EvidenceSnippet {
  filePath: string;
  startLine: number;
  endLine: number;
  content: string;
  score: number;
  reason: string;
  role: string;
  expansionLevel: ExpansionLevel;
  originalLineCount: number;
  returnedLineCount: number;
  elidedLineCount: number;
}
```

Supporting types:

```ts
interface FreshnessReport {
  projectId: string;
  indexGeneration: number;
  indexedAtMs: number;
  staleFiles: string[];
  pendingFiles: string[];
  indexingFiles: string[];
  skippedFiles: Array<{ filePath: string; reason: string }>;
}

interface OwnerNode {
  filePath: string;
  role: string;
  reason: string;
  score: number;
  symbols: Array<{
    name: string;
    kind: string;
    startLine: number;
    endLine: number;
  }>;
}

interface TopologyEdge {
  from: string;
  to: string;
  edge: string;
  confidence: "low" | "medium" | "high";
  reason: string;
  sourceFile?: string;
  targetFile?: string;
}

type SubgraphOutputPreset = "compact" | "agent_edit" | "debug_trace" | "review_risk";

interface VerifiedCodeSubgraph {
  query: string;
  mode: "impact" | "flow" | "review" | "debug";
  answerable: boolean;
  confidence: "low" | "medium" | "high";
  coverageSummary: CoverageSummary;
  whyTheseFiles: WhyThisFile[];
  nodes: SubgraphNode[];
  edges: VerifiedSubgraphEdge[];
  paths: string[][];
  snippets: EvidenceSnippet[];
  coverage: CoverageSignal[];
  missingEvidence: string[];
  nextQueries: string[];
  budgetChars: number;
  usedChars: number;
}

interface VerifiedSubgraphEdge {
  fromNodeId: string;
  toNodeId: string;
  kind: string;
  confidence: "low" | "medium" | "high";
  source: "ast" | "lsp" | "framework_rule" | "test_import" | "resource_rule" | "event_rule" | "heuristic";
  reason: string;
  sourceFile?: string;
  targetFile?: string;
  line?: number;
  targetName?: string;
  metadata?: {
    framework?: string;
    route?: string;
    requestPath?: string;
    resource?: string;
    model?: string;
    operation?: string;
    resolution?: string;
    dataflowSource?: string;
    dataflowKind?: string;
    producer?: string;
  };
}
```

## Design Rules

- `ownerChain` is ordered by current relevance and should stay short.
- `topology` is ordered flow evidence, not a general graph dump.
- `snippets` must include file path, line range, reason, and score.
- `relationships` must come from structural graph edges, not freeform inference.
- `missingEvidence` is part of the contract; returning uncertainty is better than overclaiming.
- `nextQueries` guides the agent toward follow-up tool calls when the pack is not enough.
- Large files should default to `skeleton`, not `full_body`.
- Core owner files should return focused function bodies when that is enough.
- Snippets should expose how much code was elided.
- Candidate ranking should include graph-distance signals after keyword/vector recall.
- `VerifiedSubgraphEdge.metadata` carries bounded topology facts such as route, request path, ORM resource, operation, resolution, and request-payload source. These fields are evidence metadata, not proof of runtime reachability beyond the resolver boundary.
- `compact` omits snippets and full node details for low-token first-pass reads. `agent_edit` keeps edit-readiness and snippets, `debug_trace` keeps paths/edges/coverage, and `review_risk` keeps non-passing coverage and lower-confidence edge evidence.

## Current Implementation

The current compiler uses keyword + semantic retrieval, mode boosts, graph relationship evidence, and a character budget. Search filters out reranked candidates with non-positive final score before returning results. Future implementations can replace stores and rankers without changing this contract.

Framework and dataflow topology are intentionally bounded:

- Next.js app/pages API routes, Express routes, and Fastify routes can produce `calls_api`, `routes_to`, and `handles_webhook` edges.
- Same-file string constants and fully resolved template literals can produce `framework_dataflow` request-path evidence.
- Unresolved template URLs are not connected to concrete routes.
- Prisma and Drizzle reads/writes can produce `reads_from` and `writes_to` resource edges.
- ORM write calls that directly use `req.body`, `req.params`, `req.query`, `req.json()`, or a same-file binding derived from those sources can be marked `orm_dataflow` with `dataflowKind: "request_payload"`.

## Planned Shaping Pipeline

```text
keyword/vector recall
  -> graph-distance reranking
  -> owner-chain selection
  -> topology path construction
  -> expansion policy
  -> skeleton/focused-body rendering
  -> budget packing
```

## Field Ownership

```text
WorkspaceResolver      -> freshness.projectId and active scope
IndexState             -> freshness
QueryPlanner           -> mode and brief
HybridRetriever        -> candidate hits
GraphReranker          -> ownerChain ordering
TopologyBuilder        -> topology
Skeletonizer           -> snippets expansionLevel and elision stats
ContextBuilder         -> final budget packing and nextQueries
```
