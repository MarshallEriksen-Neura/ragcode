# Performance Evaluator: plan-graph-reranking

## Objective
Implement PLAN_STABILITY_AND_TOPOLOGY Phase 8 graph-based reranking with topology distance, ranking signals, project-scoped traversal, and regression tests

## Evaluator Command
```sh
bun run check && bun run test && bun run build
```

## Pass/Fail Contract
PASS when tests prove direct callers/callees/framework-adjacent results outrank disconnected semantic/text matches, review/debug promotes related tests while feature/explain demotes them unless explicit, ranking reasons expose graph signals, and check/test/build pass

This evaluator must exist and produce concrete pass/fail evidence before the performance goal can be completed.
