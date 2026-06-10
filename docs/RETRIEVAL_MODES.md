# Retrieval Modes

RagCode should not retrieve the same context for every task. The context compiler resolves a mode from the explicit request or query wording.

## Modes

### `debug`

Prioritize error handlers, logs, thrown exceptions, trace-related code, owner chains, and tests.

Expected tools:

- `get_context`
- `find_owner`
- `related_tests`
- `trace_flow`

### `feature`

Prioritize entry points, routes, handlers, UI components, services, stores, API boundaries, and tests.

Expected tools:

- `get_context`
- `find_owner`
- `trace_flow`
- `related_tests`

### `refactor`

Prioritize public symbols, exports, callers, dependency edges, and impact radius.

Expected tools:

- `find_symbol`
- `impact_analysis`
- `trace_flow`

### `review`

Prioritize changed files, test coverage, impact radius, and regression risk.

Expected tools:

- `review_diff`
- `impact_analysis`
- `related_tests`

### `explain`

Prioritize overview files, module entry points, exported symbols, and main execution paths.

Expected tools:

- `get_context`
- `explain_file`
- `trace_flow`

## Scoring

The current ranker fuses keyword and semantic hits, then applies mode-specific boosts and graph reranking. Candidates with a non-positive final score are filtered before output, so semantic nearest neighbors that were demoted to zero do not appear as usable evidence.

Structural graph evidence should improve ranking without hiding raw evidence. For route/data-flow questions, framework and ORM metadata may appear in subgraph edge `metadata` so callers can distinguish static route links, bounded string/dataflow links, and ORM request-payload write evidence.
