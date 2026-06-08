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

## Current Implementation

The current compiler uses keyword + deterministic vector retrieval, mode boosts, graph relationship evidence, and a character budget. Future implementations can replace stores and rankers without changing this contract.

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
